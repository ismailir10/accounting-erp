import { CircleAlert, CircleCheck, FileSpreadsheet, FileText, LockKeyholeOpen } from "lucide-react";
import { CheckDraw } from "@/components/motion/check-draw";
import { CountUpOnView } from "@/components/motion/count-up";
import { Reveal } from "@/components/motion/reveal";
import { formatMoney } from "@/lib/money";
import type { PublicProductEvidence } from "@/lib/public-product";
import { cn } from "@/lib/utils";

/*
 * Drawn illustrations for the public page, in the hero's paper-and-ledger style. Every figure, name and row number comes from
 * the synthetic demo the real app produced (public/product/capture-manifest.json). Where the demo has no number to show, the
 * paper carries a neutral bar, never an invented amount.
 */

const bare = (minor: string) => formatMoney(BigInt(minor), "IDR", { bare: true });
const monthOf = (period: string) => new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${period}-01T00:00:00Z`));
const dayOf = (date: string) => new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
const shortDate = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const accountName = (name: string) => name.replace(/\s*\([^)]*\)$/, "");
const byAmountDesc = (a: bigint, b: bigint) => (a === b ? 0 : a > b ? -1 : 1);

/** A sheet of paper lying on another: the offset sheet behind gives depth without a shadow. */
function Sheet({ children, className, inner }: { children: React.ReactNode; className?: string; inner?: string }) {
  return <div className={cn("relative", className)}>
    <div aria-hidden="true" className="absolute inset-0 translate-x-2 translate-y-2 rounded-xl border bg-muted" />
    <div className={cn("relative rounded-xl border bg-card", inner)}>{children}</div>
  </div>;
}

/** A neutral placeholder line standing in for text or an amount the illustration does not claim. */
function Bar({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("block h-2 rounded-full bg-muted", className)} />;
}

/** Continuous-form statement paper: the tractor-feed holes of a printed rekening koran. */
function FeedHoles() {
  return <div aria-hidden="true" className="flex flex-col justify-between py-4">
    {Array.from({ length: 9 }, (_, index) => <span key={index} className="size-2 rounded-full border bg-background" />)}
  </div>;
}

/** The line that carries a source row to its result; it draws once when the section arrives. Down on a phone, across on wider screens. */
function Connector({ label }: { label: string }) {
  return <div aria-hidden="true" className="flex items-center justify-center gap-3 text-primary md:flex-col md:gap-1">
    <svg viewBox="0 0 24 44" className="h-11 w-6 md:hidden" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path className="trace-draw" pathLength={1} d="M12 3v36" />
      <path d="m6 33 6 6 6-6" />
    </svg>
    <svg viewBox="0 0 72 24" className="hidden h-6 w-16 md:block" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path className="trace-draw" pathLength={1} d="M3 12h62" />
      <path d="m59 6 6 6-6 6" />
    </svg>
    <span className="eyebrow text-muted-foreground">{label}</span>
  </div>;
}

/** Rekening koran row → balanced journal, the core of "every number proves itself". */
export function SourceToJournalIllustration({ evidence }: { evidence: PublicProductEvidence }) {
  const { source } = evidence;
  const date = source.date;
  const neighbours = [source.rowNumber - 2, source.rowNumber - 1, source.rowNumber, source.rowNumber + 1, source.rowNumber + 2];
  const label = `Ilustrasi: baris ${source.rowNumber} rekening koran ${source.fileName} senilai Rp ${bare(source.amount)} dibukukan menjadi jurnal ${source.lines.map((line) => `${line.code} ${accountName(line.name)}`).join(", ")}, dengan total debit sama dengan total kredit.`;
  return <Reveal>
    <div role="img" aria-label={label} className="grid items-center gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:gap-4">
      <Sheet className="md:rotate-[-1.2deg]" inner="flex gap-3 px-3">
        <FeedHoles />
        <div className="min-w-0 flex-1 py-5">
          <div className="flex items-baseline justify-between gap-3 border-b pb-3">
            <p className="font-medium">Rekening koran</p>
            <p className="truncate font-mono text-xs text-muted-foreground">{source.fileName}</p>
          </div>
          <ol data-stagger className="mt-2 divide-y">
            {neighbours.map((row, index) => row === source.rowNumber
              ? <li key={row} style={{ "--i": index } as React.CSSProperties} className="-mx-2 rounded-lg bg-primary-subtle px-2 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2 text-sm font-medium text-primary"><span className="size-1.5 rounded-full bg-primary" />Baris {row}</span>
                  <span className="num text-sm font-medium">+{bare(source.amount)}</span>
                </div>
                <p className="mt-1.5 break-words font-mono text-[11px] leading-relaxed text-muted-foreground">{shortDate(date)} {source.description}</p>
              </li>
              : <li key={row} style={{ "--i": index } as React.CSSProperties} className="flex items-center gap-3 py-3">
                <span className="num w-6 shrink-0 text-xs text-muted-foreground">{row}</span>
                <Bar className={index % 2 ? "w-2/5" : "w-3/5"} />
                <Bar className="ml-auto w-14" />
              </li>)}
          </ol>
        </div>
        <FeedHoles />
      </Sheet>

      <Connector label="Dibukukan" />

      <Sheet className="md:rotate-[0.8deg]" inner="p-5">
        <div className="flex items-baseline justify-between gap-3 border-b pb-3">
          <p className="font-medium">Jurnal</p>
          <p className="text-xs text-muted-foreground">{dayOf(date)}</p>
        </div>
        <p className="mt-3 inline-flex max-w-full items-center gap-2 rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
          <span className="shrink-0">Sumber</span><span className="truncate font-mono text-foreground">{source.fileName} · baris {source.rowNumber}</span>
        </p>
        <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 text-xs text-muted-foreground sm:gap-x-4"><span>Akun</span><span className="w-[5.5rem] text-right sm:w-24">Debit</span><span className="w-[5.5rem] text-right sm:w-24">Kredit</span></div>
        <ul data-stagger className="mt-1 divide-y">
          {[...source.lines].sort((a, b) => byAmountDesc(BigInt(a.debit), BigInt(b.debit))).map((line, index) => <li key={line.code} style={{ "--i": index + 1 } as React.CSSProperties} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 py-2.5 text-sm sm:gap-x-4">
            <span className="min-w-0 break-words"><span className="num text-muted-foreground">{line.code}</span> {accountName(line.name)}</span>
            <span className="num w-[5.5rem] text-right sm:w-24">{line.debit === "0" ? "" : bare(line.debit)}</span>
            <span className="num w-[5.5rem] text-right sm:w-24">{line.credit === "0" ? "" : bare(line.credit)}</span>
          </li>)}
        </ul>
        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 border-t border-foreground pt-2.5 text-sm font-medium sm:gap-x-4">
          <span>Total</span><span className="num w-[5.5rem] text-right sm:w-24">{bare(source.journalDebit)}</span><span className="num w-[5.5rem] text-right sm:w-24">{bare(source.journalCredit)}</span>
        </div>
        {BigInt(source.journalDebit) === BigInt(source.journalCredit) && <p className="mt-4 flex items-center gap-2 text-sm text-pass"><CheckDraw />Debit = kredit</p>}
      </Sheet>
    </div>
  </Reveal>;
}

/** The close as a checklist on paper: problems first, passes folded, and a lock that stays open until they are done. */
export function CloseChecklistIllustration({ evidence }: { evidence: PublicProductEvidence }) {
  const controls = evidence.close.controls;
  const problems = controls.filter((control) => control.status !== "PASS");
  const passes = controls.filter((control) => control.status === "PASS");
  const month = monthOf(evidence.period);
  const label = `Ilustrasi Tutup Buku ${evidence.client.name} ${month}: ${problems.length} kontrol perlu dicek dan ${passes.length} lolos. Bulan belum bisa dikunci sampai temuan selesai.`;
  return <Reveal>
    <Sheet className="md:rotate-[0.6deg]" inner="p-5 sm:p-6">
      <div role="img" aria-label={label}>
        <div className="flex items-start justify-between gap-4 border-b pb-4">
          <div className="min-w-0"><p className="eyebrow text-muted-foreground">Tutup Buku · {month}</p><p className="mt-1.5 truncate text-lg">{evidence.client.name}</p></div>
          <span className="inline-flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground"><LockKeyholeOpen className="size-4" aria-hidden="true" />Belum dikunci</span>
        </div>
        <div className="grid grid-cols-2 gap-4 border-b py-5">
          <div><p className="flex items-center gap-2 text-sm text-review"><CircleAlert className="size-4" aria-hidden="true" />Perlu dicek</p><p className="display mt-1 text-5xl"><CountUpOnView value={problems.length} /></p></div>
          <div><p className="flex items-center gap-2 text-sm text-pass"><CircleCheck className="size-4" aria-hidden="true" />Lolos</p><p className="display mt-1 text-5xl"><CountUpOnView value={passes.length} /></p></div>
        </div>
        <ul data-stagger className="divide-y">
          {problems.slice(0, 4).map((control, index) => <li key={control.key} style={{ "--i": index } as React.CSSProperties} className="flex items-start gap-3 py-3">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-review" aria-hidden="true" />
            <div className="min-w-0"><p className="text-sm font-medium">{control.title}</p><p className="text-xs text-muted-foreground">{control.scope}</p></div>
          </li>)}
          <li style={{ "--i": 4 } as React.CSSProperties} className="flex items-center gap-3 py-3 text-sm text-muted-foreground">
            <CircleCheck className="size-4 shrink-0 text-pass" aria-hidden="true" />{passes.length} kontrol lolos, termasuk {passes[0]?.title.toLowerCase()}
          </li>
        </ul>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted px-3 py-2.5">
          <p className="text-sm text-muted-foreground">Kunci bulan setelah temuan selesai</p>
          <span aria-hidden="true" className="inline-flex h-8 items-center gap-1.5 rounded-lg border bg-card px-3 text-sm text-muted-foreground"><LockKeyholeOpen className="size-3.5" />Tutup buku</span>
        </div>
      </div>
    </Sheet>
  </Reveal>;
}

/** One ledger, three reports: the trial balance on top adds up, and its numbers lead back to the bank row. */
export function ReportStackIllustration({ evidence }: { evidence: PublicProductEvidence }) {
  const month = monthOf(evidence.period);
  const { trialBalance, source } = evidence;
  const balanced = trialBalance.debit === trialBalance.credit;
  const label = `Ilustrasi Neraca Saldo ${evidence.reportEntity.name} ${month} dengan total debit dan kredit masing-masing Rp ${bare(trialBalance.debit)}, di atas Laba Rugi dan Neraca dari buku yang sama. Akun Penjualan dapat ditelusuri ke ${source.fileName} baris ${source.rowNumber}. Unduh Excel atau PDF.`;
  return <Reveal>
    <div role="img" aria-label={label} className="relative pt-16">
      {["Neraca", "Laba Rugi"].map((title, index) => <div key={title} aria-hidden="true" className={cn("absolute inset-x-0 h-40 rounded-xl border px-5 pt-2", index === 0 ? "top-0 mx-10 bg-muted md:rotate-[1.5deg]" : "top-8 mx-5 bg-card md:rotate-[-1deg]")}>
        <p className="text-sm text-muted-foreground">{title}</p>
      </div>)}
      <Sheet className="md:rotate-[-0.5deg]" inner="p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-b pb-3">
          <div className="min-w-0"><p className="font-medium">Neraca Saldo</p><p className="text-xs text-muted-foreground">{evidence.reportEntity.name} · {month}</p></div>
          <div aria-hidden="true" className="flex shrink-0 gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground"><FileSpreadsheet className="size-3.5" />Excel</span>
            <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground"><FileText className="size-3.5" />PDF</span>
          </div>
        </div>
        <ul data-stagger className="divide-y">
          {[...source.lines].sort((a, b) => a.code.localeCompare(b.code)).map((line, index) => <li key={line.code} style={{ "--i": index } as React.CSSProperties} className="py-2.5">
            <div className="flex items-center gap-3 text-sm">
              <span className={cn("min-w-0 flex-1 truncate", line.code === "4100" && "drill")}><span className="num text-muted-foreground">{line.code}</span> {accountName(line.name)}</span>
              <Bar className="w-16 sm:w-20" /><Bar className="w-16 sm:w-20" />
            </div>
            {line.code === "4100" && <p className="mt-1.5 flex items-center gap-2 pl-10 text-xs text-muted-foreground"><svg aria-hidden="true" viewBox="0 0 16 12" className="h-3 w-4 shrink-0 text-primary" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"><path d="M1 0v6a4 4 0 0 0 4 4h10" /></svg><span className="truncate font-mono">{source.fileName} · baris {source.rowNumber}</span></p>}
          </li>)}
          <li style={{ "--i": 3 } as React.CSSProperties} className="flex items-center gap-3 py-3"><span className="text-sm text-muted-foreground">Akun lain</span><Bar className="ml-auto w-16 sm:w-20" /><Bar className="w-16 sm:w-20" /></li>
        </ul>
        <div className="flex flex-col gap-1 border-t border-foreground pt-3 sm:flex-row sm:items-baseline sm:justify-between">
          <span className="text-sm font-medium">Total</span>
          <span className="num text-sm font-medium"><CountUpOnView value={BigInt(trialBalance.debit)} currency="IDR" /> <span className="text-muted-foreground">=</span> <CountUpOnView value={BigInt(trialBalance.credit)} currency="IDR" /></span>
        </div>
        {balanced && <p className="mt-4 flex items-center gap-2 text-sm text-pass"><CheckDraw />Seimbang, dari jurnal yang dibukukan</p>}
      </Sheet>
    </div>
  </Reveal>;
}
