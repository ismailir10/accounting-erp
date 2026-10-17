import Link from "next/link";
import { Download } from "lucide-react";
import { prisma } from "@/lib/db";
import { loadClientPage } from "@/lib/client-page";
import { type SearchParams, withParams } from "@/lib/scope";
import { formatDate, formatPeriod, periodBounds } from "@/lib/format";
import { formatRupiah } from "@/lib/money";
import { packApplies } from "@/lib/tax/pack";
import { masaReport, ppnLine, pph25Notes, pph25StateLabel, previousStateLabel, rowNotes, terNote, terRow, withholdingLabel, type MasaRow, type Pph25, type WithholdingLine } from "@/lib/tax/masa-report";
import { NextStep, PageHeader } from "@/components/app/page-header";
import { FakturRecon } from "@/components/app/faktur-recon";
import { BupotRecon } from "@/components/app/bupot-recon";
import { PpnOffset } from "@/components/app/ppn-offset";
import { Pph25Instalment } from "@/components/app/pph25-instalment";
import { BUPOT_DIRECTION_LABEL, bupotNotes, bupotRecon } from "@/lib/tax/bupot";
import { BUPOT_KIND_LABEL } from "@/lib/tax/bupot-read";
import { withholdingAccountCode } from "@/lib/tax/withholding";
import { PTKP_LABEL } from "@/lib/tax/ter";
import type { WithholdingKind } from "@/lib/generated/prisma/enums";
import { DIRECTION_LABEL, fakturCounterAccounts, fakturNotes, fakturRecon } from "@/lib/tax/faktur";
import { ScopeBar } from "@/components/app/scope-bar";
import { Money } from "@/components/app/money";
import { StatusPill } from "@/components/app/status";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Pajak Masa" };

export default async function TaxMasaPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { client, period, scope, periodOptions, entityOptions, base } = await loadClientPage(params, searchParams, { defaultCombined: false });
  const entity = client.entities.find((e) => e.id === scope.entityIds[0])!;
  const label = formatPeriod(period.year, period.month);
  const companies = entityOptions.filter((o) => { const e = client.entities.find((x) => x.id === o.value); return e && packApplies(e); });
  const header = (
    <PageHeader
      title="Pajak Masa"
      description={`${entity.name} · PPN, PPh 21, PPh 23 dan pemotongan lain masa ${label} (kertas kerja, bukan SPT)`}
      actions={
        <>
          <ScopeBar entities={companies.length ? companies : entityOptions} periods={periodOptions} entity={scope.value} period={period.key} allowCombined={false} />
          {packApplies(entity) && (
            <a href={withParams(`${base}/tax/masa/export`, { period: period.key, entity: entity.id })} className={buttonVariants({ variant: "outline", size: "sm" })} download data-testid="masa-download">
              <Download /> Unduh Excel
            </a>
          )}
        </>
      }
    />
  );
  if (!packApplies(entity)) {
    return (
      <div className="space-y-6">
        {header}
        <NextStep>Pilih badan usaha (PT/CV) dengan pembukuan Rupiah. Pajak masa orang pribadi dan entitas valuta asing belum dihitung di sini.</NextStep>
      </div>
    );
  }
  const report = (await masaReport(prisma, { clientId: client.id, entityId: entity.id, year: period.year, month: period.month }))!;
  const ledger = (code: string) => withParams(`${base}/ledger/${code}`, { entity: entity.id, period: period.key });
  // Problems first (ui-rules 10).
  const rows = [...report.rows].sort((a, b) => (a.status === b.status ? 0 : a.status === "REVIEW" ? -1 : 1));
  const firstProblem = rows.find((r) => r.status === "REVIEW");
  const terReview = (report.ter.state === "CHECKED" || report.ter.state === "ANNUAL") && report.ter.status === "REVIEW";
  const reviewInWht = [...report.withheldByUs, ...report.withheldFromUs].filter((w) => w.inReview).length;
  // Lines still in Review sit on 1999 without their tax: the masa's PPN and PPh are not final until they are decided.
  const { start, end } = periodBounds(period.year, period.month);
  const pending = await prisma.bankTransaction.count({ where: { entityId: entity.id, status: "NEEDS_REVIEW", date: { gte: start, lte: end } } });
  const faktur = await fakturRecon(prisma, { clientId: client.id, entityId: entity.id, year: period.year, month: period.month });
  const fakturGap = fakturNotes(faktur)[0];
  const counterAccounts = fakturCounterAccounts(await prisma.account.findMany({ where: { clientId: client.id }, orderBy: { code: "asc" } }));
  const bupot = await bupotRecon(prisma, { clientId: client.id, entityId: entity.id, year: period.year, month: period.month });
  const bupotGap = bupotNotes(bupot)[0];
  const day = (d: Date) => formatDate(d);
  const offset = report.rows.find((r) => r.key === "PPN")!.ppn!.offset;
  // PPh 25 is a row for every normal-regime company: with no instalment yet it asks for one. Under PP 55 there is none.
  const finalRegime = (await prisma.taxYear.findUnique({ where: { entityId_year: { entityId: entity.id, year: period.year } }, select: { regime: true } }))?.regime === "FINAL_UMKM";
  const pph25Problem = report.pph25?.status === "REVIEW";
  const instalmentList = report.pph25?.instalments ?? (await prisma.taxInstalment.findMany({ where: { entityId: entity.id }, orderBy: { from: "asc" } }));
  const pph25Row = finalRegime ? null : (
    <Pph25Row
      p={report.pph25}
      href={ledger("1180")}
      form={
        <Pph25Instalment
          clientId={client.id}
          entityId={entity.id}
          period={period.key}
          items={instalmentList.map((i) => ({ id: i.id, label: formatPeriod(i.from.getUTCFullYear(), i.from.getUTCMonth() + 1), amount: formatRupiah(i.amount) }))}
        />
      }
    />
  );

  return (
    <div className="space-y-6">
      {header}
      {firstProblem ? (
        <NextStep>{firstProblem.label}: {rowNotes(firstProblem)[0]}</NextStep>
      ) : pph25Problem ? (
        <NextStep>PPh 25: {pph25Notes(report.pph25!)[0]}</NextStep>
      ) : pending ? (
        <NextStep href={withParams(`${base}/review`, { period: period.key })} cta="Buka Review">
          {pending} mutasi {entity.shortName} {label} masih di Review, jadi pajak masa ini belum final. Selesaikan Review sebelum lapor di Coretax.
        </NextStep>
      ) : fakturGap ? (
        <NextStep href="#ekualisasi" cta="Lihat ekualisasi">{fakturGap}</NextStep>
      ) : bupotGap ? (
        <NextStep href="#bukti-potong" cta="Lihat bukti potong">{bupotGap}</NextStep>
      ) : terReview ? (
        <NextStep>{terNote(report.ter)}</NextStep>
      ) : offset !== 0n ? (
        <NextStep href="#ppn-offset" cta="Lihat kompensasi">
          Catat jurnal kompensasi PPN masa {label}, supaya Neraca menampilkan utang PPN bersih, bukan PPN masukan dan keluaran yang belum saling dikreditkan.
        </NextStep>
      ) : (
        <NextStep tone="done">Pajak masa {label} lolos semua pemeriksaan. Unduh kertas kerjanya untuk lapor di Coretax.</NextStep>
      )}

      <Card data-testid="masa-taxes">
        <CardHeader>
          <CardTitle>Setoran per jenis pajak</CardTitle>
          <CardDescription>
            Terutang masa ini dari buku besar; masa lalu dinilai dari setoran bank yang diklasifikasikan ke akun pajaknya sampai jatuh tempo (PPh tanggal 15, PPN akhir bulan berikutnya).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="eyebrow">Pajak</TableHead>
                <TableHead className="eyebrow text-right">Terutang masa ini</TableHead>
                <TableHead className="eyebrow hidden text-right md:table-cell">Jatuh tempo</TableHead>
                <TableHead className="eyebrow hidden text-right sm:table-cell">Masa lalu</TableHead>
                <TableHead className="eyebrow hidden text-right md:table-cell">Saldo akun</TableHead>
                <TableHead className="eyebrow hidden text-right sm:table-cell">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pph25Problem && pph25Row}
              {rows.map((r) => (
                <TaxRow
                  key={r.key}
                  r={r}
                  href={ledger(r.code)}
                  extra={r.ppn && r.ppn.offset !== 0n ? <PpnOffset clientId={client.id} entityId={entity.id} year={period.year} month={period.month} amount={r.ppn.offset.toString()} date={day(end)} /> : null}
                />
              ))}
              {pph25Problem ? null : pph25Row}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card id="ekualisasi" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>Ekualisasi PPN (Coretax)</CardTitle>
          <CardDescription>
            Faktur dari Coretax dibandingkan dengan PPN di buku besar masa ini: keluaran dengan 2130, masukan dengan 1150. Faktur hanya dibandingkan, tidak pernah dijurnal; koreksi lewat Review,
            Piutang & Utang atau Jurnal Penyesuaian.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FakturRecon
            clientId={client.id}
            entityId={entity.id}
            year={period.year}
            month={period.month}
            label={label}
            ledgerHref={{ KELUARAN: ledger("2130"), MASUKAN: ledger("1150") }}
            accounts={counterAccounts}
            directions={faktur.directions.map((d) => ({
              direction: d.direction,
              label: DIRECTION_LABEL[d.direction],
              account: d.account,
              imported: d.imported,
              fakturPpn: d.fakturPpn.toString(),
              bookPpn: d.bookPpn.toString(),
              difference: d.difference.toString(),
              status: d.status,
              matched: d.matched.length,
              unmatchedFaktur: d.unmatchedFaktur.map((f) => ({ id: f.id, number: f.number, date: day(f.date), npwp: f.npwp, name: f.name, ppn: f.ppn.toString(), status: f.status, sourceRef: f.sourceRef })),
              unmatchedBook: d.unmatchedBook.map((b) => ({ key: b.key, date: day(b.date), label: b.label, ppn: b.ppn.toString(), kind: b.kind })),
              notCounted: d.notCounted.map((f) => ({ id: f.id, number: f.number, date: day(f.date), npwp: f.npwp, name: f.name, ppn: f.ppn.toString(), status: f.status, sourceRef: f.sourceRef })),
              uncredited: d.uncredited.map((f) => ({ id: f.id, number: f.number, date: day(f.date), npwp: f.npwp, name: f.name, ppn: f.ppn.toString(), status: f.status, sourceRef: f.sourceRef })),
            }))}
          />
        </CardContent>
      </Card>

      <Card id="bukti-potong" className="scroll-mt-6" data-testid="masa-withholding">
        <CardHeader>
          <CardTitle>Bukti potong (Unifikasi)</CardTitle>
          <CardDescription>
            Dari mutasi bank dengan potongan PPh 22, 23 atau 4(2) masa ini. Bruto = yang dibayar atau diterima + yang dipotong. PPh 21 tidak masuk
            Unifikasi: bukti potongnya dibuat per penerima di e-Bupot 21/26.{reviewInWht ? ` ${reviewInWht} baris belum direview.` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <WithholdingTable title="Dipotong oleh perusahaan: buat bukti potongnya di Coretax" lines={report.withheldByUs} empty="Tidak ada pemotongan oleh perusahaan masa ini." />
          <WithholdingTable title="Dipotong oleh pelanggan: minta bukti potongnya" lines={report.withheldFromUs} empty="Tidak ada pemotongan oleh pelanggan masa ini." />
          <BupotRecon
            clientId={client.id}
            entityId={entity.id}
            year={period.year}
            month={period.month}
            label={label}
            directions={bupot.directions.map((d) => {
              const slip = (x: (typeof d.unmatchedSlips)[number]) => ({ number: x.number, date: day(x.date), name: x.name, npwp: x.npwp, kind: BUPOT_KIND_LABEL[x.kind], pph: x.pph.toString(), status: x.status });
              // The withholding sits on the payable (2141 / 2145) for slips the company made, on 1180 / 8200 for slips it received.
              const wht = (x: (typeof d.unmatchedBook)[number]) => ({ id: x.id, date: day(x.date), description: x.description, kind: BUPOT_KIND_LABEL[x.kind], pph: x.pph.toString(), href: ledger(withholdingAccountCode(x.kind as WithholdingKind, d.direction === "DIBUAT" ? "OUT" : "IN")) });
              return {
                direction: d.direction,
                label: BUPOT_DIRECTION_LABEL[d.direction],
                imported: d.imported,
                slipPph: d.slipPph.toString(),
                bookPph: d.bookPph.toString(),
                difference: d.difference.toString(),
                status: d.status,
                matched: d.matched.length,
                kindDiffers: d.kindDiffers.map((p) => ({ slip: slip(p.slip), book: wht(p.book) })),
                unmatchedSlips: d.unmatchedSlips.map(slip),
                unmatchedBook: d.unmatchedBook.map(wht),
                notCounted: d.notCounted.length,
              };
            })}
          />
        </CardContent>
      </Card>

      <Card data-testid="masa-ter">
        <CardHeader>
          {period.month === 12 ? (
            <>
              <CardTitle>PPh 21 Desember (Pasal 17 setahun)</CardTitle>
              <CardDescription>
                PMK 168/2023: PPh 21 setahun dihitung ulang dengan tarif Pasal 17, dikurangi TER Januari–November; hasilnya PPh 21 Desember (negatif = lebih
                potong, dikembalikan ke karyawan). Estimasi dari upah sensus dan status PTKP; THR, bonus dan iuran JHT / JP karyawan belum termasuk.
              </CardDescription>
            </>
          ) : (
            <>
              <CardTitle>PPh 21 dengan TER</CardTitle>
              <CardDescription>PP 58/2023, Januari–November. Estimasi dari upah di sensus karyawan dan status PTKP.</CardDescription>
            </>
          )}
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="flex flex-wrap items-start gap-2">
            {(report.ter.state === "CHECKED" || report.ter.state === "ANNUAL") && <StatusPill status={report.ter.status} />}
            <p className="min-w-0 flex-1">{terNote(report.ter)}</p>
            {(report.ter.state === "NO_EMPLOYEES" || report.ter.state === "NO_STATUS") && (
              <Link href={withParams(`${base}/benefits`, { entity: entity.id, period: period.key })} className="text-primary underline-offset-2 hover:underline">Buka Imbalan Kerja</Link>
            )}
          </div>
          {report.ter.state === "CHECKED" && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="eyebrow">Nama</TableHead>
                  <TableHead className="eyebrow">PTKP</TableHead>
                  <TableHead className="eyebrow hidden text-right sm:table-cell">Upah</TableHead>
                  <TableHead className="eyebrow text-right">Tarif</TableHead>
                  <TableHead className="eyebrow text-right">PPh 21</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.ter.employees.map(terRow).map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>{e.name}</TableCell>
                    <TableCell>{e.statusLabel} · {e.category}</TableCell>
                    <TableCell className="hidden text-right sm:table-cell"><Money value={e.wage} /></TableCell>
                    <TableCell className="num text-right">{e.rateLabel}</TableCell>
                    <TableCell className="text-right"><Money value={e.tax} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={2}>{report.ter.leavers.length ? "Estimasi TER (karyawan aktif)" : "Estimasi TER"}</TableCell>
                  <TableCell className="hidden sm:table-cell" />
                  <TableCell />
                  <TableCell className="text-right"><Money value={report.ter.estimate - report.ter.leavers.reduce((t, e) => t + e.december, 0n)} strong /></TableCell>
                </TableRow>
                {report.ter.leavers.length > 0 && (
                  <TableRow>
                    <TableCell colSpan={2}>Estimasi PPh 21 (termasuk yang berhenti)</TableCell>
                    <TableCell className="hidden sm:table-cell" />
                    <TableCell />
                    <TableCell className="text-right"><Money value={report.ter.estimate} strong /></TableCell>
                  </TableRow>
                )}
                <TableRow>
                  <TableCell colSpan={2}><Link href={ledger("2140")} className="hover:text-primary">Terutang di buku besar (2140)</Link></TableCell>
                  <TableCell className="hidden sm:table-cell" />
                  <TableCell />
                  <TableCell className="text-right"><Money value={report.ter.booked} strong /></TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          )}
          {report.ter.state === "CHECKED" && report.ter.leavers.length > 0 && (
            <div className="space-y-2" data-testid="pph21-leavers">
              <p className="font-medium">Berhenti bulan ini: PPh 21 masa terakhir dengan tarif Pasal 17 (PMK 168/2023)</p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="eyebrow">Nama</TableHead>
                    <TableHead className="eyebrow hidden text-right md:table-cell">Bruto s.d. bulan ini</TableHead>
                    <TableHead className="eyebrow hidden text-right md:table-cell">PKP</TableHead>
                    <TableHead className="eyebrow hidden text-right sm:table-cell">PPh Pasal 17</TableHead>
                    <TableHead className="eyebrow hidden text-right sm:table-cell">TER sebelumnya</TableHead>
                    <TableHead className="eyebrow text-right">Masa terakhir</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.ter.leavers.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>
                        {e.name}
                        <div className="text-xs text-muted-foreground">{PTKP_LABEL[e.status]} · {e.months} bulan</div>
                      </TableCell>
                      <TableCell className="hidden text-right md:table-cell"><Money value={e.gross} /></TableCell>
                      <TableCell className="hidden text-right md:table-cell"><Money value={e.pkp} /></TableCell>
                      <TableCell className="hidden text-right sm:table-cell"><Money value={e.annual} /></TableCell>
                      <TableCell className="hidden text-right sm:table-cell"><Money value={e.ter} /></TableCell>
                      <TableCell className="text-right"><Money value={e.december} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {report.ter.state === "ANNUAL" && (
            <Table data-testid="pph21-annual">
              <TableHeader>
                <TableRow>
                  <TableHead className="eyebrow">Nama</TableHead>
                  <TableHead className="eyebrow hidden sm:table-cell">PTKP</TableHead>
                  <TableHead className="eyebrow hidden text-right md:table-cell">Bruto setahun</TableHead>
                  <TableHead className="eyebrow hidden text-right md:table-cell">PKP</TableHead>
                  <TableHead className="eyebrow hidden text-right sm:table-cell">PPh setahun</TableHead>
                  <TableHead className="eyebrow hidden text-right sm:table-cell">TER Jan–Nov</TableHead>
                  <TableHead className="eyebrow text-right">Desember</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.ter.employees.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>
                      {e.name}
                      <div className="text-xs text-muted-foreground"><span className="sm:hidden">{PTKP_LABEL[e.status]} · </span>{e.months} bulan</div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">{PTKP_LABEL[e.status]}</TableCell>
                    <TableCell className="hidden text-right md:table-cell"><Money value={e.gross} /></TableCell>
                    <TableCell className="hidden text-right md:table-cell"><Money value={e.pkp} /></TableCell>
                    <TableCell className="hidden text-right sm:table-cell"><Money value={e.annual} /></TableCell>
                    <TableCell className="hidden text-right sm:table-cell"><Money value={e.ter} /></TableCell>
                    <TableCell className="text-right"><Money value={e.december} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell>Estimasi PPh 21 Desember</TableCell>
                  <TableCell colSpan={5} className="hidden sm:table-cell" />
                  <TableCell className="text-right"><Money value={report.ter.estimate} strong /></TableCell>
                </TableRow>
                <TableRow>
                  <TableCell><Link href={ledger("2140")} className="hover:text-primary">Terutang di buku besar (2140)</Link></TableCell>
                  <TableCell colSpan={5} className="hidden sm:table-cell" />
                  <TableCell className="text-right"><Money value={report.ter.booked} strong /></TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TaxRow({ r, href, extra }: { r: MasaRow; href: string; extra: React.ReactNode }) {
  const notes = rowNotes(r);
  const p = r.previous;
  const paid = p.paid.reduce((t, x) => t + x.amount, 0n);
  const late = p.late.reduce((t, x) => t + x.amount, 0n);
  return (
    <>
      <TableRow data-testid={`masa-row-${r.key}`}>
        <TableCell className="font-medium">
          <Link href={href} className="hover:text-primary">{r.label}</Link>
          <span className="ml-1 text-xs text-muted-foreground">{r.code}</span>
          {/* Phones: the status sits under the name (the Status column is hidden below sm). */}
          <div className="mt-1 sm:hidden"><StatusPill status={r.status} /></div>
        </TableCell>
        <TableCell className="text-right"><Link href={href} className="hover:text-primary"><Money value={r.owed} /></Link></TableCell>
        <TableCell className="num hidden text-right md:table-cell">{formatDate(r.due)}</TableCell>
        <TableCell className="hidden text-right sm:table-cell">
          <Money value={p.owed} />
          <div className="text-xs text-muted-foreground">
            {formatPeriod(p.masa.year, p.masa.month)} · {r.netPayroll ? "disetor tanpa terutang" : previousStateLabel(p.state)}
          </div>
          {paid + late > 0n && paid + late !== p.owed && <div className="num text-xs text-muted-foreground">disetor {formatRupiah(paid + late, { bare: true })}</div>}
        </TableCell>
        <TableCell className="hidden text-right md:table-cell"><Link href={href} className="hover:text-primary"><Money value={r.balance} /></Link></TableCell>
        <TableCell className="hidden text-right sm:table-cell"><StatusPill status={r.status} /></TableCell>
      </TableRow>
      {(notes.length > 0 || r.ppn) && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={6} className="pt-0 text-xs whitespace-normal text-muted-foreground">
            {r.ppn && <div>{ppnLine(r.ppn)}</div>}
            {notes.map((x) => <div key={x}>{x}</div>)}
            {extra}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** PPh 25 angsuran: no payable account, so the balance column stays empty; the instalment form sits under it. */
function Pph25Row({ p, href, form }: { p: Pph25 | null; href: string; form: React.ReactNode }) {
  const paid = p ? [...p.previous.paid, ...p.previous.late].reduce((t, x) => t + x.amount, 0n) : 0n;
  const notes = p ? pph25Notes(p) : [];
  return (
    <>
      <TableRow data-testid="masa-row-PPH_25">
        <TableCell className="font-medium">
          <Link href={href} className="hover:text-primary">PPh 25</Link>
          <span className="ml-1 text-xs text-muted-foreground">angsuran</span>
          {p && <div className="mt-1 sm:hidden"><StatusPill status={p.status} /></div>}
        </TableCell>
        <TableCell className="text-right">{p?.current.expected != null ? <Money value={p.current.expected} /> : <span className="text-muted-foreground">–</span>}</TableCell>
        <TableCell className="num hidden text-right md:table-cell">{p ? formatDate(p.current.due) : ""}</TableCell>
        <TableCell className="hidden text-right sm:table-cell">
          {p?.previous.expected != null ? <Money value={p.previous.expected} /> : <span className="text-muted-foreground">–</span>}
          <div className="text-xs text-muted-foreground">
            {p ? `${formatPeriod(p.previous.masa.year, p.previous.masa.month)} · ${pph25StateLabel(p.previous.state)}` : "Angsuran belum diisi"}
          </div>
          {p && paid > 0n && paid !== p.previous.expected && <div className="num text-xs text-muted-foreground">disetor {formatRupiah(paid, { bare: true })}</div>}
        </TableCell>
        <TableCell className="hidden text-right md:table-cell"><span className="text-muted-foreground">–</span></TableCell>
        <TableCell className="hidden text-right sm:table-cell">{p && <StatusPill status={p.status} />}</TableCell>
      </TableRow>
      <TableRow className="hover:bg-transparent">
        <TableCell colSpan={6} className="pt-0 text-xs whitespace-normal text-muted-foreground">
          {(p ? notes : ["Angsuran PPh 25 per bulan belum diisi: isi dari SPT tahunan terakhir supaya setorannya bisa dicek."]).map((x) => <div key={x}>{x}</div>)}
          {form}
        </TableCell>
      </TableRow>
    </>
  );
}

function WithholdingTable({ title, lines, empty }: { title: string; lines: WithholdingLine[]; empty: string }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="eyebrow hidden sm:table-cell">Tanggal</TableHead>
              <TableHead className="eyebrow">Lawan transaksi</TableHead>
              <TableHead className="eyebrow hidden sm:table-cell">Jenis</TableHead>
              <TableHead className="eyebrow hidden text-right sm:table-cell">Bruto</TableHead>
              <TableHead className="eyebrow text-right">Dipotong</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((w) => (
              <TableRow key={w.id}>
                <TableCell className="num hidden whitespace-nowrap sm:table-cell">{formatDate(w.date)}</TableCell>
                <TableCell className="whitespace-normal">
                  <div>{w.contact?.name ?? <span className="text-muted-foreground">Belum ditautkan ke kontak</span>}{w.contact?.npwp ? <span className="num ml-1 text-xs text-muted-foreground">NPWP {w.contact.npwp}</span> : null}</div>
                  <div className="text-xs text-muted-foreground">{w.description}{w.inReview ? " · belum direview" : ""}</div>
                  {/* Phones: the date and kind sit under the name (their columns are hidden below sm), so the amount withheld stays in view. */}
                  <div className="num text-xs text-muted-foreground sm:hidden">{formatDate(w.date)} · {withholdingLabel(w.kind)}</div>
                </TableCell>
                <TableCell className="hidden sm:table-cell">{withholdingLabel(w.kind)}</TableCell>
                <TableCell className="hidden text-right sm:table-cell"><Money value={w.gross} /></TableCell>
                <TableCell className="text-right"><Money value={w.withheld} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
