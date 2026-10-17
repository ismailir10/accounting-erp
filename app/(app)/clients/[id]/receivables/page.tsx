import { prisma } from "@/lib/db";
import { loadClientPage } from "@/lib/client-page";
import type { SearchParams } from "@/lib/scope";
import { formatPeriod, toIsoDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { ScopeBar } from "@/components/app/scope-bar";
import { NextStep, PageHeader } from "@/components/app/page-header";
import { Receivables } from "@/components/app/receivables";
import { receivablesView } from "@/lib/receivables/view";
import { ckpn, ckpnView } from "@/lib/receivables/ckpn";
import { CkpnCard } from "@/components/app/ckpn-card";
import { ReceivablesTabs } from "@/components/app/receivables-tabs";
import { SubledgerRecon, type ReconView } from "@/components/app/subledger-recon";
import { compareSubledger, listSubledgerImports } from "@/lib/reconcile/subledger";
import { formatDate } from "@/lib/format";
import { financialYear, fiscalLabel, periodKeyOf } from "@/lib/fiscal";
import { CHANNEL_SUGGESTIONS, NO_CHANNEL, salesByChannel } from "@/lib/receivables/channels";
import { SalesChannels } from "@/components/app/sales-channels";
import { customerReminders, paymentReminder } from "@/lib/receivables/reminder";

export const metadata = { title: "Piutang & Utang" };

export default async function ReceivablesPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { client, period, scope, periodOptions, entityOptions, sp, base } = await loadClientPage(params, searchParams);
  if (sp.tab === "rekonsiliasi") return <Reconcile client={client} period={period} scope={scope} periodOptions={periodOptions} entityOptions={entityOptions} base={base} />;
  const direction = sp.tab === "utang" ? "PURCHASE" : "SALES";
  const sales = direction === "SALES";
  const entities = client.entities.filter((e) => scope.entityIds.includes(e.id));
  const [view, accounts] = await Promise.all([
    receivablesView(prisma, client.id, direction, period.end, entities),
    prisma.account.findMany({ where: { clientId: client.id }, orderBy: { code: "asc" } }),
  ]);
  // CKPN (PSAK 109) for entities with sales invoices or a saved setting.
  const withSettings = new Set((await prisma.ckpnSetting.findMany({ where: { entityId: { in: entities.map((e) => e.id) } }, select: { entityId: true } })).map((s) => s.entityId));
  const ckpnViews = sales
    ? await Promise.all(
        entities
          .filter((e) => withSettings.has(e.id) || view.invoices.some((i) => i.entityId === e.id))
          .sort((a, b) => Number(a.kind === "PERORANGAN") - Number(b.kind === "PERORANGAN"))
          .map(async (e) => ckpnView(await ckpn(prisma, client.id, e.id, period.year, period.month), e)),
      )
    : [];
  const channels = sales ? await salesByChannel(prisma, client.id, entities, client.fiscalYearEndMonth, period.year, period.month) : [];
  // Pengingat tagihan (cycle 2026-10-17-pengingat-piutang): per company and customer with an overdue invoice on the reminder date.
  const due = sales ? await customerReminders(prisma, client.id, entities.map((e) => e.id), period.end) : null;
  const reminders = due
    ? Object.fromEntries(
        due.customers.flatMap((c) => {
          const e = entities.find((x) => x.id === c.entityId)!;
          const text = paymentReminder({ company: e.name, customer: c.contact.name, asOf: due.asOf, currency: e.functionalCurrency, overdue: c.overdue, advance: c.advance });
          return text ? [[`${c.entityId}:${c.contact.id}`, text] as const] : [];
        }),
      )
    : undefined;
  const closed = sales ? await prisma.period.findFirst({ where: { clientId: client.id, year: period.year, month: period.month, status: "LOCKED" }, select: { id: true } }) : null;
  const overLimit = new Set(view.aging.flatMap((a) => a.rows.filter((r) => r.over).map((r) => r.contactId))).size;
  const label = formatPeriod(period.year, period.month);
  const word = sales ? "piutang" : "utang";
  const mismatch = view.comparison.filter((c) => !c.equal);
  // A line tagged with its contact is allocated: its rest is that contact's advance, not a to-do.
  const loose = view.unsettled.filter((l) => !l.contact);
  const overdue = view.aging.flatMap((a) => (BigInt(a.totals.OVER_90) > 0n ? [`${a.entity} ${formatMoney(BigInt(a.totals.OVER_90), a.currency)}`] : []));
  const pick = (f: (a: (typeof accounts)[number]) => boolean) => accounts.filter(f).map((a) => ({ code: a.code, name: a.name }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Piutang & Utang"
        description={`Daftar ${sales ? "faktur penjualan" : "tagihan pembelian"}, pelunasan dari rekening koran dan umur ${word} per ${label}`}
        actions={<ScopeBar entities={entityOptions} periods={periodOptions} entity={scope.value} period={period.key} />}
      />
      {loose.length ? (
        <NextStep>
          Alokasikan {loose.length} {sales ? "penerimaan" : "pembayaran"} di akun {word}: pilih {sales ? "pelanggannya" : "pemasoknya"} lalu Cocokkan FIFO, atau tandai sebagai uang muka.
        </NextStep>
      ) : mismatch.length ? (
        <NextStep>Daftar {word} {mismatch.map((c) => c.entity).join(", ")} berbeda dengan buku besar. Catat {sales ? "faktur" : "tagihan"} yang belum ada, termasuk rincian saldo awal.</NextStep>
      ) : view.invoices.length ? (
        <NextStep tone="done">
          Daftar {word} per {label} cocok dengan buku besar{overdue.length ? `; lewat 90 hari: ${overdue.join(", ")}` : ""}
          {overLimit ? `; ${overLimit} pelanggan lewat batas kredit` : ""}.
        </NextStep>
      ) : (
        <NextStep>Catat {sales ? "faktur penjualan" : "tagihan pembelian"} klien, atau rincian {word} yang sudah ada di Saldo Awal.</NextStep>
      )}
      <Receivables
        clientId={client.id}
        direction={direction}
        entities={[...entities].sort((a, b) => Number(a.kind === "PERORANGAN") - Number(b.kind === "PERORANGAN")).map((e) => ({ id: e.id, name: e.name, currency: e.functionalCurrency }))}
        {...view}
        accounts={{
          counter: pick((a) => !a.isBank && !a.isSuspense && !a.isClearing && !a.isIntercompany && (sales ? a.type === "PENDAPATAN" : (a.type === "BEBAN" || a.type === "ASET") && a.fsLine !== "PIUTANG_USAHA" && a.taxTag === null)),
          arAp: pick((a) => a.fsLine === (sales ? "PIUTANG_USAHA" : "UTANG_USAHA") && a.normalBalance === (sales ? "DEBIT" : "CREDIT")),
        }}
        defaultDate={toIsoDate(period.end)}
        reminders={reminders}
        reminder={due ? { date: formatDate(due.asOf), monthOpen: !closed, periodKey: period.key } : undefined}
      />
      {channels.length > 0 && (
        <SalesChannels
          clientId={client.id}
          views={channels.map((v) => ({
            currency: v.currency,
            channels: v.channels.map((c) => ({ channel: c.channel, month: c.month.toString(), ytd: c.ytd.toString(), customers: c.customers.map((x) => ({ id: x.id, name: x.name, month: x.month.toString(), ytd: x.ytd.toString() })) })),
            total: { month: v.total.month.toString(), ytd: v.total.ytd.toString() },
          }))}
          monthLabel={label}
          yearLabel={fiscalLabel(financialYear(client.fiscalYearEndMonth, period.year, period.month))}
          suggestions={[...CHANNEL_SUGGESTIONS]}
          noChannel={NO_CHANNEL}
        />
      )}
      {ckpnViews.map((c) => (
        <CkpnCard key={`${c.entityId}:${period.key}`} clientId={client.id} year={period.year} month={period.month} periodKey={period.key} periodLabel={label} view={c} />
      ))}
    </div>
  );
}

type PageData = Awaited<ReturnType<typeof loadClientPage>>;

/** Rekonsiliasi subledger (UC-A1): the client's agings against the ledger, newest date first. */
async function Reconcile({ client, period, scope, periodOptions, entityOptions, base }: Pick<PageData, "client" | "period" | "scope" | "periodOptions" | "entityOptions" | "base">) {
  const entities = client.entities.filter((e) => scope.entityIds.includes(e.id) && e.functionalCurrency === "IDR").sort((a, b) => Number(a.kind === "PERORANGAN") - Number(b.kind === "PERORANGAN"));
  const [imports, accounts] = await Promise.all([listSubledgerImports(prisma, client.id, entities.map((e) => e.id)), prisma.account.findMany({ where: { clientId: client.id }, orderBy: { code: "asc" } })]);
  const comparisons = await Promise.all(imports.map((i) => compareSubledger(prisma, client.id, i.id)));
  const s = (v: bigint) => v.toString();
  const amounts = (xs: { code: string; name: string; balance: bigint }[]) => xs.map((a) => ({ code: a.code, name: a.name, balance: s(a.balance) }));
  const views: ReconView[] = comparisons.map((c) => ({
    importId: c.importId,
    entityId: c.entityId,
    entity: c.entity,
    kind: c.kind,
    asOf: formatDate(c.asOf),
    periodKey: periodKeyOf(c.asOf),
    fileName: c.fileName,
    threshold: s(c.threshold),
    aging: s(c.aging),
    ledger: s(c.ledger),
    difference: s(c.difference),
    percent: c.percent,
    status: c.status,
    accounts: amounts(c.accounts),
    rows: c.rows.map((r) => ({ counterparty: r.counterparty, total: s(r.total), sourceRef: r.sourceRef, rounded: r.rounded })),
    counterparties: c.counterparties?.map((x) => ({ name: x.name, aging: s(x.aging), buku: s(x.buku), difference: s(x.difference), sourceRef: x.sourceRef })) ?? null,
    candidates: {
      cutoff: c.candidates.cutoff.map((x) => ({ date: formatDate(x.date), memo: x.memo, code: x.code, amount: s(x.amount), source: x.source })),
      credits: c.candidates.credits.map((x) => ({ counterparty: x.counterparty, total: s(x.total), sourceRef: x.sourceRef })),
      advances: amounts(c.candidates.advances),
      nonTrade: amounts(c.candidates.nonTrade),
    },
    finding: c.finding,
  }));
  // The accounts an aging can stand for, the trade ones ticked (what the client's aging normally covers).
  const options = (lines: string[], trade: string, normal: "DEBIT" | "CREDIT") =>
    accounts.filter((a) => lines.includes(a.fsLine) && !a.isClearing && !a.isIntercompany).map((a) => ({ code: a.code, name: a.name, checked: a.fsLine === trade && a.normalBalance === normal }));
  const open = views.filter((v) => v.finding?.status === "OPEN");
  return (
    <div className="space-y-6">
      <PageHeader
        title="Piutang & Utang"
        description="Aging dari sistem klien dibandingkan dengan buku besar"
        actions={<ScopeBar entities={entityOptions} periods={periodOptions} entity={scope.value} period={period.key} />}
      />
      {open.length ? (
        <NextStep>Jelaskan {open.length === 1 ? `selisih ${open[0].finding!.label}` : `${open.length} selisih`} di bawah: lihat kandidat penyebabnya, lalu tulis penjelasan. Koreksi, bila perlu, dicatat lewat Jurnal Penyesuaian.</NextStep>
      ) : views.length ? (
        <NextStep tone="done">Semua aging yang diunggah cocok dengan buku besar atau sudah dijelaskan.</NextStep>
      ) : (
        <NextStep>Unggah aging piutang atau utang dari sistem klien per tanggal tutup buku untuk dibandingkan dengan buku besar.</NextStep>
      )}
      <ReceivablesTabs value="rekonsiliasi" />
      <SubledgerRecon
        clientId={client.id}
        base={base}
        entities={entities.map((e) => ({ id: e.id, name: e.name }))}
        accountOptions={{ RECEIVABLE: options(["PIUTANG_USAHA", "PIUTANG_LAIN"], "PIUTANG_USAHA", "DEBIT"), PAYABLE: options(["UTANG_USAHA", "UTANG_LAIN", "UTANG_BANK"], "UTANG_USAHA", "CREDIT") }}
        defaultAsOf={period.end.toISOString().slice(0, 10)}
        views={views}
      />
    </div>
  );
}

