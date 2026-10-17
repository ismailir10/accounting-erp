import Link from "next/link";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { prisma } from "@/lib/db";
import { loadClientPage } from "@/lib/client-page";
import { type SearchParams, withParams } from "@/lib/scope";
import { formatDate, formatDateLong, formatDateTime } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { NextStep, PageHeader } from "@/components/app/page-header";
import { ScopeBar } from "@/components/app/scope-bar";
import { Money } from "@/components/app/money";
import { JournalFilters } from "@/components/app/journal-filters";
import { ENTRY_KIND_LABEL } from "@/lib/reports/entry-source";
import { parseRange, rangeBounds } from "@/lib/reports/general-ledger";
import { journalRegister, KIND_FILTERS, parseKindFilter, parseSearch } from "@/lib/reports/journal-register";
import { rangeLabel } from "@/lib/reports/ledger-workbook";

export const metadata = { title: "Jurnal Umum" };

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/**
 * Jurnal Umum: every journal of the month (or the financial year to date), with its lines and where it came from, filtered by kind and
 * searched by text or amount. Read-only; each account opens its Buku Besar for the journal's month.
 */
export default async function JournalsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { client, period, scope, periodOptions, entityOptions, base, scopeLabel, currency, mixed, sp } = await loadClientPage(params, searchParams);
  const range = parseRange(sp.range);
  const kind = parseKindFilter(sp.jenis);
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const page = Math.max(1, Math.floor(Number(sp.hal)) || 1);
  const bounds = await rangeBounds(prisma, client.id, range, period);
  const label = rangeLabel(range, bounds.start, bounds.end);
  const header = (
    <PageHeader title="Jurnal Umum" description={`${scopeLabel} · ${label}`} actions={<ScopeBar entities={entityOptions} periods={periodOptions} entity={scope.value} period={period.key} />} />
  );
  if (mixed) {
    // Journals in SGD and IDR can't share one total: one company at a time, as Buku Besar.
    const scoped = client.entities.filter((e) => scope.entityIds.includes(e.id));
    return (
      <div className="space-y-6">
        {header}
        <NextStep>Jurnal ditampilkan per perusahaan karena mata uangnya berbeda. Pilih perusahaan.</NextStep>
        <ul className="flex flex-wrap gap-2">
          {scoped.map((e) => (
            <li key={e.id}>
              <Link href={withParams(`${base}/journals`, { period: period.key, entity: e.id, range: range === "ytd" ? "ytd" : undefined })} className={buttonVariants({ variant: "outline" })}>
                {e.shortName} · {e.functionalCurrency} <ChevronRight />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const search = parseSearch(q, currency);
  const reg = await journalRegister(prisma, { clientId: client.id, entityIds: scope.entityIds }, { ...bounds, kinds: kind.kinds, search }, page);
  const query = { period: period.key, entity: scope.value, range: range === "ytd" ? "ytd" : undefined, jenis: kind.kinds ? kind.value : undefined, q: q || undefined };
  const filtered = Boolean(kind.kinds || search);
  const pageHref = (n: number) => withParams(`${base}/journals`, { ...query, hal: n > 1 ? String(n) : undefined });
  const ledgerHref = (code: string, date: Date) => withParams(`${base}/ledger/${code}`, { period: monthKey(date), entity: scope.value });

  return (
    <div className="space-y-6">
      {header}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <JournalFilters
          ranges={[{ value: "month", label: "Bulan ini" }, { value: "ytd", label: "Tahun buku s.d. bulan ini" }]}
          kinds={KIND_FILTERS.map((k) => ({ value: k.value, label: k.label }))}
          range={range}
          kind={kind.value}
          q={q}
        />
        {currency === "IDR" && reg.count > 0 && (
          <a href={withParams(`${base}/journals/export`, query)} className={buttonVariants({ variant: "outline" })} download data-testid="journals-download">
            <Download /> Unduh Excel
          </a>
        )}
      </div>
      <NextStep>Periksa jurnal bulan ini; pilih akun di baris jurnal untuk membuka buku besarnya.</NextStep>
      <p className="text-sm text-muted-foreground" data-testid="journals-summary">
        <span className="font-medium text-foreground">{reg.count.toLocaleString("id-ID")} jurnal</span>
        {reg.count > 0 && (
          <>
            {" "}· debit <span className="num">{formatMoney(reg.debit, currency)}</span> · kredit <span className="num">{formatMoney(reg.credit, currency)}</span>
            {reg.debit === reg.credit ? " · seimbang" : null}
          </>
        )}
      </p>
      <Card>
        <CardContent className="px-0">
          {reg.entries.length === 0 ? (
            <div className="px-6 py-8 text-center text-sm text-muted-foreground">
              {filtered ? (
                <>
                  Tidak ada jurnal yang cocok dengan filter ini.{" "}
                  <Link className="drill" href={withParams(`${base}/journals`, { period: period.key, entity: scope.value, range: query.range })}>Hapus filter</Link>
                </>
              ) : (
                `Belum ada jurnal di ${label}.`
              )}
            </div>
          ) : (
            <ol className="divide-y" data-testid="journal-list">
              {reg.entries.map((e) => (
                <li key={e.id} className="space-y-2 px-4 py-4 sm:px-6" data-testid="journal-entry">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">
                        <span className="num">{formatDate(e.date)}</span> · {ENTRY_KIND_LABEL[e.kind]}
                        {scope.mode === "combined" && ` · ${e.entity}`}
                        {e.reversedOn && <span className="text-review"> · dibalik {formatDateLong(e.reversedOn)}</span>}
                      </p>
                      <p className="font-medium break-words">{e.memo}</p>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {e.postedBy} · {formatDateTime(e.postedAt)}
                    </p>
                  </div>
                  {e.source && <p className="text-xs break-words text-muted-foreground">Sumber: {e.source}</p>}
                  <table className="w-full max-w-3xl table-fixed text-sm">
                    <thead className="sr-only">
                      <tr>
                        <th>Akun</th>
                        <th>Debit</th>
                        <th>Kredit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {e.lines.map((l, i) => (
                        <tr key={i}>
                          <td className={l.credit > 0n ? "truncate py-0.5 pl-6" : "truncate py-0.5"}>
                            <Link href={ledgerHref(l.code, e.date)} className="drill">
                              <span className="num text-muted-foreground">{l.code}</span> {l.name}
                            </Link>
                            {l.memo && l.memo !== e.memo && <span className="block truncate text-xs text-muted-foreground">{l.memo}</span>}
                          </td>
                          <td className="w-24 py-0.5 text-right align-top sm:w-36">{l.debit > 0n && <Money value={l.debit} currency={currency} />}</td>
                          <td className="w-24 py-0.5 text-right align-top sm:w-36">{l.credit > 0n && <Money value={l.credit} currency={currency} />}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
      {reg.pages > 1 && (
        <nav aria-label="Halaman" className="flex items-center justify-between gap-2 text-sm">
          {page > 1 ? (
            <Link href={pageHref(page - 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
              <ChevronLeft /> Sebelumnya
            </Link>
          ) : (
            <span />
          )}
          <span className="text-muted-foreground">
            Halaman {Math.min(page, reg.pages)} dari {reg.pages}
          </span>
          {page < reg.pages ? (
            <Link href={pageHref(page + 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Berikutnya <ChevronRight />
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  );
}
