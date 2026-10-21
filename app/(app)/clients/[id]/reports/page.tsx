import { prisma } from "@/lib/db";
import { clientAccountsView, loadClientPage } from "@/lib/client-page";
import { clientAccountsByAccount, type ClientAccountPart } from "@/lib/reports/source";
import { type SearchParams, withParams } from "@/lib/scope";
import { balanceSheet, combinedWorksheet, incomeStatement, type BalanceSheet, type FsItem, type IncomeStatement } from "@/lib/reports/ledger";
import { balanceItems, incomeItems, loadReportFormat, renderFormat, toUnit } from "@/lib/reports/format";
import { cashFlow, equityChanges, otherComprehensiveIncome } from "@/lib/reports/statements";
import { CashFlowTable, EquityTable, NotesView } from "@/components/app/statements";
import { financialNotes, manualCount } from "@/lib/reports/notes";
import { financialYear, periodKeyOf, priorYearEnd, samePeriodLastYear } from "@/lib/fiscal";
import { reportPeriods } from "@/lib/reports/periods";
import { formatDateLong, formatDateTime, formatPeriod, monthName } from "@/lib/format";
import { computedFacts, reportComment } from "@/lib/reports/report-comment";
import { resolveAiConfig } from "@/lib/settings/ai";
import { ManagementNoteCard } from "@/components/app/management-note";
import { reportStatus } from "@/lib/reports/status";
import { ReportStatusBar } from "@/components/app/report-status";
import { scopeFramework, statementNames } from "@/lib/reports/framework";
import { NextStep, PageHeader } from "@/components/app/page-header";
import { ScopeBar } from "@/components/app/scope-bar";
import { FsTable, type FsParts } from "@/components/app/fs-table";
import { Money } from "@/components/app/money";
import { StatusPill } from "@/components/app/status";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UrlTabs } from "@/components/app/url-tabs";
import { currencyNote, FxMissing, withFx } from "@/components/app/fx-missing";
import { FxMissingError } from "@/lib/reports/fx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { buttonVariants } from "@/components/ui/button";
import { Download } from "lucide-react";
import { currencyName, exponentOf } from "@/lib/fx/currency";

const TAB = "h-7 flex-none";

export const metadata = { title: "Laporan Keuangan" };

export default async function ReportsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { client, period, scope, periodOptions, entityOptions, base, scopeLabel, sp, currency, mixed } = await loadClientPage(params, searchParams);
  const s = { clientId: client.id, entityIds: scope.entityIds };
  // The client's financial year (lib/fiscal.ts): 1 January – 31 December unless it closes in another month.
  const fy = financialYear(client.fiscalYearEndMonth, period.year, period.month);
  const yearStart = fy.start;
  const prevEnd = new Date(Date.UTC(period.year, period.month - 1, 0));
  const lastYearEnd = priorYearEnd(client.fiscalYearEndMonth, period.year, period.month);
  const { start: priorFrom, end: priorTo } = samePeriodLastYear(client.fiscalYearEndMonth, period.year, period.month);
  const prevStart = new Date(Date.UTC(period.year, period.month - 2, 1));
  const multi = client.entities.length > 1;
  // Wording follows the entities' reporting framework (framework.ts): SAK EMKM has no other comprehensive income and no required cash flow.
  const framework = scopeFramework(client.entities.filter((e) => scope.entityIds.includes(e.id)));
  const names = statementNames(framework);
  const emkm = framework === "SAK_EMKM";
  const href = (code: string) => withParams(`${base}/ledger/${code}`, { period: period.key, entity: scope.value });
  const tab = typeof sp.tab === "string" ? sp.tab : "pl";
  const combinedNote = `Gabungan adalah pandangan manajemen, bukan konsolidasi menurut SAK (yang berlaku untuk induk–anak). Saldo antar entitas (1190) saling meniadakan bila kedua sisinya sudah tercatat; saldo 1190 yang masih tampil belum ada pasangannya di entitas lain. Hanya saldo 1190 yang dieliminasi: pendapatan dan beban antar entitas (mis. jasa manajemen) serta investasi pada entitas grup tetap dijumlahkan apa adanya.${
    mixed ? " Entitas non-Rupiah dijabarkan: aset & liabilitas dengan kurs penutup, laba rugi dengan kurs rata-rata, ekuitas dengan kurs historis; selisihnya di akun 3900." : ""
  } Laporan manajemen, catatan manajemen dan paket kredit bank dibuat per perusahaan: pilih perusahaannya di atas.`;
  const note = currencyNote(currency, mixed);
  const header = (
    <PageHeader
      title="Laporan Keuangan"
      description={`${scopeLabel} · dari buku besar${note ? ` · ${note}` : ""}`}
      actions={<ScopeBar entities={entityOptions} periods={periodOptions} entity={scope.value} period={period.key} />}
    />
  );
  const data = await withFx(async () => {
    const [isMonth, isYtd, bs] = await Promise.all([
      incomeStatement(prisma, s, period.start, period.end),
      incomeStatement(prisma, s, yearStart, period.end),
      balanceSheet(prisma, s, period.end),
    ]);
    return { isMonth, isYtd, bs };
  });
  // The group's worksheet needs every entity's translation rates; one entity's own statements never wait for another's (rule 11).
  const wsResult = multi ? await withFx(() => combinedWorksheet(prisma, client.id, period.end)) : null;
  const ws = wsResult instanceof FxMissingError ? null : wsResult;
  const wsFx = wsResult instanceof FxMissingError ? wsResult : null;
  if (data instanceof FxMissingError) {
    return (
      <div className="space-y-6">
        {header}
        <FxMissing error={data} base={base} />
      </div>
    );
  }
  const { isMonth, isYtd, bs } = data;
  // Client COA first: for one entity with its own accounts, each Buku account opens into the client accounts behind it.
  const view = await clientAccountsView(scope, sp);
  const q = { period: period.key, entity: scope.value };
  const partsOf = (map: Map<string, ClientAccountPart[]> | null, items: FsItem[]): FsParts | undefined => {
    if (!map) return undefined;
    const out: FsParts = {};
    for (const a of items.flatMap((i) => i.accounts)) {
      const list = map.get(a.code) ?? [];
      if (!list.some((x) => x.sourceAccountId) || a.amount === 0n) continue;
      const net = list.reduce((t, x) => t + x.net, 0n);
      const sign = net === 0n || (a.amount > 0n) === (net > 0n) ? 1n : -1n; // presentation sign of this FS line
      const rows = list.map((x) => ({ key: `${a.code}:${x.sourceAccountId ?? "-"}`, code: x.sourceAccountId ? x.code : "", name: x.name, amount: x.net * sign, href: x.sourceAccountId ? withParams(`${base}/ledger/akun/${x.sourceAccountId}`, q) : undefined }));
      const rest = a.amount - net * sign;
      if (rest !== 0n) rows.push({ key: `${a.code}:rest`, code: "", name: a.code === "3200" ? "Laba (rugi) tahun-tahun sebelumnya" : "Lainnya", amount: rest, href: a.code === "3200" ? withParams(`${base}/reports`, { period: periodKeyOf(lastYearEnd), entity: scope.value, tab: "pl" }) : undefined });
      out[a.code] = rows;
    }
    return out;
  };
  const [bsParts, plParts] = view.available
    ? await Promise.all([clientAccountsByAccount(prisma, scope.value, { to: period.end }), clientAccountsByAccount(prisma, scope.value, { from: period.start, to: period.end })])
    : [null, null];
  const plItems = incomeItems(isMonth);
  const bsItems = balanceItems(bs);
  // Comparison columns may lack a closing rate; the current period must not be blocked by them. Last month, and the previous year end
  // (one column when they are the same date).
  const compare = async (d: Date) => {
    const r = await withFx(() => balanceSheet(prisma, s, d));
    return { label: formatPeriod(d.getUTCFullYear(), d.getUTCMonth() + 1), bs: r instanceof FxMissingError ? null : r };
  };
  // A comparative column only where the books hold something by then (lib/reports/periods.ts, the rule the PDF, Excel and CALK share): no
  // column of dashes before the books start; when the books start inside this year, the Saldo Awal position stands in for the year end.
  const entryBy = async (to: Date, from?: Date) => !!(await prisma.journalLine.findFirst({ where: { entityId: { in: scope.entityIds }, date: { gte: from, lte: to } }, select: { id: true } }));
  const per = await reportPeriods(prisma, s, period.year, period.month, client.fiscalYearEndMonth);
  const booksStart = per.booksStart;
  // A month at or before the Saldo Awal (the Neraca imported per 31 Mei, opened on Mei): no income yet, not "1 Juni – akhir Mei".
  const ytdLabel = per.beforeBooks
    ? `pembukuan di Buku dimulai ${formatDateLong(booksStart)}`
    : `${formatDateLong(booksStart).replace(` ${period.year}`, "")} – akhir ${formatPeriod(period.year, period.month)}`;
  const openingAt = per.openingAt;
  const labelFor = (d: Date) => (openingAt && +d === +openingAt ? `Saldo awal ${formatDateLong(d)}` : undefined);
  const compareDates: { date: Date; label?: string }[] = [];
  if (await entryBy(prevEnd)) compareDates.push({ date: prevEnd, label: labelFor(prevEnd) });
  // The year-end comparative (or the Saldo Awal in its place), unless it is last month's end already shown.
  const yearEnd = per.balanceComparative;
  if (yearEnd && +yearEnd.date !== +prevEnd && +yearEnd.date < +prevEnd) compareDates.push({ date: yearEnd.date, label: labelFor(yearEnd.date) });
  const comparisons = await Promise.all(compareDates.map(async (c) => ({ ...(await compare(c.date)), ...(c.label ? { label: c.label } : {}) })));
  const shown = comparisons.filter((c): c is { label: string; bs: BalanceSheet } => c.bs !== null);
  const missingLabels = comparisons.filter((c) => !c.bs).map((c) => c.label);
  // Laba Rugi: the same months of last year, and other comprehensive income (single-currency scopes).
  const prior = per.priorPl ? await withFx(() => incomeStatement(prisma, s, priorFrom, priorTo)) : null;
  const isPrior = prior instanceof FxMissingError ? null : prior;
  // Last month beside this one (UC-K3): a comparative even when the books start this year.
  const prevMonth = (await entryBy(prevEnd, prevStart)) ? await withFx(() => incomeStatement(prisma, s, prevStart, prevEnd)) : null;
  // Only when last month has income or expense: a month holding just the Saldo Awal would be a column of dashes.
  const isPrev = prevMonth instanceof FxMissingError || !prevMonth || incomeItems(prevMonth).length === 0 ? null : prevMonth;
  // The client's own format (labels, order, headings, subtotals, unit): presentation only, numbers stay the GL's.
  const format = await loadReportFormat(prisma, client.id);
  const status = await reportStatus(prisma, client.id, scope.entityIds, period.year, period.month);
  const unit = `Dinyatakan dalam ${format.unit === "RIBUAN" ? "ribuan " : ""}${currencyName(currency)}`;
  const exponent = exponentOf(currency);
  const [ociMonth, ociPrev, ociYtd, ociPrior] = mixed ? [null, null, null, null] : await Promise.all([otherComprehensiveIncome(prisma, s, period.start, period.end), otherComprehensiveIncome(prisma, s, prevStart, prevEnd), otherComprehensiveIncome(prisma, s, yearStart, period.end), otherComprehensiveIncome(prisma, s, priorFrom, priorTo)]);
  // Columns: this month, last month (when it has entries), year to date, the same months last year (when they have entries).
  type PlColumn = { label: string; is: IncomeStatement; oci: typeof ociMonth };
  const plColumns: PlColumn[] = [
    { label: formatPeriod(period.year, period.month), is: isMonth, oci: ociMonth },
    ...(isPrev ? [{ label: formatPeriod(prevStart.getUTCFullYear(), prevStart.getUTCMonth() + 1), is: isPrev, oci: ociPrev }] : []),
    { label: `S.d. ${monthName(period.month)} ${period.year}`, is: isYtd, oci: ociYtd },
    ...(isPrior ? [{ label: `S.d. ${monthName(period.month)} ${period.year - 1}`, is: isPrior, oci: ociPrior }] : []),
  ];
  const hasOci = !emkm && !!ociMonth && plColumns.some((c) => c.oci && c.oci.items.length);
  const scaled = (items: FsItem[]): FsItem[] => (format.unit === "RUPIAH" ? items : items.map((i) => ({ ...i, amount: toUnit(i.amount, format.unit, exponent), accounts: i.accounts.map((a) => ({ ...a, amount: toUnit(a.amount, format.unit, exponent) })) })));
  const scaledParts = (parts: FsParts | undefined): FsParts | undefined =>
    parts && format.unit !== "RUPIAH" ? Object.fromEntries(Object.entries(parts).map(([k, rows]) => [k, rows.map((r) => ({ ...r, amount: toUnit(r.amount, format.unit, exponent) }))])) : parts;
  const plFormat = renderFormat(format.labaRugi, plColumns.map((c) => incomeItems(c.is)), format.unit, exponent);
  // Total comprehensive income adds the printed lines (the format's net profit and each OCI line), so thousands add up on the page.
  const netKey = format.labaRugi.filter((l) => l.kind === "TOTAL").at(-1)!.key;
  const netShown = plFormat.find((sec) => sec.total?.key === netKey)!.total!.values;
  const plSections = [
    ...plFormat,
    ...(hasOci
      ? [{ title: "Penghasilan komprehensif lain", items: plColumns.map((c) => scaled(c.oci?.items ?? [])), total: { label: "Total penghasilan komprehensif", values: plColumns.map((c, i) => netShown[i] + scaled(c.oci?.items ?? []).reduce((sum, x) => sum + x.amount, 0n)), strong: true } }]
      : []),
  ];
  const bsSections = renderFormat(format.neraca, [bs, ...shown.map((c) => c.bs)].map(balanceItems), format.unit, exponent);
  const [equity, cash, notes] = mixed ? [null, null, null] : await Promise.all([equityChanges(prisma, s, period.end), cashFlow(prisma, s, period.end), financialNotes(prisma, s, period.year, period.month)]);
  const toFill = notes ? manualCount(notes) : 0;
  // Catatan manajemen (I5b): one company at a time, as the management report.
  const mgmtKey = scope.mode !== "combined" ? { clientId: client.id, entityId: scope.value, year: period.year, month: period.month } : null;
  const mgmt = mgmtKey ? await (async () => {
    const facts = await computedFacts(prisma, mgmtKey);
    const note = await reportComment(prisma, mgmtKey, facts);
    const ai = await resolveAiConfig(prisma);
    return {
      ...mgmtKey,
      periodLabel: formatPeriod(period.year, period.month),
      facts,
      note: note ? { text: note.text, source: note.source, approved: `${note.approvedBy ?? "Akuntan"} · ${formatDateTime(note.approvedAt)}`, stale: note.stale } : null,
      aiReady: Boolean(ai.apiKey && ai.model),
    };
  })() : null;
  const wsCurrency = ws?.translated ? "IDR" : (client.entities[0]?.functionalCurrency ?? "IDR");

  return (
    <div className="space-y-6">
      {header}
      <ReportStatusBar status={status} base={base} q={q} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <NextStep>Pilih nama akun untuk menelusuri buku besar sampai baris sumbernya.</NextStep>
        <div className="flex flex-wrap gap-2">
          <a href={withParams(`${base}/reports/export/pdf`, { period: period.key, entity: scope.value })} className={buttonVariants({ variant: "outline", size: "sm" })} download data-testid="fs-download-pdf">
            <Download /> Unduh PDF
          </a>
          <a href={withParams(`${base}/reports/export`, { period: period.key, entity: scope.value })} className={buttonVariants({ variant: "outline", size: "sm" })} download data-testid="fs-download">
            <Download /> Unduh Excel
          </a>
          {scope.mode !== "combined" && (
            <a href={withParams(`${base}/reports/export/management`, { period: period.key, entity: scope.value })} className={buttonVariants({ variant: "outline", size: "sm" })} download data-testid="fs-download-management">
              <Download /> Laporan manajemen
            </a>
          )}
          {scope.mode !== "combined" && client.entities.find((e) => e.id === scope.value)?.functionalCurrency === "IDR" && (
            <a href={withParams(`${base}/reports/export/credit`, { period: period.key, entity: scope.value })} className={buttonVariants({ variant: "outline", size: "sm" })} download data-testid="fs-download-credit">
              <Download /> Paket kredit bank
            </a>
          )}
        </div>
      </div>
      {scope.mode === "combined" && <p className="text-sm text-muted-foreground">{combinedNote}</p>}
      <UrlTabs defaultValue={tab}>
        {/* The tabs wrap on a phone: a strip scrolling sideways hid CALK and Catatan manajemen off-screen (ui-rules 11). */}
        <TabsList className="max-w-full flex-wrap justify-start group-data-horizontal/tabs:h-auto">
          <TabsTrigger className={TAB} value="pl">Laba Rugi</TabsTrigger>
          <TabsTrigger className={TAB} value="bs">Neraca</TabsTrigger>
          <TabsTrigger className={TAB} value="eq">Perubahan Ekuitas</TabsTrigger>
          <TabsTrigger className={TAB} value="cf">Arus Kas</TabsTrigger>
          <TabsTrigger className={TAB} value="notes">CALK{toFill > 0 && <span className="num text-review" data-testid="calk-to-fill">· {toFill} diisi manajemen</span>}</TabsTrigger>
          {multi && <TabsTrigger className={TAB} value="ws">Kertas Kerja Gabungan</TabsTrigger>}
          {mgmt && <TabsTrigger className={TAB} value="mgmt">Catatan manajemen{mgmt.note?.stale ? <span className="text-review">· ditinjau ulang</span> : null}</TabsTrigger>}
        </TabsList>

        {mgmt && (
          <TabsContent value="mgmt">
            <ManagementNoteCard {...mgmt} />
          </TabsContent>
        )}
        <TabsContent value="pl">
          <Card>
            <CardHeader>
              <CardTitle>{names.income}</CardTitle>
              <CardDescription>
                {monthName(period.month)} {period.year}{isPrev ? ` dan bulan sebelumnya` : ""}, {ytdLabel}{isPrior ? `, dibandingkan periode yang sama ${client.fiscalYearEndMonth === 12 ? `tahun ${period.year - 1}` : "tahun buku sebelumnya"}` : ""} · {unit}
                {format.custom ? ` · format laporan klien${format.source ? ` (${format.source})` : ""}` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <FsTable
                accountHref={href}
                currency={currency}
                parts={scaledParts(partsOf(plParts, plItems))}
                columns={plColumns.map((c) => c.label)}
                sections={plSections}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="bs">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Laporan Posisi Keuangan (Neraca)
                <BalancePill bs={bs} findings={status.reasons.flatMap((r) => (r.kind === "findings" ? r.items : []))} />
              </CardTitle>
              <CardDescription>
                Per akhir {formatPeriod(period.year, period.month)}
                {shown.length ? `, dibandingkan ${shown.map((c) => c.label).join(" dan ")}` : ""}
                {missingLabels.length ? `. Pembanding ${missingLabels.join(" dan ")}: isi kurs penutup bulan itu di halaman Kurs.` : ""}
                {` · ${unit}`}
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <FsTable
                accountHref={href}
                currency={currency}
                parts={scaledParts(partsOf(bsParts, bsItems))}
                columns={[formatPeriod(period.year, period.month), ...shown.map((c) => c.label)]}
                sections={bsSections}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="eq">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {names.equity}
                {equity && <StatusPill status={equity.totals.closing === equity.balanceSheetEquity ? "PASS" : "FAIL"} label={equity.totals.closing === equity.balanceSheetEquity ? "Sama dengan Neraca" : "Beda dengan Neraca"} />}
              </CardTitle>
              <CardDescription>{ytdLabel} · {unit}</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              {equity ? <EquityTable data={equity} currency={currency} accountHref={href} framework={framework} /> : <p className="px-6 text-sm text-muted-foreground">Laporan ini hanya untuk cakupan satu mata uang.</p>}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="cf">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {emkm ? "Laporan Arus Kas (informasi tambahan)" : "Laporan Arus Kas"}
                {cash && <StatusPill status={cash.openingCash + cash.joinedCash + cash.net + cash.fxEffect === cash.closingCash ? "PASS" : "FAIL"} label={cash.openingCash + cash.joinedCash + cash.net + cash.fxEffect === cash.closingCash ? "Sama dengan kas di Neraca" : "Beda dengan kas di Neraca"} />}
              </CardTitle>
              <CardDescription>Metode tidak langsung, dari perubahan pos neraca · {ytdLabel} · {unit}</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              {cash ? <CashFlowTable data={cash} currency={currency} accountHref={href} framework={framework} /> : <p className="px-6 text-sm text-muted-foreground">Laporan ini hanya untuk cakupan satu mata uang.</p>}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notes">
          <Card>
            <CardHeader>
              <CardTitle>Catatan atas Laporan Keuangan</CardTitle>
              <CardDescription>
                Draf dari angka laporan dan daftar-daftar di Buku, per akhir {formatPeriod(period.year, period.month)} dengan pembanding. Sunting di file unduhan.
                {toFill > 0 && <> Bagian berwarna (<span className="text-review">{toFill}</span>) diisi manajemen sebelum laporan dikirim.</>}
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              {mixed ? <p className="px-6 text-sm text-muted-foreground">CALK hanya untuk cakupan satu mata uang.</p> : notes && <NotesView data={notes} currency={currency} accountHref={href} />}
            </CardContent>
          </Card>
        </TabsContent>

        {wsFx && (
          <TabsContent value="ws">
            <FxMissing error={wsFx} base={base} compact />
          </TabsContent>
        )}
        {ws && (
          <TabsContent value="ws">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  Kertas Kerja Gabungan
                  <StatusPill status={ws.residual === 0n && !ws.pairs.length ? "PASS" : "REVIEW"} label={ws.residual === 0n && !ws.pairs.length ? "Antar entitas cocok" : "Ada selisih antar entitas"} />
                </CardTitle>
                <CardDescription>{combinedNote} Saldo debit (+) / kredit (−){ws.translated ? ", semua kolom dalam Rupiah" : wsCurrency !== "IDR" ? `, dalam ${wsCurrency}` : ""}.</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto px-0">
                <Table data-testid="worksheet">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="py-2 pl-6 text-left font-medium">Akun</TableHead>
                      {ws.entities.map((e) => <TableHead key={e.id} className="py-2 pr-4 text-right font-medium">{e.shortName}</TableHead>)}
                      <TableHead className="py-2 pr-4 text-right font-medium">Eliminasi</TableHead>
                      <TableHead className="py-2 pr-6 text-right font-medium">Gabungan</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ws.rows.map((r) => (
                      <TableRow key={r.key} className={r.elimination !== 0n ? "bg-primary-subtle/60" : "border-t border-border/60"}>
                        <TableCell className="py-1.5 pl-6"><span className="num text-muted-foreground">{r.code}</span> {r.name}</TableCell>
                        {r.values.map((v, i) => <TableCell key={i} className="py-1.5 pr-4 text-right"><Money value={v} currency={wsCurrency} /></TableCell>)}
                        <TableCell className="py-1.5 pr-4 text-right font-medium text-primary"><Money value={r.elimination} currency={wsCurrency} /></TableCell>
                        <TableCell className="py-1.5 pr-6 text-right font-medium"><Money value={r.combined} currency={wsCurrency} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {ws.residual !== 0n && (
                  <p className="px-6 pt-3 text-sm text-review">
                    Selisih <Money value={ws.residual} currency={wsCurrency} />. Biasanya karena mutasi salah satu entitas belum diimpor.
                  </p>
                )}
                {/* A group of three or more: each pair must mirror (A's account for B against B's account for A). */}
                {ws.pairs.map((p) => (
                  <p key={`${p.a}-${p.b}`} className="px-6 pt-3 text-sm text-review" data-testid="worksheet-pair">
                    {p.a}–{p.b}: selisih <Money value={p.difference < 0n ? -p.difference : p.difference} currency={wsCurrency} />. Saldo {p.a} dengan {p.b} dan saldo {p.b} dengan {p.a} belum saling menutup.
                  </p>
                ))}
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </UrlTabs>
    </div>
  );
}

/**
 * The Neraca's own verdict (use-case feedback #5): "Seimbang" only when A = L + E, total assets aren't negative and no Saldo Awal
 * difference is waiting on 3290. Adding up is not the same as being right.
 */
function BalancePill({ bs, findings }: { bs: BalanceSheet; findings: { labels: string[] }[] }) {
  if (bs.totals.difference !== 0n) return <StatusPill status="FAIL" label="Selisih" />;
  if (bs.totals.assets < 0n) return <StatusPill status="FAIL" label="Seimbang, tapi total aset negatif" />;
  const open = findings.reduce((n, f) => n + f.labels.length, 0);
  // 3290 can hold a balance with no open Temuan (moved there by a later journal): say what is true.
  if (open) return <StatusPill status="REVIEW" label={`Seimbang · ${open} temuan terbuka`} />;
  if (findings.length) return <StatusPill status="REVIEW" label="Seimbang · selisih saldo awal belum diputuskan" />;
  return <StatusPill status="PASS" label="Seimbang" />;
}
