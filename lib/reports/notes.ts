import type { Db } from "@/lib/db";
import { ACCOUNT_CODES } from "@/lib/coa/template";
import { formatDateLong, formatPeriod, periodBounds } from "@/lib/format";
import { fiscalEndMonth, fiscalSpan, periodFrom } from "@/lib/fiscal";
import { reportPeriods } from "@/lib/reports/periods";
import { formatMoney } from "@/lib/money";
import { balanceSheet, incomeStatement, type FsItem, type Scope } from "@/lib/reports/ledger";
import { fixedAssetMovement, MixedScopeError, otherComprehensiveIncome } from "@/lib/reports/statements";
import { isMixed, scopeEntities } from "@/lib/reports/fx";
import { assetRegister } from "@/lib/assets/register";
import { BUCKETS, BUCKET_LABEL, invoicesAt, subledgerVsLedger } from "@/lib/receivables/aging";
import { ckpn, settingAt } from "@/lib/receivables/ckpn";
import { leaseSchedule, positionAt } from "@/lib/leases/schedule";
import { terms } from "@/lib/leases/register";
import { valuation } from "@/lib/benefits/valuation";
import { glBalance, packApplies, taxPack } from "@/lib/tax/pack";
import { cogsBreakdown } from "@/lib/inventory";
import { scopeFramework, signatoryOf, standardOf, type Framework, type Signatory } from "@/lib/reports/framework";

/**
 * CALK draft and the directors' statement (accounting-rules 1): every figure comes from the same functions as its page — the statements,
 * the registers, the valuation and the tax pack — so a note always equals its statement. The text is a starting point the accountant
 * edits in the downloaded workbook; Buku doesn't store notes.
 */

export type NoteCell = string | bigint | null;
export type NoteTable = { columns: string[]; rows: NoteCell[][]; total?: NoteCell[] };
export type Note = { number: string; title: string; paragraphs: string[]; tables: NoteTable[] };
export type Notes = { title: string; entities: string; asOf: Date; comparativeLabel: string | null; notes: Note[]; directors: string[]; framework: Framework; signatory: Signatory };

/**
 * A part only management can write (the deed, the address, the business, events after the period): printed as *[isi oleh manajemen: …]*,
 * shown in review colour and counted on the CALK tab, so a statement is never sent with a blank nobody noticed.
 */
export const manual = (hint: string) => `[isi oleh manajemen: ${hint}]`;
export const MANUAL_MARK = /\[isi oleh manajemen: [^\]]*\]/g;
export const manualCount = (notes: Pick<Notes, "notes">) => notes.notes.reduce((s, n) => s + n.paragraphs.reduce((t, p) => t + (p.match(MANUAL_MARK)?.length ?? 0), 0), 0);

const EMKM_DEFERRED_REVIEW = "SAK EMKM tidak mengatur pajak tangguhan: tinjau saldo ini bersama kerangka pelaporan entitas.";
const pct = (bp: number) => `${(bp / 100).toLocaleString("id-ID", { maximumFractionDigits: 2 })}%`;

export async function financialNotes(db: Db, scope: Scope, year: number, month: number): Promise<Notes> {
  const entities = await db.entity.findMany({ where: { id: { in: scope.entityIds } }, orderBy: { name: "asc" } });
  if (isMixed(await scopeEntities(db, scope.entityIds))) throw new MixedScopeError();
  const client = await db.client.findUniqueOrThrow({ where: { id: scope.clientId }, select: { name: true } });
  const currency = entities[0]?.functionalCurrency ?? "IDR";
  // The framework changes wording and gates policies the standard does not have — never a figure (framework.ts).
  const framework = scopeFramework(entities);
  const emkm = framework === "SAK_EMKM";
  const signatory = signatoryOf(entities);
  const asOf = periodBounds(year, month).end;
  // The client's financial year (lib/fiscal.ts) and the periods the set reports (lib/reports/periods.ts): the same rule as the page, so a
  // comparative appears only where the books hold data and books opened inside the year count from their Saldo Awal.
  const endMonth = await fiscalEndMonth(db, scope.clientId);
  const per = await reportPeriods(db, scope, year, month, endMonth);
  const { yearStart, booksStart } = per;
  const [bs, bsPrior, is, isPrior, oci] = await Promise.all([
    balanceSheet(db, scope, asOf),
    per.balanceComparative ? balanceSheet(db, scope, per.balanceComparative.date) : null,
    incomeStatement(db, scope, yearStart, asOf),
    per.priorPl ? incomeStatement(db, scope, per.priorPl.start, per.priorPl.end) : null,
    otherComprehensiveIncome(db, scope, yearStart, asOf),
  ]);
  const cur = formatPeriod(year, month);
  const fmtAmount = (v: bigint) => formatMoney(v, currency);
  const bsCols = ["Akun", formatDateLong(asOf), ...(per.balanceComparative ? [per.balanceComparative.label] : [])];
  const plCols = ["Akun", `${periodFrom(per.ytdFrom, asOf, true)} – ${formatDateLong(asOf)}`, ...(per.priorPl ? [`${periodFrom(per.priorPl.start, per.priorPl.end, true)} – ${formatDateLong(per.priorPl.end)}`] : [])];
  const periodText = per.beforeBooks
    ? `posisi keuangan per ${formatDateLong(asOf)}, saldo awal pembukuan`
    : `${periodFrom(booksStart, asOf, true)} – ${formatDateLong(asOf)}`;
  const names = entities.map((e) => e.name).join(", ");
  const notes: Note[] = [];
  let n = 0;
  const add = (title: string, paragraphs: string[] = [], tables: NoteTable[] = []) => {
    const note = { number: String(++n), title, paragraphs, tables };
    notes.push(note);
    return note;
  };

  // 1. Umum
  add("Umum", [
    entities.length > 1
      ? `${names}, entitas-entitas dalam grup ${client.name}, menyajikan laporan keuangan gabungan untuk ${per.beforeBooks ? "" : "periode "}${periodText}.`
      : `${names} ("Entitas") menyajikan laporan keuangan untuk ${per.beforeBooks ? "" : "periode "}${periodText}.`,
    ...entities.filter((e) => e.npwp).map((e) => `${e.name}: NPWP ${e.npwp}.`),
    entities.length > 1
      ? "Laporan gabungan ini adalah pandangan manajemen atas entitas-entitas dalam grup, bukan laporan konsolidasian menurut SAK. Hanya piutang dan utang antar entitas yang saling dihapus; pendapatan dan beban antar entitas serta investasi pada entitas grup dijumlahkan apa adanya."
      : "",
    ...entities.flatMap((e) => {
      const who = entities.length > 1 ? `${e.name} — ` : "";
      return [
        ...(e.kind === "PERORANGAN" ? [] : [`${who}Pendirian: ${manual("nomor dan tanggal akta pendirian dan perubahan terakhirnya, notaris, pengesahan Kemenkumham")}.`]),
        `${who}Alamat: ${manual("alamat kantor sesuai NPWP")}.`,
        `${who}Kegiatan usaha: ${manual("kegiatan usaha utama sesuai anggaran dasar (KBLI)")}.`,
      ];
    }),
  ].filter(Boolean));

  // Going concern: liabilities above assets is disclosed with the plans that support the going-concern basis.
  if (bs.totals.equity < 0n) {
    const deficit = bs.equity.filter((i) => i.fsLine === "SALDO_LABA" || i.fsLine === "LABA_BERJALAN").reduce((s, i) => s + i.amount, 0n);
    add("Kelangsungan usaha", [
      `Per ${formatDateLong(asOf)} liabilitas ${fmtAmount(bs.totals.liabilities)} melebihi aset ${fmtAmount(bs.totals.assets)}, sehingga ekuitas ${fmtAmount(bs.totals.equity)}${deficit < 0n ? ` dengan akumulasi rugi ${fmtAmount(-deficit)}` : ""}. Kondisi ini menimbulkan ketidakpastian atas kemampuan ${entities.length > 1 ? "grup" : "Entitas"} mempertahankan kelangsungan usahanya.`,
      `Rencana manajemen untuk mengatasi kondisi tersebut: ${manual("mis. dukungan pendanaan pemegang saham, penundaan pembayaran utang pihak berelasi, rencana peningkatan pendapatan")}. Laporan keuangan disusun dengan asumsi kelangsungan usaha.`,
    ]);
  }

  // 2. Kebijakan akuntansi — only the policies of what the books contain.
  const has = async (where: Promise<number>) => (await where) > 0;
  const ids = { in: scope.entityIds };
  const [assets, ckpnSet, leases, benefits] = await Promise.all([
    has(db.fixedAsset.count({ where: { entityId: ids } })),
    has(db.ckpnSetting.count({ where: { entityId: ids } })),
    has(db.lease.count({ where: { entityId: ids, cancelEntryId: null } })),
    has(db.benefitSetting.count({ where: { entityId: ids } })),
  ]);
  const stock = bs.currentAssets.some((i) => i.fsLine === "PERSEDIAAN" && i.amount !== 0n) || (await db.inventoryCount.count({ where: { entityId: ids } })) > 0;
  const basis = `Laporan keuangan disusun berdasarkan ${standardOf(framework).named} dengan dasar akrual dan konsep biaya historis, dalam ${currency === "IDR" ? "Rupiah" : currency}.`;
  add("Ikhtisar kebijakan akuntansi", [
    emkm
      ? `Dasar penyusunan. ${basis} Laporan keuangan terdiri dari Laporan Posisi Keuangan, Laporan Laba Rugi dan Catatan atas Laporan Keuangan (CALK). Laporan arus kas dan perubahan ekuitas tidak diwajibkan oleh SAK EMKM; keduanya disajikan sebagai informasi tambahan dari buku yang sama.`
      : `Dasar penyusunan. ${basis} Laporan arus kas disusun dengan metode tidak langsung.`,
    "Kas dan setara kas meliputi kas dan rekening bank yang dapat digunakan tanpa pembatasan.",
    `Piutang usaha dicatat sebesar nilai tagihan${ckpnSet ? (emkm ? "; penyisihan piutang tidak tertagih diakui sebesar estimasi jumlah yang tidak dapat ditagih berdasarkan umur piutang" : "; cadangan kerugian penurunan nilai diukur dengan pendekatan sederhana (kerugian kredit ekspektasian sepanjang umur) memakai matriks provisi dari umur piutang (PSAK 109)") : ""}.`,
    stock ? "Persediaan dinyatakan sebesar nilai terendah antara biaya perolehan dan nilai realisasi neto. Entitas memakai metode periodik: pembelian dibebankan ke beban pokok penjualan dan persediaan akhir ditetapkan dari perhitungan fisik (stock opname) akhir periode." : "",
    assets ? "Aset tetap dicatat sebesar biaya perolehan dikurangi akumulasi penyusutan, disusutkan dengan metode garis lurus selama umur manfaatnya; tanah tidak disusutkan." : "",
    leases && !emkm ? "Sewa. Sebagai penyewa, entitas mengakui aset hak guna dan liabilitas sewa sebesar nilai kini pembayaran sewa yang didiskonto dengan suku bunga pinjaman inkremental; aset hak guna disusutkan garis lurus selama masa sewa, bunga dibebankan dengan metode suku bunga efektif. Sewa jangka pendek (≤ 12 bulan) dibebankan langsung." : "",
    benefits ? `Imbalan kerja. Liabilitas imbalan pascakerja sesuai PP 35/2021 dihitung dengan metode Projected Unit Credit; biaya jasa dan bunga diakui di laba rugi, pengukuran kembali ${emkm ? "dicatat langsung di ekuitas" : "di penghasilan komprehensif lain"}.` : "",
    emkm
      ? "Pajak penghasilan dibebankan sebesar pajak kini yang dihitung dari laba fiskal."
      : "Pajak penghasilan kini dihitung dari laba fiskal; pajak tangguhan diakui atas beda temporer antara nilai tercatat dan dasar pengenaan pajak aset dan liabilitas dengan tarif yang berlaku.",
    "Pendapatan diakui saat barang diserahkan atau jasa diberikan; beban diakui saat terjadi.",
  ].filter(Boolean).map((p, i) => `${String.fromCharCode(97 + i)}. ${p}`));

  // 3+. One note per Neraca line, then per Laba Rugi line: accounts, current vs comparative.
  // Two columns when there is a comparative (cols has three entries), else the current figures alone.
  const lineNote = (label: string, current: FsItem | undefined, prior: FsItem | undefined, cols: string[]) => {
    const withPrior = cols.length > 2;
    const codes = [...new Set([...(current?.accounts ?? []), ...(prior?.accounts ?? [])].map((a) => a.code))];
    const rows = codes.map((code): NoteCell[] => {
      const name = [...(current?.accounts ?? []), ...(prior?.accounts ?? [])].find((x) => x.code === code)?.name ?? "";
      const now = current?.accounts.find((x) => x.code === code)?.amount ?? 0n;
      return withPrior ? [`${code} ${name}`, now, prior?.accounts.find((x) => x.code === code)?.amount ?? 0n] : [`${code} ${name}`, now];
    });
    return add(label, [], [{ columns: cols, rows, total: withPrior ? ["Jumlah", current?.amount ?? 0n, prior?.amount ?? 0n] : ["Jumlah", current?.amount ?? 0n] }]);
  };
  const bsLines = (pick: (b: typeof bs) => FsItem[]) => {
    const old = bsPrior ? pick(bsPrior) : [];
    const keys = [...new Set([...pick(bs), ...old].map((i) => i.fsLine))];
    return keys.map((k) => ({ k, cur: pick(bs).find((i) => i.fsLine === k), old: old.find((i) => i.fsLine === k) }));
  };
  const lineByKey = new Map<string, Note>();
  for (const { k, cur: c, old } of [...bsLines((b) => b.currentAssets), ...bsLines((b) => b.nonCurrentAssets), ...bsLines((b) => b.liabilities), ...bsLines((b) => b.equity)]) {
    if (k === "LABA_BERJALAN") continue;
    lineByKey.set(k, lineNote((c ?? old)!.label.replace(/^./, (x) => x.toUpperCase()), c, old, bsCols));
  }
  const plKeys = (pick: (i: typeof is) => FsItem[]) => {
    const old = isPrior ? pick(isPrior) : [];
    return [...new Set([...pick(is), ...old].map((i) => i.fsLine))].map((k) => ({ k, cur: pick(is).find((i) => i.fsLine === k), old: old.find((i) => i.fsLine === k) }));
  };
  // The Laba Rugi nets other income and other expenses in one section (expenses negative there); a note shows an expense as an expense,
  // positive like every other expense note.
  const positive = (i: FsItem | undefined): FsItem | undefined => (i ? { ...i, amount: -i.amount, accounts: i.accounts.map((a) => ({ ...a, amount: -a.amount })) } : i);
  const otherExpense = new Set<string>(["BEBAN_LAIN", "UNMAPPED_EXPENSE"]); // only ever in `other`, negated (lib/reports/ledger.ts)
  for (const { k, cur: c0, old: o0 } of [...plKeys((i) => i.revenue), ...plKeys((i) => i.cogs), ...plKeys((i) => i.opex), ...plKeys((i) => i.other), ...plKeys((i) => i.tax)]) {
    const [c, old] = otherExpense.has(k) ? [positive(c0), positive(o0)] : [c0, o0];
    lineByKey.set(`PL:${k}`, lineNote((c ?? old)!.label.replace(/^./, (x) => x.toUpperCase()), c, old, plCols));
  }

  // Cost of sales the periodic way (rule 5i): awal + pembelian − akhir, from the same GL lines as the Laba Rugi line it explains.
  const cogsLine = is.cogs.find((i) => i.fsLine === "HPP");
  if (stock && cogsLine) {
    const c = await cogsBreakdown(db, scope.clientId, scope.entityIds, yearStart, asOf);
    const note = lineByKey.get("PL:HPP")!;
    note.paragraphs.push(`Perhitungan beban pokok penjualan ${periodText} (metode periodik).`);
    note.tables.push({
      columns: ["Uraian", "Jumlah"],
      rows: [
        ["Persediaan awal", c.opening],
        ["Pembelian", c.purchases],
        ...(c.direct !== 0n ? [["Pembelian dan penyesuaian yang dicatat langsung ke persediaan", c.direct] as NoteCell[]] : []),
        ["Barang tersedia untuk dijual", c.opening + c.purchases + c.direct],
        ["Persediaan akhir", -c.closing],
      ],
      total: ["Beban pokok penjualan", c.total],
    });
  }

  // Aset tetap: the movement schedule from the GL (PSAK 216's reconciliation of the carrying amount) replaces the two balance notes; the
  // accumulated depreciation is part of it, not a note of its own.
  const movement = await fixedAssetMovement(db, scope, asOf);
  if (movement.rows.length) {
    const accumulated = lineByKey.get("AKUM_PENYUSUTAN");
    if (accumulated) {
      notes.splice(notes.indexOf(accumulated), 1);
      lineByKey.delete("AKUM_PENYUSUTAN");
      notes.forEach((x, i) => (x.number = String(i + 1)));
      n = notes.length;
    }
    const note = lineByKey.get("ASET_TETAP") ?? add("Aset tetap");
    note.title = "Aset tetap";
    const sum = (rows: typeof movement.rows, pick: (r: (typeof movement.rows)[number]) => bigint) => rows.reduce((t, r) => t + pick(r), 0n);
    const line = (r: (typeof movement.rows)[number]): NoteCell[] => [`${r.code} ${r.name}`, r.opening, r.additions, r.deductions, r.closing];
    const cost = movement.rows.filter((r) => r.kind === "COST");
    const acc = movement.rows.filter((r) => r.kind === "ACCUMULATED");
    note.paragraphs = [`Mutasi aset tetap ${formatDateLong(movement.openedAt)} – ${formatDateLong(asOf)}: penambahan harga perolehan adalah pembelian, penambahan akumulasi penyusutan adalah beban penyusutan periode ini; pengurangan adalah pelepasan.`];
    note.tables = [{
      columns: ["Uraian", `Saldo ${formatDateLong(movement.openedAt)}`, "Penambahan", "Pengurangan", `Saldo ${formatDateLong(asOf)}`],
      rows: [
        ...(cost.length ? [["Harga perolehan", null, null, null, null] as NoteCell[], ...cost.map(line)] : []),
        ...(acc.length ? [["Akumulasi penyusutan", null, null, null, null] as NoteCell[], ...acc.map(line)] : []),
      ],
      total: ["Nilai buku", sum(movement.rows, (r) => r.opening), sum(movement.rows, (r) => r.additions), sum(movement.rows, (r) => r.deductions), sum(movement.rows, (r) => r.closing)],
    }];
  }

  // Detail from the registers, attached to their line.
  const reg = await assetRegister(db, scope.clientId, year, month, scope.entityIds);
  const register = reg.filter((r) => r.cost !== 0n);
  if (register.length) {
    const note = lineByKey.get("ASET_TETAP") ?? add("Aset tetap");
    note.paragraphs.push(`Rincian dari daftar aset tetap per ${formatDateLong(asOf)}. Penyusutan tahun berjalan ${formatMoney(register.reduce((t, r) => t + r.bookYtd, 0n), currency)}.`);
    note.tables.push({
      columns: ["Aset", "Harga perolehan", "Akumulasi penyusutan", "Nilai buku"],
      rows: register.map((r) => [`${r.name} (${r.assetAccount.code})`, r.cost, r.accumulated, r.bookValue]),
      total: ["Jumlah", register.reduce((t, r) => t + r.cost, 0n), register.reduce((t, r) => t + r.accumulated, 0n), register.reduce((t, r) => t + r.bookValue, 0n)],
    });
  }
  const items = (await invoicesAt(db, scope.clientId, "SALES", asOf, scope.entityIds)).filter((i) => i.open > 0n);
  if (items.length) {
    const note = lineByKey.get("PIUTANG_USAHA") ?? add("Piutang usaha");
    const by = BUCKETS.map((b) => items.filter((i) => i.bucket === b).reduce((t, i) => t + i.open, 0n));
    note.paragraphs.push(`Umur piutang usaha per ${formatDateLong(asOf)} dari daftar faktur.`);
    // The line nets customers' advances and receipts not yet given to an invoice (the subledger proof): the note ties to it.
    const proofs = await subledgerVsLedger(db, scope.clientId, "SALES", asOf, scope.entityIds);
    const advances = proofs.reduce((t, p) => t + p.advances, 0n);
    const unallocated = proofs.reduce((t, p) => t + p.unallocated, 0n);
    const rows: (string | bigint)[][] = BUCKETS.map((b, i) => [BUCKET_LABEL[b], by[i]]);
    if (advances) rows.push(["Dikurangi uang muka / kelebihan bayar pelanggan", -advances]);
    if (unallocated) rows.push(["Dikurangi penerimaan yang belum dicocokkan ke faktur", -unallocated]);
    note.tables.push({ columns: ["Umur", "Jumlah"], rows, total: ["Jumlah", by.reduce((t, v) => t + v, 0n) - advances - unallocated] });
    for (const e of entities) {
      if (!(await settingAt(db, e.id, year, month))) continue;
      const c = await ckpn(db, scope.clientId, e.id, year, month);
      if (c.total === null) continue;
      const who = entities.length > 1 ? `${e.shortName}: ` : "";
      note.paragraphs.push(
        emkm
          ? `${who}penyisihan piutang tidak tertagih ${formatMoney(c.total, currency)} (dari umur piutang, tarif ${c.setting.method === "ROLL_RATE" ? "dari riwayat pelunasan" : "manual"}).`
          : `${who}cadangan kerugian penurunan nilai piutang ${formatMoney(c.total, currency)} (matriks provisi, metode ${c.setting.method === "ROLL_RATE" ? "roll rate" : "tarif manual"}, faktor forward-looking ${pct(c.setting.forwardBp)}).`,
      );
      note.tables.push({ columns: ["Umur", "Saldo", emkm ? "Tarif penyisihan" : "Tarif kerugian", emkm ? "Penyisihan" : "CKPN"], rows: c.rows.map((r) => [BUCKET_LABEL[r.bucket], r.open, r.rate === null ? "–" : `${(Number(r.rate) / 10_000).toLocaleString("id-ID", { maximumFractionDigits: 2 })}%`, r.amount]), total: ["Jumlah", c.rows.reduce((t, r) => t + r.open, 0n), null, c.total] });
    }
  }
  // Leases: each lease as journalled (months posted by the period end; the liability after the last posted month), then the ledger itself —
  // so the note never shows schedule amounts the Neraca doesn't carry; any difference is named.
  const leaseRows = await db.lease.findMany({ where: { clientId: scope.clientId, entityId: ids, cancelEntryId: null }, include: { postings: { select: { month: true } } }, orderBy: { name: "asc" } });
  const leasePos = leaseRows
    .map((l) => {
      const s = leaseSchedule(terms(l));
      const posted = s.months.filter((m) => l.postings.some((x) => x.month === m.k) && +m.date <= +asOf);
      const last = posted.length ? posted[posted.length - 1] : null;
      const inYear = posted.filter((m) => m.year === year);
      return {
        l,
        started: positionAt(terms(l), s, year, month).started,
        rou: s.rou,
        accumulated: last?.accumulated ?? 0n,
        current: last ? last.current : s.current,
        nonCurrent: last ? last.nonCurrent : s.nonCurrent,
        interest: inYear.reduce((t, m) => t + m.interest, 0n),
        depreciation: inYear.reduce((t, m) => t + m.depreciation, 0n),
      };
    })
    .filter((x) => x.started);
  if (leasePos.length) {
    const gl = async (codes: string[]) => {
      const accounts = await db.account.findMany({ where: { clientId: scope.clientId, code: { in: codes } }, select: { id: true } });
      const a = await db.journalLine.aggregate({ where: { entityId: ids, accountId: { in: accounts.map((x) => x.id) }, date: { lte: asOf } }, _sum: { debit: true, credit: true } });
      return (a._sum.debit ?? 0n) - (a._sum.credit ?? 0n);
    };
    const ledger = { rou: await gl([ACCOUNT_CODES.ROU_ASSET]), accumulated: -(await gl([ACCOUNT_CODES.ROU_ACCUMULATED])), current: -(await gl([ACCOUNT_CODES.LEASE_CURRENT])), nonCurrent: -(await gl([ACCOUNT_CODES.LEASE_NON_CURRENT])) };
    const sum = (k: "rou" | "accumulated" | "current" | "nonCurrent") => leasePos.reduce((t, x) => t + x[k], 0n);
    const differs = (["rou", "accumulated", "current", "nonCurrent"] as const).some((k) => sum(k) !== ledger[k]);
    add("Sewa", [
      emkm
        ? `Aset sewa dan liabilitas sewa per ${formatDateLong(asOf)} dari jurnal sewa yang sudah dicatat. Beban bunga sewa tahun berjalan ${formatMoney(leasePos.reduce((t, x) => t + x.interest, 0n), currency)}; penyusutan aset sewa ${formatMoney(leasePos.reduce((t, x) => t + x.depreciation, 0n), currency)}. SAK EMKM tidak mengatur pengakuan sewa seperti ini; tinjau kerangka pelaporan entitas (SAK EP mengaturnya).`
        : `Aset hak guna dan liabilitas sewa per ${formatDateLong(asOf)} dari jurnal sewa yang sudah dicatat. Beban bunga sewa tahun berjalan ${formatMoney(leasePos.reduce((t, x) => t + x.interest, 0n), currency)}; penyusutan aset hak guna ${formatMoney(leasePos.reduce((t, x) => t + x.depreciation, 0n), currency)}.`,
      ...(differs ? ["Daftar sewa berbeda dengan buku besar: ada jurnal bulanan sewa yang belum dicatat atau pembayaran sewa yang belum diklasifikasikan ke 2170. Neraca memakai angka buku besar."] : []),
    ], [
      {
        columns: ["Sewa", emkm ? "Aset sewa" : "Aset hak guna", "Akumulasi penyusutan", "Liabilitas jangka pendek", "Liabilitas jangka panjang"],
        rows: [...leasePos.map((x): NoteCell[] => [`${x.l.name} · ${x.l.lessor}`, x.rou, x.accumulated, x.current, x.nonCurrent]), ["Jumlah daftar sewa", sum("rou"), sum("accumulated"), sum("current"), sum("nonCurrent")]],
        total: ["Buku besar (1230, 1239, 2170, 2400)", ledger.rou, ledger.accumulated, ledger.current, ledger.nonCurrent],
      },
    ]);
  }
  for (const e of entities) {
    const setting = await db.benefitSetting.findUnique({ where: { entityId: e.id } });
    if (!setting) continue;
    const v = await valuation(db, scope.clientId, e.id, year, month);
    if (v.blocker) continue;
    add(`Liabilitas imbalan kerja${entities.length > 1 ? ` · ${e.shortName}` : ""}`, [
      `Dihitung dengan metode Projected Unit Credit untuk ${v.employees.length} karyawan per ${formatDateLong(asOf)}, manfaat sesuai PP 35/2021. Asumsi: tingkat diskonto ${pct(setting.discountBp)}, kenaikan gaji ${pct(setting.salaryBp)}, usia pensiun normal ${setting.retirementAge} tahun, tabel mortalita ${v.tableName}, tingkat cacat ${pct(setting.disabilityBp)} dari mortalita, pengunduran diri ${pct(setting.resignBp)} sampai usia ${setting.resignFlatUntil} menurun ke 0% pada usia ${setting.resignZeroAge}.`,
    ], [
      { columns: ["Uraian", "Jumlah"], rows: [["Liabilitas imbalan kerja", v.dbo], ["Biaya jasa kini tahun depan", v.serviceCost], ["Biaya bunga tahun depan", v.interestCost], ["Beban imbalan kerja tahun berjalan (6105)", v.expenseTarget]] },
      ...(v.sensitivity ? [{ columns: ["Sensitivitas", "Liabilitas"], rows: [["Diskonto +1%", v.sensitivity.discountUp], ["Diskonto −1%", v.sensitivity.discountDown], ["Kenaikan gaji +1%", v.sensitivity.salaryUp], ["Kenaikan gaji −1%", v.sensitivity.salaryDown]] as NoteCell[][] }] : []),
    ]);
  }
  if (oci.items.length) {
    add(emkm ? "Pos ekuitas lain (pengukuran kembali)" : "Penghasilan komprehensif lain", [emkm ? "Pos yang dicatat langsung di ekuitas, tidak melalui laba rugi." : "Pos yang tidak akan direklasifikasi ke laba rugi."], [{ columns: ["Pos", "Jumlah"], rows: oci.items.map((i) => [i.label, i.amount]), total: ["Jumlah", oci.total] }]);
  }
  // The deferred tax line is what the Neraca carries (1270 − 2320); a computed amount that differs is an estimate not yet journalled.
  const deferredRows = async (entityId: string, computed: bigint | null): Promise<NoteCell[][]> => {
    const posted =
      (await glBalance(db, scope.clientId, entityId, ACCOUNT_CODES.DEFERRED_TAX_ASSET, asOf)) + (await glBalance(db, scope.clientId, entityId, ACCOUNT_CODES.DEFERRED_TAX_LIABILITY, asOf));
    const rows: NoteCell[][] = [];
    if (posted !== 0n) rows.push([posted > 0n ? "Aset pajak tangguhan" : "Liabilitas pajak tangguhan", posted < 0n ? -posted : posted]);
    if (!emkm && computed !== null && computed !== posted) rows.push(["Estimasi pajak tangguhan belum dicatat (catat di Pajak Badan)", computed - posted]);
    return rows;
  };
  for (const e of entities) {
    // The tax pack is calendar-year only: for another tahun buku the note is management's to write (lib/fiscal.ts).
    if (packApplies(e) && endMonth !== 12) {
      const posted = await deferredRows(e.id, null);
      add(`Pajak penghasilan${entities.length > 1 ? ` · ${e.shortName}` : ""}`, [
        manual(`rekonsiliasi laba komersial ke laba fiskal dan PPh badan tahun buku ini; Buku belum menghitung Pajak Badan untuk tahun buku ${fiscalSpan(endMonth)}`),
      ], posted.length ? [{ columns: ["Uraian", "Jumlah"], rows: posted }] : []);
      continue;
    }
    const p = packApplies(e) ? await taxPack(db, scope.clientId, e.id, year, month) : null;
    if (!p || p.regime !== "NORMAL") {
      // No PPh badan reconciliation here (final regime, a person, other books), but a 1270/2320 balance on the Neraca still has its note.
      const posted = await deferredRows(e.id, null);
      if (posted.length) add(`Pajak tangguhan${entities.length > 1 ? ` · ${e.shortName}` : ""}`, ["Saldo pajak tangguhan yang tercatat di buku besar.", ...(emkm ? [EMKM_DEFERRED_REVIEW] : [])], [{ columns: ["Uraian", "Jumlah"], rows: posted }]);
      continue;
    }
    const deferred = await deferredRows(e.id, p.deferred?.amount ?? null);
    // The note computes the tax; the statements carry only what is journaled. Say so while they differ.
    const unbooked = p.proposals.CURRENT.length > 0 && !p.laterPosting.CURRENT;
    // A deferred tax asset needs taxable profit to use it (SAK EP Bab 29, PSAK 212): with a fiscal loss, losses carried forward or a capital
    // deficiency, the estimate is not to be booked as it stands.
    const dta = (p.deferred?.amount ?? 0n) > 0n;
    const ownEquity = entities.length === 1 ? bs.totals.equity : (await balanceSheet(db, { clientId: scope.clientId, entityIds: [e.id] }, asOf)).totals.equity; // this entity's, not the group's
    const doubtful = dta && (p.fiscalProfit < 0n || p.losses.length > 0 || ownEquity < 0n);
    add(`Pajak penghasilan${entities.length > 1 ? ` · ${e.shortName}` : ""}`, [
      `Rekonsiliasi laba komersial ke laba fiskal ${year} s.d. ${cur} (estimasi, bukan SPT).`,
      // A disclosure for the reader, never an instruction to the app's user (the set may be final: the tax is booked at the year end).
      ...(unbooked ? ["Beban pajak penghasilan kini periode ini belum dicatat dalam laporan laba rugi dan laporan posisi keuangan; estimasinya disajikan di bawah."] : []),
      ...(emkm && deferred.length ? [EMKM_DEFERRED_REVIEW] : []),
      ...(doubtful && !emkm ? ["Estimasi aset pajak tangguhan hanya boleh diakui sejauh besar kemungkinan laba fiskal di masa depan cukup untuk memanfaatkannya. Entitas mencatat rugi fiskal, kompensasi kerugian atau defisiensi modal: dokumentasikan dasar pemulihannya sebelum mencatat, atau jangan diakui."] : []),
    ], [
      {
        columns: ["Uraian", "Jumlah"],
        rows: [
          ["Laba sebelum pajak", p.profitBeforeTax],
          ...p.corrections.map((c): NoteCell[] => [`${c.direction === "POSITIVE" ? "(+)" : "(−)"} ${c.label}`, c.direction === "POSITIVE" ? c.amount : -c.amount]),
          ["Laba (rugi) fiskal", p.fiscalProfit],
          ...(p.compensation > 0n ? [["Kompensasi kerugian", -p.compensation] as NoteCell[]] : []),
          ["Penghasilan kena pajak", p.tax.pkp],
          ["Pajak penghasilan kini", p.tax.due],
          ...deferred,
        ],
      },
    ]);
  }

  add("Peristiwa setelah periode pelaporan", [
    manual(`peristiwa penting setelah ${formatDateLong(asOf)} sampai tanggal laporan diotorisasi, atau "Tidak ada peristiwa setelah periode pelaporan yang memerlukan penyesuaian atau pengungkapan."`),
  ]);

  const title = entities.length === 1 ? entities[0].name : client.name;
  return {
    title,
    entities: names,
    asOf,
    comparativeLabel: per.balanceComparative?.label ?? null,
    notes,
    directors: directorsStatement(title, asOf, framework, signatory, entities.every((e) => e.kind === "PERORANGAN")),
    framework,
    signatory,
  };
}

/**
 * The statement of responsibility (a template: the signer's details and the signature are left to fill), for the framework and whoever
 * signs for the entity. The last line is always the signer's role. An individual signs for themselves, not "atas nama" an entity.
 */
export function directorsStatement(entity: string, asOf: Date, framework: Framework = "SAK_EP", signatory: Signatory = signatoryOf([{ kind: "PT" }]), person = false): string[] {
  const blank = "____________________";
  return [
    signatory.title,
    `TENTANG TANGGUNG JAWAB ATAS LAPORAN KEUANGAN ${entity.toUpperCase()}`,
    `UNTUK PERIODE YANG BERAKHIR ${formatDateLong(asOf).toUpperCase()}`,
    "Kami yang bertanda tangan di bawah ini:",
    `Nama: ${blank}    Jabatan: ${signatory.role}`,
    `Alamat kantor: ${blank}`,
    `Alamat domisili sesuai KTP: ${blank}`,
    `Nomor telepon: ${blank}`,
    "menyatakan bahwa:",
    `1. Kami bertanggung jawab atas penyusunan dan penyajian laporan keuangan ${entity};`,
    `2. Laporan keuangan telah disusun dan disajikan sesuai dengan ${standardOf(framework).full};`,
    "3. a. Semua informasi dalam laporan keuangan telah dimuat secara lengkap dan benar;",
    "   b. Laporan keuangan tidak mengandung informasi atau fakta material yang tidak benar, dan tidak menghilangkan informasi atau fakta material;",
    `4. Kami bertanggung jawab atas sistem pengendalian intern dalam ${entity}.`,
    "Demikian pernyataan ini dibuat dengan sebenarnya.",
    `${blank}, ${blank}`,
    ...(person ? [] : [`Atas nama dan mewakili ${entity}`]),
    "Meterai Rp10.000",
    `( ${blank} )`,
    signatory.role,
  ];
}
