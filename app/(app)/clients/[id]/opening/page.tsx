import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { findClientForMember } from "@/lib/tenant";
import { openingContext } from "@/lib/opening";
import { findingLabel } from "@/lib/findings";
import Link from "next/link";
import { formatDate, toIsoDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { ACCOUNT_CODES } from "@/lib/coa/template";
import { setupProgress } from "@/lib/setup-progress";
import { SetupSteps } from "@/components/app/setup-steps";
import { NextStep, PageHeader } from "@/components/app/page-header";
import { OpeningForm } from "@/components/app/opening-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Saldo Awal" };

export default async function OpeningPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = (await findClientForMember(id)) ?? notFound();
  const [ctx, accounts] = await Promise.all([
    openingContext(prisma, client.id),
    prisma.account.findMany({ where: { clientId: client.id, isBank: false, archivedAt: null, type: { notIn: ["PENDAPATAN", "BEBAN"] }, code: { notIn: [ACCOUNT_CODES.SUSPENSE, ACCOUNT_CODES.RETAINED, ACCOUNT_CODES.CLEARING, ACCOUNT_CODES.OPENING_DIFFERENCE] } }, orderBy: { code: "asc" } }),
  ]);
  const setup = await setupProgress(prisma, client.id);
  // Entities whose ledger import brought its own opening rows don't need a separate Saldo Awal.
  const imported = new Set(
    (await prisma.journalEntry.findMany({ where: { entityId: { in: ctx.map((c) => c.entity.id) }, kind: "IMPORTED" }, select: { entityId: true }, distinct: ["entityId"] })).map((e) => e.entityId),
  );
  const openFindings = await prisma.finding.findMany({ where: { clientId: client.id, status: "OPEN", kind: "OPENING_DIFFERENCE" }, orderBy: { number: "asc" }, select: { entityId: true, number: true } });
  const waiting = (entityId: string) => openFindings.filter((f) => f.entityId === entityId).map((f) => findingLabel(f.number));
  const currencyOf = (entityId: string) => client.entities.find((e) => e.id === entityId)?.functionalCurrency ?? "IDR";

  return (
    <div className="space-y-6">
      <PageHeader title="Saldo Awal" description="Posisi keuangan sebelum transaksi pertama di Buku" />
      {!setup.hasData ? (
        <NextStep href={`/clients/${client.id}/import`} cta="Unggah rekening koran">
          Unggah rekening koran dulu. Saldo bank di sini terisi otomatis dari sana, jadi Anda tidak perlu mengetik angkanya. Atau isi manual di bawah.
        </NextStep>
      ) : setup.needsOpening.length ? (
        <NextStep>{setup.next?.text}</NextStep>
      ) : (
        <NextStep tone="done" href={setup.next?.href} cta={setup.next?.cta}>Saldo awal semua entitas sudah dicatat.</NextStep>
      )}
      <SetupSteps progress={setup} />
      {ctx.map((c) => (
        <Card key={c.entity.id}>
          <CardHeader>
            <CardTitle>{c.entity.name}</CardTitle>
            <CardDescription>
              {c.existing
                ? waiting(c.entity.id).length
                  ? <>Dicatat per {formatDate(c.existing.date)}. Selisihnya menunggu keputusan di <Link className="font-medium text-primary hover:underline" href={`/clients/${client.id}/close#temuan`}>temuan {waiting(c.entity.id).join(", ")}</Link>.</>
                  : `Dicatat per ${formatDate(c.existing.date)}. Koreksi lewat Jurnal Penyesuaian.`
                : imported.has(c.entity.id)
                  ? "Buku entitas ini berasal dari impor buku besar, termasuk saldo awalnya."
                  : c.banks.length === 0
                    ? "Tidak ada rekening bank, jadi saldo awal tidak wajib. Isi hanya kalau entitas ini punya saldo lain. Selisih debit dan kredit menjadi temuan."
                    : "Salin dari neraca klien, termasuk Saldo Laba. Selisih debit dan kredit tidak diseimbangkan otomatis: ia menjadi temuan yang harus diputuskan sebelum tutup buku."}
            </CardDescription>
          </CardHeader>
          <CardContent className={c.existing ? "px-0" : undefined}>
            {c.existing ? (
              <Table>
                <TableHeader>
                  <TableRow><TableHead className="pl-6">Akun</TableHead><TableHead className="text-right">Debit</TableHead><TableHead className="pr-6 text-right">Kredit</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {c.existing.lines.map((l, i) => (
                    <TableRow key={i}>
                      <TableCell className="pl-6">{l.code} {l.name}</TableCell>
                      <TableCell className="num text-right">{l.debit ? formatMoney(l.debit, currencyOf(c.entity.id), { bare: true }) : "–"}</TableCell>
                      <TableCell className="num pr-6 text-right">{l.credit ? formatMoney(l.credit, currencyOf(c.entity.id), { bare: true }) : "–"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : imported.has(c.entity.id) ? null : (
              <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Punya neraca dari sistem lama (mis. Jurnal atau Accurate)?{" "}
                <Link className="font-medium text-primary hover:underline" href={`/clients/${client.id}/import?tab=ledger`}>Impor dari file neraca</Link>, lalu petakan akunnya.
              </p>
              <OpeningForm
                clientId={client.id}
                entityId={c.entity.id}
                currency={currencyOf(c.entity.id)}
                suggestedDate={toIsoDate(c.suggestedDate)}
                banks={c.banks.map((b) => ({ accountCode: b.accountCode, label: b.label, isOverdraft: b.isOverdraft, prefill: b.statementOpening === null ? "" : formatMoney(b.statementOpening, currencyOf(c.entity.id), { bare: true }), source: b.source }))}
                accounts={accounts.map((a) => ({ code: a.code, name: a.name }))}
                deposits={c.deposits.map((d) => ({ accountCode: ACCOUNT_CODES.DEPOSIT, amount: formatMoney(d.amount, currencyOf(c.entity.id), { bare: true }), note: d.note }))}
                loanRows={c.loanRows}
                company={client.entities.find((e) => e.id === c.entity.id)?.kind !== "PERORANGAN"}
              />
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
