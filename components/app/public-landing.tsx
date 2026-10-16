import { ArrowRight, ArrowUpRight, FileChartColumn, FileText, ListChecks } from "lucide-react";
import { PublicSiteFrame } from "@/components/app/public-site-frame";
import { PublicProductIllustration } from "@/components/app/public-product-illustration";
import { CloseChecklistIllustration, ReportStackIllustration, SourceToJournalIllustration } from "@/components/app/public-illustrations";
import { buttonVariants } from "@/components/ui/button-variants";
import { PUBLIC_BANK_COUNT, PUBLIC_BANK_COVERAGE, type PublicProductEvidence } from "@/lib/public-product";
import capture from "@/public/product/capture-manifest.json";

const product: PublicProductEvidence = capture;
const demoLabel = "Ilustrasi dari data demonstrasi sintetis. Nama, rekening, dan angka rekaan.";

function Caption({ children }: { children?: React.ReactNode }) {
  return <p className="mt-4 text-xs leading-relaxed text-muted-foreground">{children ? <>{children} </> : null}{demoLabel}</p>;
}

function BankFormats() {
  const evidenceLabel = { REAL: "contoh file", PUBLISHED: "format terdokumentasi", INFERRED: "pola umum, belum contoh asli" };
  return <details id="bank-formats" className="mt-12 border-y py-5" data-testid="public-bank-formats">
    <summary className="cursor-pointer text-sm font-medium">Bank dan format yang dikenali ({PUBLIC_BANK_COUNT} bank)</summary>
    <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted-foreground">Dukungan berlaku untuk format berikut, bukan semua file dari bank yang sama. Rekening Rupiah dalam PDF, CSV, Excel dan MT940 dibaca sesuai tata letaknya. Sebagian format mengikuti pola umum dan belum diuji dengan contoh asli dari bank; file yang berbeda perlu diperiksa saat diimpor. Yang masuk adalah file yang Anda unggah.</p>
    <dl className="mt-5 divide-y">
      {PUBLIC_BANK_COVERAGE.map((bank) => <div key={bank.code} className="grid gap-2 py-3 sm:grid-cols-[11rem_1fr]">
        <dt className="text-sm font-medium">{bank.name}</dt>
        <dd className="text-sm leading-relaxed text-muted-foreground">{bank.formats.map((format, index) => <span key={format.label}>{index > 0 && "; "}{format.label} ({evidenceLabel[format.evidence]})</span>)}</dd>
      </div>)}
    </dl>
  </details>;
}

const STEPS = [
  { href: "#source-title", icon: FileText, title: "Periksa sumber", detail: "Unggah rekening koran. Cek saldo dan file yang kurang." },
  { href: "#firm-title", icon: ListChecks, title: "Review dan tutup buku", detail: "Putuskan usulan akun, catat penyesuaian, selesaikan temuan." },
  { href: "#company-title", icon: FileChartColumn, title: "Susun laporan", detail: "Telusuri angka ke jurnal dan sumber. Unduh Excel atau PDF." },
];

export function PublicLanding() {
  return <PublicSiteFrame>
    <div className="mx-auto max-w-7xl px-5 sm:px-8">
      <section aria-labelledby="landing-title" className="pb-10 pt-12 sm:pb-14 sm:pt-16">
        <div className="grid items-center gap-8 lg:grid-cols-[1.15fr_0.85fr] lg:gap-6">
          <div className="min-w-0">
            <p className="eyebrow text-muted-foreground">Tutup buku bulanan untuk kantor akuntan di Indonesia</p>
            <h1 id="landing-title" className="public-headline display mt-6 max-w-2xl text-[2.8rem] text-balance sm:text-[3.8rem] xl:text-[4rem]">Dari rekening koran ke laporan keuangan.</h1>
            <p className="mt-7 max-w-lg text-lg leading-relaxed text-muted-foreground">Buku membantu memeriksa file klien, transaksi dan selisih. Akuntan melengkapi saldo awal serta penyesuaian, meninjau usulan AI, lalu menutup bulan dengan laporan yang bisa ditelusuri.</p>
            <div className="mt-8 flex flex-wrap items-center gap-4"><a href="/daftar" className={buttonVariants({ size: "lg" })}>Minta akses uji coba<ArrowUpRight aria-hidden="true" /></a><a href="/deck" className="drill inline-flex items-center gap-2 text-sm">Lihat deck<ArrowRight className="size-4" aria-hidden="true" /></a></div>
          </div>
          <PublicProductIllustration evidence={product} />
        </div>
      </section>

      <nav aria-label="Alur pembukuan" className="border-y py-6 sm:py-8">
        <ol className="grid gap-6 sm:grid-cols-3 sm:gap-8">
          {STEPS.map((step, index) => <li key={step.href} className="flex items-start gap-4">
            <span aria-hidden="true" className="icon-tile size-10"><step.icon className="size-5" /></span>
            <div className="min-w-0">
              <p className="num text-xs text-muted-foreground">Langkah {index + 1}</p>
              <a href={step.href} className="drill mt-1 inline-flex items-center gap-2 text-sm font-medium">{step.title}<ArrowRight className="size-4" aria-hidden="true" /></a>
              <p className="mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">{step.detail}</p>
            </div>
          </li>)}
        </ol>
      </nav>

      <section aria-labelledby="source-title" className="py-12 sm:py-20">
        <div className="grid items-end gap-6 lg:grid-cols-[1fr_0.8fr] lg:gap-24">
          <div><p className="eyebrow text-muted-foreground">Sumber dan jurnal</p><h2 id="source-title" className="display mt-4 max-w-lg text-[2rem] sm:text-5xl">Angka di laporan.<br />Baris yang membuktikan.</h2></div>
          <p className="max-w-lg text-base leading-relaxed text-muted-foreground">Setiap jurnal menyimpan file dan nomor baris bank asalnya. Dari laporan ke Buku Besar, jurnal, lalu baris bank, dan keterangan aslinya tetap bisa dibuka.</p>
        </div>
        <figure className="mt-12">
          <SourceToJournalIllustration evidence={product} />
          <figcaption><Caption>{product.reportEntity.name} · {product.source.fileName}.</Caption></figcaption>
        </figure>
        <BankFormats />
      </section>

      <section aria-labelledby="firm-title" className="grid items-center gap-10 border-y py-12 sm:py-20 lg:grid-cols-[0.85fr_1.15fr] lg:gap-20">
        <div className="min-w-0">
          <p className="eyebrow text-muted-foreground">Untuk kantor akuntan</p>
          <h2 id="firm-title" className="display mt-4 text-[2rem] sm:text-5xl">Tiap klien.<br />Tiap bulan.<br />Sampai tuntas.</h2>
          <p className="mt-6 max-w-md text-base leading-relaxed text-muted-foreground">Semua klien dalam satu kantor. Akuntan meninjau usulan akun dan memeriksa temuan sebelum Tutup Buku.</p>
          <p className="mt-4 max-w-md text-base leading-relaxed text-muted-foreground">Aturan dan memori klien yang memenuhi pemeriksaan bisa membukukan transaksi langsung. Usulan AI menunggu persetujuan akuntan. Bulan baru bisa dikunci setelah temuan selesai.</p>
          <a href="/deck/kantor.html" className="drill mt-7 inline-flex items-center gap-2 text-sm">Baca deck kantor akuntan<ArrowUpRight className="size-4" aria-hidden="true" /></a>
        </div>
        <figure className="min-w-0">
          <CloseChecklistIllustration evidence={product} />
          <figcaption><Caption>{product.firm.name} · {product.client.name}.</Caption></figcaption>
        </figure>
      </section>

      <section aria-labelledby="company-title" className="grid items-center gap-10 border-b py-12 sm:py-20 lg:grid-cols-[1.15fr_0.85fr] lg:gap-20">
        <div className="min-w-0 lg:col-start-2 lg:row-start-1">
          <p className="eyebrow text-muted-foreground">Untuk perusahaan</p>
          <h2 id="company-title" className="display mt-4 text-[2rem] sm:text-5xl">Laporan Anda.<br />Dari buku yang sama.</h2>
          <p className="mt-6 max-w-md text-base leading-relaxed text-muted-foreground">Rekening koran menjadi titik awal. Saldo awal, faktur, daftar aset dan penyesuaian melengkapi pembukuan sesuai kebutuhan klien. Tim keuangan atau kantor akuntan memeriksanya.</p>
          <p className="mt-4 max-w-md text-base leading-relaxed text-muted-foreground">Neraca Saldo, Laba Rugi dan Neraca berasal dari jurnal yang dibukukan. Unduh Excel atau PDF. Angka laporan bisa ditelusuri ke sumbernya.</p>
          <a href="/deck/perusahaan.html" className="drill mt-7 inline-flex items-center gap-2 text-sm">Baca deck perusahaan<ArrowUpRight className="size-4" aria-hidden="true" /></a>
        </div>
        <figure className="min-w-0 lg:col-start-1 lg:row-start-1">
          <ReportStackIllustration evidence={product} />
          <figcaption><Caption /></figcaption>
        </figure>
      </section>

      <section aria-labelledby="trial-title" className="grid items-end gap-8 py-12 sm:py-24 md:grid-cols-[1fr_auto] md:gap-20">
        <div className="max-w-2xl"><p className="eyebrow text-muted-foreground">Mulai dari satu klien</p><h2 id="trial-title" className="display mt-4 text-[2rem] sm:text-5xl">Satu bulan dulu.<br />Lihat sendiri jejaknya.</h2>
          <p className="mt-5 max-w-lg text-base leading-relaxed text-muted-foreground">Uji kecocokan format, hasil pembacaan dan alur review pada satu bulan pembukuan sebelum menambah klien.</p>
          <ul aria-label="Bahan uji coba" className="mt-6 space-y-3 text-sm leading-relaxed">
            <li><strong className="font-medium">Rekening koran satu bulan</strong><span className="text-muted-foreground"> · seluruh rekening usaha klien.</span></li>
            <li><strong className="font-medium">Saldo awal</strong><span className="text-muted-foreground"> · dari neraca atau Neraca Saldo terakhir.</span></li>
            <li><strong className="font-medium">Dokumen pendukung</strong><span className="text-muted-foreground"> · faktur, daftar aset dan penyesuaian yang perlu ditinjau.</span></li>
          </ul>
          <p className="mt-6 max-w-lg text-sm leading-relaxed text-muted-foreground">Tim Buku meninjau permintaan, lalu mengirim undangan. Baca <a href="/syarat" className="drill">Syarat</a> dan <a href="/kebijakan-privasi" className="drill">Privasi</a>, termasuk akses dukungan dan pemrosesan data.</p>
        </div>
        <a href="/daftar" className={buttonVariants({ size: "lg", className: "justify-self-start md:mb-1" })}>Minta akses uji coba<ArrowUpRight aria-hidden="true" /></a>
      </section>
    </div>
  </PublicSiteFrame>;
}
