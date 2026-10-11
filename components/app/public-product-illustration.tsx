import { CheckDraw } from "@/components/motion/check-draw";
import type { PublicProductEvidence } from "@/lib/public-product";

/** Original paper-and-ledger artwork; accounting details follow the captured demo. */
export function PublicProductIllustration({ evidence }: { evidence: PublicProductEvidence }) {
  const month = new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${evidence.period}-01T00:00:00Z`));
  const balanced = BigInt(evidence.source.journalDebit) === BigInt(evidence.source.journalCredit);
  const accounts = evidence.source.lines.map((line) => ({ code: line.code, name: line.name.replace(/\s*\([^)]*\)$/, "") }));
  const label = `Ilustrasi alur rekening koran ${evidence.source.fileName} baris ${evidence.source.rowNumber}, menjadi jurnal lalu laporan ${evidence.reportEntity.name} untuk ${month}. Angka laporan dapat ditelusuri ke baris sumber.`;

  return <figure className="page-settle min-w-0">
    <svg viewBox="0 0 640 425" role="img" aria-label={label} focusable="false" className="mx-auto h-auto w-full overflow-visible">
      <title>Rekening koran, Buku Besar, laporan keuangan</title>
      <desc>{label} Bentuk dokumen adalah ilustrasi; tampilan aplikasi asli tersedia di halaman ini.</desc>

      {/* Return line: report to bank row, rather than an invented financial trend. */}
      <path d="M559 157C578 42 174-21 70 118" fill="none" stroke="var(--primary)" strokeWidth="1.5" strokeDasharray="3 6" />
      <path d="m70 107 0 11 11-4" fill="none" stroke="var(--primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <text x="76" y="39" fill="var(--muted-foreground)" fontSize="21">Telusuri ke sumber</text>

      {/* A perforated bank statement sits behind the bound ledger. */}
      <g transform="rotate(-9 120 236)">
        <path d="M43 119h166v229H43Z" fill="var(--muted)" stroke="var(--border)" />
        <path d="M35 110h166v237l-8-5-8 5-8-5-8 5-8-5-8 5-8-5-8 5-8-5-8 5-8-5-8 5-8-5-8 5-8-5-8 5-8-5-8 5-8-5-6 5Z" fill="var(--card)" stroke="var(--border)" strokeWidth="1.25" />
        <path d="M50 130h3m5 0h3m5 0h3M50 309h135" stroke="var(--muted-foreground)" strokeWidth="1.25" />
        <text x="51" y="159" fill="var(--foreground)" fontSize="20" fontWeight="500">Rekening</text>
        <text x="51" y="182" fill="var(--foreground)" fontSize="20" fontWeight="500">koran</text>
        <path d="M51 199h134M51 217h97M51 285h134M51 299h83" stroke="var(--border)" strokeWidth="1.2" />
        <rect x="45" y="231" width="146" height="37" rx="2" fill="var(--primary-subtle)" />
        <circle cx="60" cy="249" r="3" fill="var(--primary)" />
        <text x="72" y="256" fill="var(--foreground)" fontSize="21">Baris {evidence.source.rowNumber}</text>
        <text x="51" y="331" fill="var(--muted-foreground)" fontSize="20">Sumber bank</text>
      </g>

      {/* A dominant ledger, with a dark binding and fine neutral page edges. */}
      <g transform="rotate(-3 331 224)">
        <path d="M194 66h269q9 0 9 9v301q0 9-9 9H194q-10 0-10-10V77q0-11 10-11Z" fill="var(--foreground)" />
        <path d="M203 62h264v313H203Z" fill="var(--muted)" stroke="var(--border)" />
        <path d="M207 61v311h257M210 59v310h254M214 57v309h250" fill="none" stroke="var(--card)" strokeWidth="1.5" />
        <path d="M216 53h251v310H216q-17 0-17-17V70q0-17 17-17Z" fill="var(--card)" stroke="var(--border)" strokeWidth="1.2" />
        <path d="M213 55v304" stroke="var(--border)" strokeWidth="1.2" />
        <path d="M220 58v297" stroke="var(--muted)" strokeWidth="2" />
        <text x="235" y="88" fill="var(--muted-foreground)" fontSize="19">Jurnal dari sumber</text>
        <text x="235" y="125" fill="var(--foreground)" fontSize="32" fontWeight="500" letterSpacing="-0.8">Buku Besar</text>
        <path d="M236 143h208" stroke="var(--foreground)" strokeWidth="1.25" />
        <text x="236" y="171" fill="var(--muted-foreground)" fontSize="19">Kode</text>
        <text x="300" y="171" fill="var(--muted-foreground)" fontSize="19">Akun</text>
        {accounts.map((account, index) => <g key={account.code}>
          <path d={`M236 ${215 + index * 37}h208`} stroke="var(--border)" />
          <text x="236" y={204 + index * 37} fill="var(--foreground)" fontSize="22" className="num">{account.code}</text>
          <text x="300" y={204 + index * 37} fill="var(--foreground)" fontSize="20">{account.name}</text>
        </g>)}
        <path d="M236 307h133" stroke="var(--border)" />
        <text x="236" y="335" fill="var(--muted-foreground)" fontSize="19">{month}</text>
        <path d="M186 96h10M186 132h10M186 168h10M186 204h10M186 240h10M186 276h10M186 312h10M186 348h10" stroke="var(--card)" strokeWidth="1.2" />
        <path d="M191 76v288" stroke="var(--card)" strokeOpacity="0.3" />
      </g>

      {/* Folded report; overlap is restricted to the ledger margin. */}
      <g transform="rotate(8 546 273)">
        <path d="M461 158h139l29 29v196H461Z" fill="var(--muted)" stroke="var(--border)" strokeWidth="1.2" />
        <path d="M455 152h139l29 29v196H455Z" fill="var(--card)" stroke="var(--border)" strokeWidth="1.25" strokeLinejoin="round" />
        <path d="M594 152v29h29" fill="var(--muted)" stroke="var(--border)" strokeWidth="1.25" />
        <text x="473" y="205" fill="var(--foreground)" fontSize="24" fontWeight="500">Laporan</text>
        <path d="M473 219h132" stroke="var(--foreground)" strokeWidth="1.2" />
        <text x="473" y="247" fill="var(--foreground)" fontSize="21">Neraca Saldo</text>
        <text x="473" y="281" fill="var(--foreground)" fontSize="21">Laba Rugi</text>
        <text x="473" y="315" fill="var(--foreground)" fontSize="21">Neraca</text>
        <path d="M473 257h97M473 291h97M473 325h57" stroke="var(--border)" />
        <circle cx="585" cy="348" r="12" fill="none" stroke="var(--foreground)" strokeWidth="1.1" />
        <text x="585" y="354" textAnchor="middle" fill="var(--foreground)" fontSize="17" fontWeight="500">B</text>
      </g>
      <path d="M464 117c33-1 62 7 66 29m-6-6 6 6 5-7" fill="none" stroke="var(--primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
    <figcaption className="mt-1 space-y-2 text-xs leading-relaxed text-muted-foreground">
      <p>Ilustrasi alur berdasarkan data demo sintetis.</p>
      <p className="break-words">{evidence.reportEntity.name} · {month}.</p>
      {balanced && <p className="flex items-start gap-2"><CheckDraw className="mt-0.5 text-pass" /><span>Jurnal sumber seimbang. Total debit dan kredit sama.</span></p>}
    </figcaption>
  </figure>;
}
