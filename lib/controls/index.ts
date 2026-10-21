import type { Db, Tx } from "@/lib/db";
import { sourceSuspenseNet } from "@/lib/controls/suspense-net";
import { ACCOUNT_CODES } from "@/lib/coa/template";
import { formatDate, formatPeriod, periodBounds } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { FxMissingError } from "@/lib/reports/fx";
import { revaluationProposals } from "@/lib/fx/revalue";
import { balanceSheet, combinedWorksheet, trialBalance } from "@/lib/reports/ledger";
import { sanityControls } from "@/lib/controls/sanity";
import { anomalyControls } from "@/lib/controls/anomaly";
import { closeLock, dueProposals, schedulesDueBy } from "@/lib/adjust/schedules";
import { recurringDue, recurringDueBy } from "@/lib/adjust/recurring";
import { closeReopenRequests, pendingJournalCount, pendingLockMessage } from "@/lib/approvals/pending";
import { paidAfterAccrual } from "@/lib/adjust/accruals";
import { registerVsLedger } from "@/lib/assets/register";
import { subledgerVsLedger } from "@/lib/receivables/aging";
import { ckpn, settingAt } from "@/lib/receivables/ckpn";
import { leasesVsLedger } from "@/lib/leases/register";
import { valuation } from "@/lib/benefits/valuation";
import { inventoryRows } from "@/lib/inventory";
import { openingDate, statementCoverage, statementEvidence, sourceCheckpointConflicts } from "@/lib/controls/coverage";
import { packApplies, taxPack } from "@/lib/tax/pack";
import { masaReport, rowNotes, pph25Notes } from "@/lib/tax/masa-report";
import { DIRECTION_LABEL, fakturNotes, fakturRecon } from "@/lib/tax/faktur";
import { bupotNotes, bupotRecon } from "@/lib/tax/bupot";
import { findingLabel } from "@/lib/findings";
import { compareSubledger } from "@/lib/reconcile/subledger";
import { can } from "@/lib/auth/permissions";
import { activeInstructions } from "@/lib/instructions/store";
import { instructionControls } from "@/lib/instructions/controls";
import type { MemberRole } from "@/lib/generated/prisma/enums";

/**
 * Close controls (analog of belifi 16_CONTROLS). PASS / REVIEW / FAIL.
 * REVIEW ≠ bug: it needs a human note to acknowledge. FAIL blocks Tutup Buku.
 */
export type ControlStatus = "PASS" | "REVIEW" | "FAIL";
export type Control = {
  key: string;
  title: string;
  scope: string;
  status: ControlStatus;
  detail: string;
  href?: string;
  ack?: string | null;
  /** A note written for another state of this control (its detail changed since): shown, but it no longer clears the control. */
  staleAck?: string | null;
};

/**
 * Every control of the client for the month. A note clears a REVIEW only while the control still says what it said when the note was
 * written: "2 transaksi menunggu review" acknowledged does not clear "200 transaksi menunggu review".
 */
export async function runControls(db: Db, clientId: string, year: number, month: number): Promise<Control[]> {
  const controls = await collectControls(db, clientId, year, month);
  const acks = await db.controlAck.findMany({ where: { period: { clientId, year, month } }, select: { controlKey: true, detail: true } });
  const detailOf = new Map(acks.map((a) => [a.controlKey, a.detail]));
  for (const c of controls) {
    const stored = detailOf.get(c.key);
    if (c.ack && stored != null && stored !== c.detail) {
      c.staleAck = c.ack;
      c.ack = undefined;
    }
  }
  return controls;
}

async function collectControls(db: Db, clientId: string, year: number, month: number): Promise<Control[]> {
  const { start, end } = periodBounds(year, month);
  const entities = (
    await db.entity.findMany({ where: { clientId }, include: { bankAccounts: { include: { account: true } } }, orderBy: { name: "asc" } })
  ).sort((a, b) => Number(a.kind === "PERORANGAN") - Number(b.kind === "PERORANGAN")); // companies first
  const period = await db.period.findUnique({ where: { clientId_year_month: { clientId, year, month } }, include: { acks: true } });
  const acks = new Map(period?.acks.map((a) => [a.controlKey, a.note]) ?? []);
  const controls: Control[] = [];
  const base = `/clients/${clientId}`;
  const clientScope = entities.length > 1 ? "Grup" : (entities[0]?.shortName ?? "Klien");
  const { industry, fiscalYearEndMonth: yearEnd, firmId } = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { industry: true, fiscalYearEndMonth: true, firmId: true } });
  // The firm's own checks (*Tandai*, accounting-rules 22d): every month that is not locked; a locked month keeps the controls it closed with.
  const flags = period?.status === "LOCKED" ? [] : await activeInstructions(db, firmId, clientId, "FLAG");

  for (const e of entities) {
    const scope = { clientId, entityIds: [e.id] };
    const fmt = (v: bigint) => formatMoney(v, e.functionalCurrency);
    const tb = await trialBalance(db, scope, end);
    const dr = tb.reduce((s, r) => s + r.debit, 0n);
    const cr = tb.reduce((s, r) => s + r.credit, 0n);
    controls.push({
      key: `tb:${e.id}`,
      title: "Neraca saldo seimbang",
      scope: e.shortName,
      status: dr === cr ? "PASS" : "FAIL",
      detail: dr === cr ? `Debit = kredit = ${fmt(dr)}` : `Selisih ${fmt(dr - cr)}`,
      href: `${base}/trial-balance?entity=${e.id}`,
    });
    const bs = await balanceSheet(db, scope, end);
    controls.push({
      key: `bs:${e.id}`,
      title: "Neraca: aset = liabilitas + ekuitas",
      scope: e.shortName,
      status: bs.totals.difference === 0n ? "PASS" : "FAIL",
      detail: bs.totals.difference === 0n ? `Total aset ${fmt(bs.totals.assets)}` : `Selisih ${fmt(bs.totals.difference)}`,
      href: `${base}/reports?entity=${e.id}`,
    });

    // No plug (ADR 0012): a Saldo Awal difference waits on 3290 until a written decision moves it. The GL decides, not the Temuan row,
    // so a resolution reversed later fails again.
    const openingDiff = tb.find((r) => r.account.code === ACCOUNT_CODES.OPENING_DIFFERENCE)?.net ?? 0n;
    if (openingDiff !== 0n) {
      const open = await db.finding.findMany({ where: { entityId: e.id, kind: "OPENING_DIFFERENCE", status: "OPEN" }, orderBy: { number: "asc" }, select: { number: true } });
      controls.push({
        key: `opening-diff:${e.id}`,
        title: "Selisih saldo awal diputuskan",
        scope: e.shortName,
        status: "FAIL",
        detail: `${fmt(openingDiff < 0n ? -openingDiff : openingDiff)} di 3290 Selisih Saldo Awal${open.length ? ` (temuan ${open.map((f) => findingLabel(f.number)).join(", ")})` : ""}. Tulis asal selisihnya dan pilih akunnya di Temuan.`,
        href: `${base}/close?period=${year}-${String(month).padStart(2, "0")}#temuan`,
      });
    }

    // Rekonsiliasi subledger (UC-A1): a client's aging that disagrees with the ledger stays REVIEW until its Temuan is explained.
    const subledger = await db.finding.findMany({ where: { entityId: e.id, kind: "SUBLEDGER_DIFFERENCE", status: "OPEN", date: { lte: periodBounds(year, month).end } }, orderBy: { number: "asc" }, select: { number: true, amount: true, subledgerImport: { select: { id: true } } } });
    if (subledger.length) {
      const sKey = `subledger:${e.id}`;
      // The difference as the ledger stands now (a correcting journal since the import changes it), not the one at import time.
      const now = await Promise.all(subledger.map(async (f) => (f.subledgerImport ? await compareSubledger(db, clientId, f.subledgerImport.id) : null)));
      const parts = subledger.map((f, i) => {
        const c = now[i];
        const d = c ? c.difference : f.amount;
        return `${findingLabel(f.number)} ${c && c.status !== "DIFFERENCE" ? "sekarang cocok, tinggal ditutup" : fmt(d < 0n ? -d : d)}`;
      });
      controls.push({
        key: sKey,
        title: "Rekonsiliasi subledger",
        scope: e.shortName,
        status: "REVIEW",
        detail: `${parts.join(", ")}: aging klien berbeda dengan buku besar. Jelaskan penyebabnya di Piutang & Utang → Rekonsiliasi.`,
        href: `${base}/receivables?tab=rekonsiliasi&entity=${e.id}`,
        ack: acks.get(sKey),
      });
    }

    let statementMissing = false;
    // Books start at the entity's Saldo Awal (else the account's first statement): a month ending before that needs no statement.
    const opening = await openingDate(db, e.id);
    if (!opening) {
      // An entity whose books start in this month without a Saldo Awal: its Neraca starts from zero. Asked once, in the first month.
      // A ledger import brings its own opening rows (the Saldo Awal page offers no form for it): nothing to ask.
      const first = await db.journalEntry.findFirst({ where: { entityId: e.id }, orderBy: { date: "asc" }, select: { date: true } });
      const imported = await db.journalEntry.findFirst({ where: { entityId: e.id, kind: "IMPORTED" }, select: { id: true } });
      if (first && !imported && +first.date >= +start && +first.date <= +end) {
        const oKey = `opening:${e.id}`;
        controls.push({
          key: oKey,
          title: "Saldo awal dicatat",
          scope: e.shortName,
          status: "REVIEW",
          detail: "Belum ada saldo awal: neraca dimulai dari nol. Isi Saldo Awal, atau tulis catatan bila entitas ini memang baru berdiri.",
          href: `${base}/opening`,
          ack: acks.get(oKey),
        });
      }
    }
    for (const ba of e.bankAccounts) {
      const cover = await statementCoverage(db, ba.id, opening, start, end);
      const glRow = tb.find((r) => r.account.id === ba.accountId);
      const gl = glRow?.net ?? 0n;
      const key = `bank:${ba.id}`;
      if (cover.state === "before") {
        controls.push({ key, title: `Rekonsiliasi ${ba.label}`, scope: e.shortName, status: "PASS", detail: `Pembukuan rekening ini mulai ${formatDate(cover.from)}` });
        continue;
      }
      if (cover.state === "missing") {
        statementMissing = true;
        controls.push({ key, title: `Rekonsiliasi ${ba.label}`, scope: e.shortName, status: "REVIEW", detail: "Mutasi bulan ini belum diimpor", href: `${base}/import`, ack: acks.get(key) });
        continue;
      }
      const { coverage } = cover;
      const evidence = statementEvidence(coverage, end, opening);
      const checkpointConflicts = await sourceCheckpointConflicts(db, e.id, ba.accountId, coverage, end, opening);
      evidence.conflict ||= checkpointConflicts.length > 0;
      evidence.messages.push(...checkpointConflicts);
      const { checkpoint } = evidence;
      const verified = cover.state === "covered" && !evidence.uncertain && !!checkpoint && !evidence.conflict;
      const differs = checkpoint && checkpoint.closingBalance !== gl;
      statementMissing ||= !verified;
      controls.push({
        key,
        title: `Rekonsiliasi ${ba.label}`,
        scope: e.shortName,
        status: evidence.conflict || differs ? "FAIL" : verified ? "PASS" : "REVIEW",
        detail: differs ? `Bank ${fmt(checkpoint.closingBalance)} vs buku besar ${fmt(gl)}`
          : evidence.conflict ? "Saldo pada sumber bertentangan; periksa kelengkapan mutasi."
          : verified ? `Saldo bank = buku besar = ${fmt(gl)}`
          : "Cakupan atau saldo sumber belum sepenuhnya terbukti. Periksa rincian kelengkapan mutasi dan bukti saldo.",
        href: `${base}/ledger/${ba.account.code}?entity=${e.id}`,
        ack: acks.get(key),
      });
      const ckey = `cont:${ba.id}`;
      controls.push({
        key: ckey,
        title: `Kelengkapan mutasi ${ba.label}`,
        scope: e.shortName,
        status: evidence.conflict ? "FAIL" : verified ? "PASS" : "REVIEW",
        detail: evidence.messages.join("; ")
          || (verified ? "Saldo berjalan nyambung dan sumber mencakup bulan penuh" : "Periode sumber belum mencakup bulan penuh atau saldo akhir bulan belum tersedia."),
        ack: acks.get(ckey),
      });
    }

    // Books posted before postJournal refused it may still use another entity's bank account (its reconciliation can't see them).
    const foreignLines = await db.journalLine.groupBy({
      by: ["accountId"],
      where: { entityId: e.id, date: { lte: end }, account: { isBank: true, bankAccounts: { some: { entityId: { not: e.id } } } } },
      _sum: { debit: true, credit: true },
    });
    const foreignBank = foreignLines.filter((l) => (l._sum.debit ?? 0n) !== (l._sum.credit ?? 0n));
    if (foreignBank.length) {
      const bkKey = `bank-entity:${e.id}`;
      const accs = await db.account.findMany({ where: { id: { in: foreignBank.map((l) => l.accountId) } }, orderBy: { code: "asc" } });
      const names = accs.map((a) => `${a.code} ${a.name}`).join(", ");
      const held = foreignBank.reduce((s, l) => s + (l._sum.debit ?? 0n) - (l._sum.credit ?? 0n), 0n);
      controls.push({
        key: bkKey,
        title: "Rekening bank entitas lain",
        scope: e.shortName,
        status: "REVIEW",
        detail: `Buku ${e.shortName} menyimpan saldo ${fmt(held)} di ${names}. Kosongkan dengan Jurnal Penyesuaian di buku ini (Buku menerima jurnal yang mengembalikan saldonya ke nol), lalu catat lewat 1190 di buku masing-masing.`,
        href: `${base}/ledger/${accs[0].code}?entity=${e.id}`,
        ack: acks.get(bkKey),
      });
    }

    const clearing = tb.find((r) => r.account.code === ACCOUNT_CODES.CLEARING)?.net ?? 0n;
    const clKey = `clearing:${e.id}`;
    controls.push({
      key: clKey,
      title: "Kliring transfer (1199) = 0",
      scope: e.shortName,
      status: clearing === 0n ? "PASS" : "REVIEW",
      detail: clearing === 0n ? "Semua transfer antar rekening berpasangan" : `Sisa ${fmt(clearing)}. Ada transfer yang pasangannya belum diimpor`,
      href: `${base}/ledger/${ACCOUNT_CODES.CLEARING}?entity=${e.id}`,
      ack: acks.get(clKey),
    });

    const sane = [
      ...(await sanityControls(db, { clientId, entity: e, industry, bsTotals: bs.totals, tb, start, end, base, acks, statementMissing })),
      ...(await anomalyControls(db, { clientId, entity: e, year, month, base, acks })),
    ];
    controls.push(
      ...(sane.length
        ? sane
        : [{ key: `sanity:${e.id}`, title: "Kewajaran pembukuan", scope: e.shortName, status: "PASS" as const, detail: "Tidak ada saldo janggal, pembiayaan di Laba Rugi, bulan kosong, tebakan yang diterima begitu saja, fluktuasi atau jurnal ganda" }]),
    );
    if (flags.length) controls.push(...(await instructionControls(db, { flags, entity: e, start, end, acks })));

    // Adjustment schedules (rule 5a) and Jurnal berulang: an instalment of this month not yet posted needs the click (or the template's
    // stop) or a note. One waiting for a second approver is asked, not due: the lock waits for its decision instead.
    const due = [
      ...(await dueProposals(db, clientId, year, month, e.id)).map((p) => ({ memo: p.memo, amount: p.installment.amount })),
      ...(await recurringDue(db, clientId, year, month, e.id)).filter((d) => !d.waitingId).map((d) => ({ memo: `${d.template.memo} (${formatPeriod(d.year, d.month)})`, amount: d.amount })),
    ];
    if (due.length) {
      const sKey = `sched:${e.id}`;
      const list = due.slice(0, 3).map((p) => `${p.memo} ${fmt(p.amount)}`);
      controls.push({
        key: sKey,
        title: "Jurnal terjadwal belum dicatat",
        scope: e.shortName,
        status: "REVIEW",
        detail: `${due.length} angsuran: ${list.join("; ")}${due.length > 3 ? `; +${due.length - 3} lainnya` : ""}`,
        href: `${base}/journals/new?period=${year}-${String(month).padStart(2, "0")}`,
        ack: acks.get(sKey),
      });
    }

    // Usulan akrual (rule 5a): an approved accrual whose counterparty then got a line in the month counts the expense twice. The way out
    // is the accrual's own reversal copied into the month with *Balik otomatis*; a note acknowledges it like any REVIEW, never a FAIL.
    for (const d of await paidAfterAccrual(db, clientId, e.id, year, month)) {
      const aKey = `accrual-paid:${d.proposalId}`;
      const ym = `${year}-${String(month).padStart(2, "0")}`;
      controls.push({
        key: aKey,
        title: "Akrual dan pembayaran di bulan yang sama",
        scope: e.shortName,
        status: "REVIEW",
        detail: `Akrual ${formatDate(d.entry.date)} “${d.entry.memo}” ${fmt(d.entry.amount)} dan ${d.arrival.text} ${formatDate(d.arrival.date)} ${fmt(d.arrival.amount)}: beban ${d.counterparty} tercatat dua kali. Salin jurnal pembalik akrualnya ke ${formatPeriod(year, month)} dengan Balik otomatis, lalu tulis catatan.`,
        href: d.reversalId ? `${base}/journals/new?period=${ym}&salin=${d.reversalId}` : `${base}/journals/new?period=${ym}`,
        ack: acks.get(aKey),
      });
    }

    // Persediaan (rule 5i): an entity with inventory needs the month-end count, and the books must still equal it.
    const [inv] = await inventoryRows(db, clientId, year, month, [e.id]);
    if (inv?.applies) {
      const iKey = `inv:${e.id}`;
      const counted = inv.count;
      const status = counted && counted.amount === inv.book ? "PASS" : "REVIEW";
      controls.push({
        key: iKey,
        title: "Persediaan akhir (stock opname)",
        scope: e.shortName,
        status,
        detail: !counted
          ? `Persediaan akhir ${formatPeriod(year, month)} belum dicatat; saldo buku ${fmt(inv.book)}${inv.previous ? `, terakhir dihitung ${formatPeriod(inv.previous.year, inv.previous.month)}` : ""}`
          : counted.amount === inv.book
            ? `Saldo buku = hasil hitung ${fmt(counted.amount)}`
            : `Saldo buku ${fmt(inv.book)} berbeda dari hasil hitung ${fmt(counted.amount)}; catat ulang hitungannya`,
        href: `${base}/inventory?period=${year}-${String(month).padStart(2, "0")}`,
        ack: status === "REVIEW" ? acks.get(iKey) : undefined,
      });
    }

    // Fixed-asset register (rule 5b): its cost and accumulated depreciation against the GL accounts it uses, for entities with assets.
    const [fa] = await registerVsLedger(db, clientId, year, month, [e.id]);
    if (fa) {
      const faKey = `fa:${e.id}`;
      const diff = [
        fa.register.cost !== fa.ledger.cost ? `Harga perolehan: daftar ${fmt(fa.register.cost)} vs buku besar ${fmt(fa.ledger.cost)} (${fa.assetAccounts.join(", ")})` : "",
        fa.register.accumulated !== fa.ledger.accumulated ? `Akumulasi penyusutan: daftar ${fmt(fa.register.accumulated)} vs buku besar ${fmt(fa.ledger.accumulated)} (${fa.accumulatedAccounts.join(", ")})` : "",
      ].filter(Boolean);
      controls.push({
        key: faKey,
        title: "Daftar aset tetap = buku besar",
        scope: e.shortName,
        status: fa.equal ? "PASS" : "REVIEW",
        detail: fa.equal ? `Harga perolehan ${fmt(fa.register.cost)}, akumulasi penyusutan ${fmt(fa.register.accumulated)}` : `${diff.join("; ")}. Aset yang belum didaftarkan atau jurnal manual di akun aset menjelaskan selisih ini`,
        href: `${base}/assets?period=${year}-${String(month).padStart(2, "0")}&entity=${e.id}`,
        ack: acks.get(faKey),
      });
    }

    // Receivable/payable subledger (rule 5c): open invoices less unmatched cash on their accounts against the GL, for entities with invoices.
    const overpaid: string[] = [];
    for (const direction of ["SALES", "PURCHASE"] as const) {
      const [sub] = await subledgerVsLedger(db, clientId, direction, end, [e.id]);
      if (!sub) continue;
      const sales = direction === "SALES";
      const key = `${sales ? "ar" : "ap"}:${e.id}`;
      const what = sales ? "Piutang" : "Utang";
      const party = sales ? "pelanggan" : "pemasok";
      const parts = [
        `terbuka ${fmt(sub.open)}`,
        sub.advances ? `uang muka ${party} ${fmt(sub.advances)}` : "",
        sub.unallocated ? `belum dialokasikan ${fmt(sub.unallocated)}` : "",
      ].filter(Boolean);
      const proof = `${what} ${parts.join(" − ")}${parts.length > 1 ? ` = ${fmt(sub.subledger)}` : ""}`;
      controls.push({
        key,
        title: sales ? "Piutang usaha = daftar faktur" : "Utang usaha = daftar tagihan",
        scope: e.shortName,
        status: sub.equal && sub.unallocated === 0n ? "PASS" : "REVIEW",
        detail: !sub.equal
          ? `${proof} vs buku besar ${fmt(sub.ledger)} (${sub.accounts.join(", ")}). Jurnal manual di akun itu atau ${sales ? "faktur" : "tagihan"} yang belum dicatat menjelaskan selisih ini`
          : sub.unallocated
            ? `${proof}, sama dengan buku besar (${sub.accounts.join(", ")}); ${sub.unsettledLines} mutasi bank di akun itu belum dialokasikan: cocokkan ke ${sales ? "faktur" : "tagihan"} atau tandai sebagai uang muka ${party}`
            : `${proof} (${sub.accounts.join(", ")})`,
        href: `${base}/receivables?period=${year}-${String(month).padStart(2, "0")}&entity=${e.id}&tab=${sales ? "piutang" : "utang"}`,
        ack: acks.get(key),
      });
      for (const c of sub.contacts) if (c.advance > c.open) overpaid.push(`${c.contact.name} ${fmt(c.advance - c.open)} (${party})`);
    }
    // UC-B5: a contact who paid more than they owe holds a credit; it shows, never silently nets the receivable below zero.
    if (overpaid.length) {
      const oKey = `overpaid:${e.id}`;
      controls.push({
        key: oKey,
        title: "Kelebihan bayar pelanggan / pemasok",
        scope: e.shortName,
        status: "REVIEW",
        detail: `${overpaid.join(", ")}. Bila tidak akan ditagih atau dibayar lagi, reklasifikasi ke uang muka atau utang/piutang lain lewat Jurnal Penyesuaian`,
        href: `${base}/receivables?period=${year}-${String(month).padStart(2, "0")}&entity=${e.id}`,
        ack: acks.get(oKey),
      });
    }

    // CKPN (rule 5e): once the entity has a setting, the allowance (1135) should equal the matrix at the month-end.
    if (await settingAt(db, e.id, year, month)) {
      const c = await ckpn(db, clientId, e.id, year, month);
      const cKey = `ckpn:${e.id}`;
      const d = c.difference;
      controls.push({
        key: cKey,
        title: "CKPN piutang = matriks provisi",
        scope: e.shortName,
        status: d === 0n ? "PASS" : "REVIEW",
        detail:
          c.blocker ?? (d === 0n
            ? `Cadangan kerugian ${fmt(c.balance)} sesuai matriks`
            : `Matriks ${fmt(c.total!)} vs cadangan di buku besar ${fmt(c.balance)}: ${d! > 0n ? "tambah" : "pulihkan"} ${fmt(d! > 0n ? d! : -d!)}${c.later ? ` (sudah dijurnal per ${formatDate(c.later)})` : ""}`),
        href: `${base}/receivables?period=${year}-${String(month).padStart(2, "0")}&entity=${e.id}&tab=piutang`,
        ack: acks.get(cKey),
      });
    }

    // Lease register (rule 5f): monthly journals posted, and 1230 / 1239 / 2170 + 2400 equal to the register.
    const lease = await leasesVsLedger(db, clientId, e.id, year, month);
    if (lease) {
      const lKey = `lease:${e.id}`;
      const r = lease.register;
      const l = lease.ledger;
      const diff = [
        lease.due ? `${lease.due} jurnal bulanan sewa belum dicatat` : "",
        r.rou !== l.rou ? `Aset hak guna: daftar ${fmt(r.rou)} vs buku besar ${fmt(l.rou)} (1230)` : "",
        r.accumulated !== l.accumulated ? `Akumulasi: daftar ${fmt(r.accumulated)} vs buku besar ${fmt(l.accumulated)} (1239)` : "",
        r.liability !== l.liability ? `Liabilitas sewa: daftar ${fmt(r.liability)} vs buku besar ${fmt(l.liability)} (2170 + 2400); pembayaran sewa di rekening koran diklasifikasikan ke 2170?` : "",
      ].filter(Boolean);
      controls.push({
        key: lKey,
        title: "Sewa (PSAK 116) = daftar sewa",
        scope: e.shortName,
        status: lease.equal ? "PASS" : "REVIEW",
        detail: lease.equal ? `Aset hak guna ${fmt(r.rou - r.accumulated)} (neto), liabilitas sewa ${fmt(r.liability)}` : diff.join("; "),
        href: `${base}/leases?period=${year}-${String(month).padStart(2, "0")}&entity=${e.id}`,
        ack: acks.get(lKey),
      });
    }

    // Employee benefits (rule 5g): in the year-end month (December unless the tahun buku ends elsewhere), once the entity has assumptions,
    // 2310 should equal the PSAK 219 obligation.
    if (month === yearEnd && (await db.benefitSetting.findUnique({ where: { entityId: e.id }, select: { id: true } }))) {
      const v = await valuation(db, clientId, e.id, year, month);
      const ebKey = `eb:${e.id}`;
      controls.push({
        key: ebKey,
        title: "Imbalan kerja (PSAK 219) = valuasi",
        scope: e.shortName,
        status: !v.blocker && !v.lines.length ? "PASS" : "REVIEW",
        detail: v.blocker ?? (v.lines.length ? `Liabilitas imbalan kerja ${fmt(v.dbo)} vs buku besar ${fmt(v.ledger.liability)} (2310); jurnal valuasi belum dicatat${v.later ? ` (sudah dijurnal per ${formatDate(v.later)})` : ""}` : `Liabilitas imbalan kerja ${fmt(v.dbo)} sesuai valuasi (${v.employees.length} karyawan)`),
        href: `${base}/benefits?period=${year}-${String(month).padStart(2, "0")}&entity=${e.id}`,
        ack: acks.get(ebKey),
      });
    }

    // Tax pack (rule 5d): in December, a company's PPh badan for the year should be booked. Calendar tahun buku only (lib/fiscal.ts).
    if (month === 12 && yearEnd === 12 && packApplies(e)) {
      const pack = await taxPack(db, clientId, e.id, year, month);
      const final = pack?.regime === "FINAL_UMKM";
      const expense = pack?.proposals.CURRENT.find((l) => l.code === (final ? ACCOUNT_CODES.FINAL_TAX : ACCOUNT_CODES.CURRENT_TAX))?.amount ?? 0n;
      if (pack && pack.proposals.CURRENT.length) {
        const tKey = `tax:${e.id}`;
        controls.push({
          key: tKey,
          title: final ? `PPh final ${year} belum dijurnal` : `PPh badan ${year} belum dijurnal`,
          scope: e.shortName,
          status: "REVIEW",
          // Buku's own proposal, so the accountant (and the AI review) sees the credits leave 1180 and only PPh 29 go to 2146.
          detail: `Estimasi PPh terutang ${fmt(pack.tax.due)}; jurnal pajak kini yang belum dicatat ${expense >= 0n ? "" : "mengurangi beban "}${fmt(expense < 0n ? -expense : expense)}. Usulan Buku: ${pack.proposals.CURRENT.map((l) => `${l.amount >= 0n ? "D" : "K"} ${l.code} ${fmt(l.amount < 0n ? -l.amount : l.amount)}`).join("; ")}`,
          href: `${base}/tax?period=${year}-12&entity=${e.id}`,
          ack: acks.get(tKey),
        });
      }
    }

    // Pajak masa (rule 5j): a company's last masa paid in full by its due date, and the tax accounts holding only what is still owed.
    // Skipped for a company with no tax activity at all, and for a non-Rupiah book (the masa is filed in Rupiah).
    if (e.kind !== "PERORANGAN" && e.functionalCurrency === "IDR") {
      const masa = await masaReport(db, { clientId, entityId: e.id, year, month });
      const active = masa?.rows.filter((r) => r.owed || r.balance || r.previous.owed || r.previous.paid.length || r.previous.late.length) ?? [];
      // PPh 25 (an instalment, not a payable) joins once an instalment is set or one was paid.
      const pph25 = masa?.pph25 ?? null;
      if (masa && (active.length || pph25)) {
        const mKey = `masa:${e.id}`;
        const flagged = [
          ...masa.rows.filter((r) => r.status === "REVIEW").map((r) => `${r.label}: ${rowNotes(r)[0] ?? "periksa saldonya"}`),
          ...(pph25?.status === "REVIEW" ? [`PPh 25: ${pph25Notes(pph25)[0]}`] : []),
        ];
        const pending = [
          ...active.filter((r) => r.previous.state === "BELUM_JATUH_TEMPO").map((r) => ({ label: r.label, due: r.previous.due })),
          ...(pph25?.previous.state === "BELUM_JATUH_TEMPO" ? [{ label: "PPh 25", due: pph25.previous.due }] : []),
        ];
        const prevMasa = masa.rows[0].previous.masa;
        const prev = formatPeriod(prevMasa.year, prevMasa.month);
        const names = [...active.map((r) => r.label), ...(pph25 ? ["PPh 25"] : [])];
        // A masa that ended before the Saldo Awal or imported Neraca is not in Buku: "disetor penuh" would be a claim about months Buku
        // never saw. (An opening dated the masa's last day is that masa's payable and is judged as usual.)
        const first = await db.journalEntry.findFirst({ where: { entityId: e.id, kind: { in: ["OPENING", "IMPORTED"] } }, orderBy: { date: "asc" }, select: { date: true } });
        const paidSeen = active.some((r) => r.previous.paid.length || r.previous.late.length) || !!pph25?.previous.paid.length || !!pph25?.previous.late.length;
        const beforeBooks = !!first && !paidSeen && +periodBounds(prevMasa.year, prevMasa.month).end < +first.date;
        controls.push({
          key: mKey,
          title: "Pajak masa disetor",
          scope: e.shortName,
          status: flagged.length ? "REVIEW" : "PASS",
          detail: flagged.length
            ? flagged.join(" · ")
            : beforeBooks
              ? `Masa ${prev} sebelum pembukuan di Buku (mulai ${formatDate(first!.date)}): setorannya tidak bisa dicek di sini; saldo ${names.join(", ")} dari saldo awal`
              : pending.length
                ? `${pending.map((x) => x.label).join(", ")} masa ${prev} jatuh tempo ${formatDate(pending[0].due)} dan belum disetor penuh; saldo akun pajak sesuai yang terutang`
                : `Masa ${prev} disetor penuh sampai jatuh tempo; saldo ${names.join(", ")} sesuai yang masih terutang`,
          href: `${base}/tax/masa?period=${year}-${String(month).padStart(2, "0")}&entity=${e.id}`,
          ack: acks.get(mKey),
        });
      }
    }

    // Ekualisasi PPN (I5c): only once Coretax faktur of the masa were imported, so a firm that doesn't use it sees nothing new.
    if (e.kind !== "PERORANGAN" && e.functionalCurrency === "IDR") {
      const fr = await fakturRecon(db, { clientId, entityId: e.id, year, month });
      if (fr.any) {
        const fKey = `faktur:${e.id}`;
        const notes = fakturNotes(fr);
        const done = fr.directions.filter((d) => d.status === "MATCH");
        controls.push({
          key: fKey,
          title: "Faktur Coretax = buku",
          scope: e.shortName,
          status: notes.length ? "REVIEW" : "PASS",
          detail: notes.length ? notes.join(" ") : `${done.map((d) => `${DIRECTION_LABEL[d.direction]} ${fmt(d.fakturPpn)}`).join(" dan ")} sama dengan PPN di buku`,
          href: `${base}/tax/masa?period=${year}-${String(month).padStart(2, "0")}&entity=${e.id}#ekualisasi`,
          ack: acks.get(fKey),
        });
      }
      // Bukti potong Unifikasi (I5d): the same, once slips of the masa were imported.
      const br = await bupotRecon(db, { clientId, entityId: e.id, year, month });
      if (br.any) {
        const bKey = `bupot:${e.id}`;
        const notes = bupotNotes(br);
        controls.push({
          key: bKey,
          title: "Bukti potong Coretax = buku",
          scope: e.shortName,
          status: notes.length ? "REVIEW" : "PASS",
          detail: notes.length ? notes.join(" ") : `${br.directions.filter((d) => d.status === "MATCH").reduce((s, d) => s + d.matched.length, 0)} bukti potong sama dengan pemotongan di buku`,
          href: `${base}/tax/masa?period=${year}-${String(month).padStart(2, "0")}&entity=${e.id}#bukti-potong`,
          ack: acks.get(bKey),
        });
      }
    }
  }

  // Ledger / Neraca imports (rule 15a): accepted source differences stay FAIL until 1999 is cleared; REVIEW checks need a note.
  const imports = await db.ledgerImport.findMany({
    where: { clientId, status: "POSTED", periodStart: { lte: end }, periodEnd: { gte: start } },
    include: { checks: true },
    orderBy: { createdAt: "asc" },
  });
  for (const imp of imports) {
    const inPeriod = (d: Date | null) => (d ? +d >= +start && +d <= +end : +imp.periodEnd >= +start && +imp.periodEnd <= +end);
    const checks = imp.checks.filter((c) => c.severity !== "INFO" && inPeriod(c.date));
    const accepted = checks.filter((c) => c.severity === "BLOCK" && c.accepted);
    const reviews = checks.filter((c) => c.severity === "REVIEW");
    let open = 0;
    for (const c of accepted) {
      // Bank lines waiting in Review also sit on 1999; they are the `suspense` control's, not this file's.
      const entityIds = c.entityId ? [c.entityId] : (await db.entity.findMany({ where: { clientId }, select: { id: true } })).map((e) => e.id);
      for (const id of entityIds) if ((await sourceSuspenseNet(db, id, end)) !== 0n) { open++; break; }
    }
    const key = `ledger:${imp.id}`;
    const parts = [
      open ? `${open} selisih dari file sumber masih di 1999, koreksi lewat Usulan jurnal koreksi di Tutup Buku` : accepted.length ? `${accepted.length} selisih sumber sudah dikoreksi` : "",
      reviews.length ? `${reviews.length} temuan perlu dicek` : "",
      imp.roundingTotal ? await roundingNote(db, imp.id, imp.roundingTotal) : "",
    ].filter(Boolean);
    controls.push({
      key,
      title: `Impor ${imp.mode === "NERACA" ? "neraca" : "buku besar"} ${imp.sheetName}`,
      scope: clientScope,
      status: open ? "FAIL" : reviews.length ? "REVIEW" : "PASS",
      detail: parts.join(" · ") || "Tidak ada temuan untuk periode ini",
      href: `${base}/import/ledger/${imp.id}`,
      ack: acks.get(key),
    });
  }

  // FX revaluation (rule 6b): REVIEW until the month-end difference is posted or rates are filled in.
  for (const p of await revaluationProposals(db, clientId, year, month)) {
    const key = `reval:${p.entityId}`;
    const pending = p.lines.reduce((s, l) => s + l.diff, 0n);
    controls.push({
      key,
      title: "Revaluasi kurs saldo valas",
      scope: p.entityName,
      status: p.missingRates.length || p.lines.length ? "REVIEW" : "PASS",
      detail: p.missingRates.length
        ? `Isi ${p.missingRates.join(", ")}`
        : p.lines.length
          ? `${p.lines.length} saldo valas belum dinilai ulang (selisih bersih ${formatMoney(pending, p.functional)} ke 7200)`
          : "Saldo valas sudah dinilai dengan kurs penutup",
      href: p.missingRates.length ? `${base}/rates` : `${base}/close?period=${year}-${String(month).padStart(2, "0")}`,
      ack: acks.get(key),
    });
  }

  const open = await db.bankTransaction.count({ where: { bankAccount: { entity: { clientId } }, status: "NEEDS_REVIEW", date: { lte: end } } });
  controls.push({
    key: "suspense",
    title: "Semua mutasi terklasifikasi (1999)",
    scope: clientScope,
    status: open === 0 ? "PASS" : "REVIEW",
    detail: open === 0 ? "Semua mutasi sudah diklasifikasi" : `${open} transaksi menunggu review`,
    href: `${base}/review`,
    ack: acks.get("suspense"),
  });

  if (entities.length > 1) {
    const ws = await combinedWorksheet(db, clientId, end).catch((e) => {
      if (e instanceof FxMissingError) return e;
      throw e;
    });
    if (ws instanceof FxMissingError) {
      controls.push({
        key: "fx-translation",
        title: "Kurs penjabaran ke Rupiah lengkap",
        scope: "Grup",
        status: "REVIEW",
        detail: ws.missing.map((m) => `${m.entity}: ${m.need}`).join("; "),
        href: `${base}/rates`,
        ack: acks.get("fx-translation"),
      });
      return controls;
    }
    const idr = (v: bigint) => formatMoney(v, ws.translated ? "IDR" : (entities[0]?.functionalCurrency ?? "IDR"));
    const abs = (v: bigint) => (v < 0n ? -v : v);
    // Per pair (a group of three or more): every pair must mirror; one broken pair never hides behind another that offsets it.
    const broken = [...(ws.residual !== 0n ? [`Selisih ${idr(ws.residual)} antar entitas belum cocok`] : []), ...ws.pairs.map((p) => `${p.a}–${p.b} selisih ${idr(abs(p.difference))}`)];
    controls.push({
      key: "intercompany",
      title: "Antar entitas (1190) tereliminasi",
      scope: "Grup",
      status: broken.length ? "REVIEW" : "PASS",
      detail: broken.length ? broken.join("; ") : `Tereliminasi ${idr(ws.matched)}`,
      href: `${base}/reports?entity=combined`,
      ack: acks.get("intercompany"),
    });
    // A group of three or more records balances per counterparty: what still sits on 1190 can't tell which company it is with.
    const perParty = await db.account.count({ where: { clientId, counterpartyEntityId: { not: null } } });
    const generic = perParty ? ws.rows.filter((r) => r.code === ACCOUNT_CODES.INTERCOMPANY) : [];
    const left = ws.entities.flatMap((e, k) => {
      const v = generic.reduce((t, r) => t + r.values[k], 0n);
      return v ? [`${e.shortName} ${idr(v)}`] : [];
    });
    if (left.length) {
      controls.push({
        key: "intercompany-party",
        title: "Saldo 1190 tanpa pihak",
        scope: "Grup",
        status: "REVIEW",
        detail: `${left.join("; ")} di 1190. Pindahkan ke akun antar entitas pihaknya (1190xx) lewat Jurnal Penyesuaian`,
        href: `${base}/ledger/${ACCOUNT_CODES.INTERCOMPANY}`,
        ack: acks.get("intercompany-party"),
      });
    }
  }
  return controls;
}

export const CLOSE_SIGNOFFS = [
  { key: "docs", label: "Bukti pendukung transaksi besar sudah diperiksa" },
  { key: "adjust", label: "Jurnal penyesuaian (penyusutan, akrual) sudah dicatat" },
  { key: "review", label: "Laporan keuangan sudah direview partner" },
] as const;

export class CloseError extends Error {}

export function closeReadiness(controls: Control[], signoffs: string[]) {
  const fails = controls.filter((c) => c.status === "FAIL");
  const unacked = controls.filter((c) => c.status === "REVIEW" && !c.ack);
  const missing = CLOSE_SIGNOFFS.filter((s) => !signoffs.includes(s.key));
  return { ready: fails.length === 0 && unacked.length === 0 && missing.length === 0, fails, unacked, missing };
}

/** The rounding a ledger import posted to 7190, in its entities' currency (a SGD ledger rounds to cents, not to Rupiah). */
async function roundingNote(db: Db, importId: string, total: bigint) {
  const currencies = new Set((await db.journalEntry.findMany({ where: { ledgerImportId: importId }, select: { entity: { select: { functionalCurrency: true } } }, distinct: ["entityId"] })).map((e) => e.entity.functionalCurrency));
  return currencies.size === 1 ? `pembulatan ke 7190 total ${formatMoney(total, [...currencies][0])}` : "pembulatan ke 7190";
}

/**
 * Closing goes in order: the earliest month of the client that is still open and holds entries (other than a Saldo Awal, which is
 * an opening, not a month of activity) before the one being closed. Empty months never block.
 */
export async function earlierOpenMonth(db: Db | Tx, clientId: string, year: number, month: number) {
  return db.period.findFirst({
    where: { clientId, status: "OPEN", OR: [{ year: { lt: year } }, { year, month: { lt: month } }], entries: { some: { kind: { not: "OPENING" } } } },
    orderBy: [{ year: "asc" }, { month: "asc" }],
    select: { year: true, month: true },
  });
}
/** The latest closed month after this one: reopening goes in reverse order of closing. */
export async function laterLockedMonth(db: Db | Tx, clientId: string, year: number, month: number) {
  return db.period.findFirst({
    where: { clientId, status: "LOCKED", OR: [{ year: { gt: year } }, { year, month: { gt: month } }] },
    orderBy: [{ year: "desc" }, { month: "desc" }],
    select: { year: true, month: true },
  });
}
const mustCloseFirst = (p: { year: number; month: number }) => new CloseError(`Tutup buku ${formatPeriod(p.year, p.month)} dulu: bulan sebelumnya yang berisi transaksi harus ditutup lebih dulu.`);

/** Schedules and Jurnal berulang templates with an instalment due by the month (rule 5a). */
const dueBy = async (db: Db | Tx, clientId: string, year: number, month: number) => [...(await schedulesDueBy(db, clientId, year, month)), ...(await recurringDueBy(db, clientId, year, month))];

export async function lockPeriod(db: Db, clientId: string, year: number, month: number, note: string, actorId?: string | null) {
  const before = await earlierOpenMonth(db, clientId, year, month);
  if (before) throw mustCloseFirst(before);
  // A journal waiting for a second approver that would post into this month (Persetujuan kedua): the lock waits for its decision.
  const waiting = await pendingJournalCount(db, clientId, year, month);
  if (waiting) throw new CloseError(pendingLockMessage(waiting));
  // Schedules due by this month known before the controls run: one created meanwhile was never checked, so the lock refuses (rule 5a).
  const known = new Set(await dueBy(db, clientId, year, month));
  const controls = await runControls(db, clientId, year, month);
  const period = await db.period.upsert({
    where: { clientId_year_month: { clientId, year, month } },
    create: { firmId: (await db.client.findUniqueOrThrow({ where: { id: clientId } })).firmId, clientId, year, month },
    update: {},
    include: { signoffs: true },
  });
  const r = closeReadiness(controls, period.signoffs.map((s) => s.key));
  if (!r.ready) {
    const why = [
      r.fails.length ? `${r.fails.length} kontrol gagal` : "",
      r.unacked.length ? `${r.unacked.length} kontrol Perlu dicek belum diberi catatan` : "",
      r.missing.length ? `${r.missing.length} checklist belum dicentang` : "",
    ].filter(Boolean);
    throw new CloseError(`Belum bisa tutup buku: ${why.join(", ")}.`);
  }
  return db.$transaction(async (tx) => {
    await closeLock(tx, clientId);
    const raced = await earlierOpenMonth(tx, clientId, year, month);
    if (raced) throw mustCloseFirst(raced);
    const asked = await pendingJournalCount(tx, clientId, year, month); // a request stored meanwhile (submits take the same lock)
    if (asked) throw new CloseError(pendingLockMessage(asked));
    if ((await dueBy(tx, clientId, year, month)).some((id) => !known.has(id))) {
      throw new CloseError("Jadwal penyesuaian baru yang jatuh tempo sampai bulan ini ditambahkan saat tutup buku berjalan. Muat ulang halaman, periksa kontrolnya, lalu tutup lagi.");
    }
    return tx.period.update({ where: { id: period.id }, data: { status: "LOCKED", lockedAt: new Date(), lockNote: note, lockedById: actorId ?? null } });
  });
}

export const UNLOCK_REASON_MIN = 5;

/**
 * Reopens a closed month: admin only, in reverse order of closing (never under a later closed month), with the reason typed by the
 * admin. The status change and the audit row (`PeriodUnlockLog`) are one transaction, under the same client lock as closing.
 */
export async function unlockPeriod(db: Db, clientId: string, year: number, month: number, actor: { id: string; role: MemberRole }, reason: string) {
  const why = unlockReason(actor, reason);
  return db.$transaction((tx) => unlockPeriodTx(tx, clientId, year, month, actor, why));
}

/** The unlock's own refusals before anything is read: admin only, and a reason of at least 5 characters (returned trimmed). */
export function unlockReason(actor: { role: MemberRole }, reason: string) {
  if (!can(actor.role, "period.unlock")) throw new CloseError("Hanya admin kantor yang dapat membuka kembali periode.");
  const why = reason.trim();
  if (why.length < UNLOCK_REASON_MIN) throw new CloseError(`Tulis alasan membuka kembali periode (min. ${UNLOCK_REASON_MIN} karakter).`);
  return why;
}

/** The month is closed and no later month is (reverse order of closing): the checks a reopen request makes too. Returns the period. */
export async function reopenablePeriod(tx: Tx, clientId: string, year: number, month: number) {
  const period = await tx.period.findUnique({ where: { clientId_year_month: { clientId, year, month } } });
  if (!period || period.status !== "LOCKED") throw new CloseError(`Periode ${formatPeriod(year, month)} belum ditutup.`);
  const later = await laterLockedMonth(tx, clientId, year, month);
  if (later) throw new CloseError(`Buka kembali ${formatPeriod(later.year, later.month)} dulu: bulan setelahnya masih ditutup.`);
  return period;
}

/**
 * The unlock on `tx`, under the client lock: checks, the log row, the sign-offs removed, the month opened. A confirmed reopen request
 * (Persetujuan kedua, lib/approvals/reopen.ts) passes its requester, kept on the log beside the confirming admin; a direct unlock closes
 * any request for the month still waiting ("dibuka langsung").
 */
export async function unlockPeriodTx(tx: Tx, clientId: string, year: number, month: number, actor: { id: string }, why: string, opts: { requestedById?: string } = {}) {
  await closeLock(tx, clientId);
  const period = await reopenablePeriod(tx, clientId, year, month);
  await tx.periodUnlockLog.create({ data: { firmId: period.firmId, clientId, year, month, unlockedById: actor.id, requestedById: opts.requestedById ?? null, reason: why } });
  if (!opts.requestedById) await closeReopenRequests(tx, clientId, year, month, actor.id);
  // A reopened month is changed on purpose: its sign-offs described the books before the change, so they are given again.
  await tx.closeSignoff.deleteMany({ where: { periodId: period.id } });
  return tx.period.update({ where: { id: period.id }, data: { status: "OPEN", lockedAt: null, lockedById: null } });
}
