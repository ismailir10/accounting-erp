import { Download } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { withParams } from "@/lib/scope";

/**
 * The month's Excel and the financial year to date's, for Buku Besar and Neraca Saldo (working papers: no *Terkirim* event). Rupiah books
 * only; the caller leaves it out otherwise.
 */
export function LedgerDownloads({ href, query, testId }: { href: string; query: Record<string, string | undefined>; testId: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      <a href={withParams(href, query)} className={buttonVariants({ variant: "outline" })} download data-testid={testId}>
        <Download /> Unduh Excel
      </a>
      <a href={withParams(href, { ...query, range: "ytd" })} className={buttonVariants({ variant: "ghost" })} download data-testid={`${testId}-ytd`}>
        Excel s.d. bulan ini
      </a>
    </div>
  );
}
