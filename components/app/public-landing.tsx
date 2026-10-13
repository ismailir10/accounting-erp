import Image from "next/image";
import { ArrowRight, ArrowUpRight, CircleAlert, CircleCheck, LockKeyhole } from "lucide-react";
import { PublicSiteFrame } from "@/components/app/public-site-frame";
import { PublicProductIllustration } from "@/components/app/public-product-illustration";
import { buttonVariants } from "@/components/ui/button-variants";
import { formatMoney } from "@/lib/money";
import { PUBLIC_BANK_COUNT, PUBLIC_BANK_COVERAGE, type PublicProductAsset, type PublicProductEvidence } from "@/lib/public-product";
import capture from "@/public/product/capture-manifest.json";

const product: PublicProductEvidence = capture;
const month = new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${product.period}-01T00:00:00Z`));
const demoLabel = "Data demonstrasi sintetis. Nama, rekening, dan angka rekaan.";
const amount = (value: string) => formatMoney(BigInt(value), "IDR");

function asset(file: string): PublicProductAsset {
  const found = product.assets.find((image) => image.file === `/product/${file}.webp`);
  if (!found) throw new Error(`Missing public product asset: ${file}`);
  return found;
}

const imageUrl = (image: PublicProductAsset) => `${image.file}?v=${image.sha256}`;

/** Saved genuine app views; the phone source is an independently captured readable view. */
function ProductImage({ name, mobileName = `${name}-mobile`, detailName, reportPreview = false, alt, caption }: { name: string; mobileName?: string; detailName?: string; reportPreview?: boolean; alt: string; caption: React.ReactNode }) {
  const desktop = asset(name);
  const mobile = asset(mobileName);
  const detail = detailName ? asset(detailName) : null;
  const totals = reportPreview ? asset("trial-balance-totals-mobile") : null;
  return <figure className="min-w-0">
    <div className="overflow-hidden rounded-xl border bg-card">
      <picture className={reportPreview ? "block overflow-hidden md:max-h-96" : undefined}>
        <source media="(max-width: 767px)" srcSet={imageUrl(mobile)} width={mobile.width} height={mobile.height} />
        <Image src={imageUrl(desktop)} alt={alt} width={desktop.width} height={desktop.height} sizes="(max-width: 767px) 100vw, (max-width: 1279px) 60vw, 760px" loading="lazy" className="block h-auto w-full" />
      </picture>
      {totals && <div className="hidden border-t py-3 md:block"><Image src={imageUrl(totals)} alt={totals.description} width={totals.width} height={totals.height} sizes="383px" loading="lazy" className="mx-auto block h-auto w-full max-w-sm" /></div>}
      {detail && <Image src={imageUrl(detail)} alt={detail.description} width={detail.width} height={detail.height} sizes="(max-width: 767px) 100vw, 660px" loading="lazy" className="block h-auto w-full border-t" />}
    </div>
    <figcaption className="mt-3 space-y-1 break-words text-xs leading-relaxed text-muted-foreground">
      <p>{caption}</p><p>{demoLabel}</p>
    </figcaption>
  </figure>;
}

function FullProductView({ name, mobileName, summary, alt, caption }: { name: string; mobileName: string; summary: string; alt: string; caption: React.ReactNode }) {
  const image = asset(name);
  const mobile = asset(mobileName);
  return <details className="mt-5 border-t pt-4">
    <summary className="cursor-pointer text-sm font-medium">{summary}</summary>
    <figure className="mt-4">
      <picture>
        <source media="(max-width: 767px)" srcSet={imageUrl(mobile)} width={mobile.width} height={mobile.height} />
        <Image src={imageUrl(image)} alt={alt} width={image.width} height={image.height} sizes="(max-width: 767px) 100vw, 660px" loading="lazy" className="h-auto w-full rounded-xl border bg-card" />
      </picture>
      <figcaption className="mt-3 text-xs leading-relaxed text-muted-foreground">{caption} {demoLabel}</figcaption>
    </figure>
  </details>;
}

function BankFormats() {
  const evidenceLabel = { REAL: "contoh file", PUBLISHED: "format terdokumentasi", INFERRED: "pola umum, belum contoh asli" };
  return <details id="bank-formats" className="mt-10 border-y py-5" data-testid="public-bank-formats">
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

export function PublicLanding() {
  const blocker = product.close.controls.find((control) => control.status !== "PASS");
  const reviewCount = product.close.controls.filter((control) => control.status !== "PASS").length;
  const passCount = product.close.controls.filter((control) => control.status === "PASS").length;
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
          {[
            { href: "#source-title", title: "Periksa sumber", detail: "Unggah rekening koran. Cek saldo dan file yang kurang." },
            { href: "#firm-title", title: "Review dan tutup buku", detail: "Putuskan usulan akun, catat penyesuaian, selesaikan temuan." },
            { href: "#company-title", title: "Susun laporan", detail: "Telusuri angka ke jurnal dan sumber. Unduh Excel atau PDF." },
          ].map((step, index) => <li key={step.href} className="flex items-start gap-3">
            <span aria-hidden="true" className="num pt-0.5 text-sm text-muted-foreground">0{index + 1}</span>
            <div><a href={step.href} className="drill inline-flex items-center gap-2 text-sm font-medium">{step.title}<ArrowRight className="size-4" aria-hidden="true" /></a><p className="mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">{step.detail}</p></div>
          </li>)}
        </ol>
      </nav>

      <section aria-labelledby="source-title" className="py-12 sm:py-20">
        <div className="grid items-end gap-6 lg:grid-cols-[1fr_0.8fr] lg:gap-24">
          <div><p className="eyebrow text-muted-foreground">Sumber dan jurnal</p><h2 id="source-title" className="display mt-4 max-w-lg text-[2rem] sm:text-5xl">Angka di laporan.<br />Baris yang membuktikan.</h2></div>
          <p className="max-w-lg text-base leading-relaxed text-muted-foreground">Dari laporan ke Buku Besar, jurnal, lalu baris bank. File, nomor baris dan keterangan asli tetap bisa dibuka.</p>
        </div>
        <div className="mt-10 grid items-start gap-6 md:grid-cols-2 md:gap-10">
          <div>
            <div className="mb-4 flex items-center justify-between gap-4 border-b pb-3"><p className="text-sm font-medium">Rekening koran</p><span className="eyebrow text-muted-foreground">Baris {product.source.rowNumber}</span></div>
            <ProductImage name="bank-source" alt={`Baris sumber rekening koran ${product.reportEntity.name} senilai ${amount(product.source.amount)}, dari ${product.source.fileName} baris ${product.source.rowNumber}.`} caption={<>{product.source.fileName} · {product.reportEntity.name} · {month}.</>} />
          </div>
          <div>
            <div className="mb-4 flex items-center justify-between gap-4 border-b pb-3"><p className="inline-flex items-center gap-2 text-sm font-medium"><ArrowRight className="size-4" aria-hidden="true" />Jurnal terkait</p><span className="eyebrow text-muted-foreground">Debit = kredit</span></div>
            <ProductImage name="journal" mobileName="journal-detail" alt={`Jurnal dari baris bank yang sama: debit ${amount(product.source.journalDebit)} sama dengan total kredit. Kode akun serta masing-masing nominal terlihat.`} caption={<>Jurnal terkait: {product.source.lines.map((line) => `${line.code} ${line.name}`).join("; ")}.</>} />
          </div>
        </div>
        <BankFormats />
      </section>

      <section aria-labelledby="firm-title" className="grid items-start gap-8 border-y py-12 sm:py-20 lg:grid-cols-[0.85fr_1.15fr] lg:gap-20">
        <div className="min-w-0">
          <p className="eyebrow text-muted-foreground">Untuk kantor akuntan</p>
          <h2 id="firm-title" className="display mt-4 text-[2rem] sm:text-5xl">Tiap klien.<br />Tiap bulan.<br />Sampai tuntas.</h2>
          <p className="mt-6 max-w-md text-base leading-relaxed text-muted-foreground">Semua klien dalam satu kantor. Akuntan meninjau usulan akun dan memeriksa temuan sebelum Tutup Buku.</p>
          <p className="mt-4 max-w-md text-base leading-relaxed text-muted-foreground">Aturan dan memori klien yang memenuhi pemeriksaan bisa membukukan transaksi langsung. Usulan AI menunggu persetujuan akuntan. Saldo yang cocok tetap perlu ditinjau bersama bukti transaksi.</p>
          <a href="/deck/kantor.html" className="drill mt-7 inline-flex items-center gap-2 text-sm">Baca deck kantor akuntan<ArrowUpRight className="size-4" aria-hidden="true" /></a>
        </div>
        <div className="min-w-0">
          <div className="flex items-start justify-between gap-4 border-b pb-5">
            <div><p className="eyebrow text-muted-foreground">Tutup Buku · {month}</p><p className="mt-2 text-lg">{product.client.name}</p></div>
            <LockKeyhole className="mt-1 size-5 text-muted-foreground" aria-hidden="true" />
          </div>
          <div className="mt-6 grid items-start gap-6 sm:grid-cols-[6.5rem_1fr]">
          <dl className="flex gap-10 sm:flex-col sm:gap-7">
            <div><dt className="flex items-center gap-2 text-sm text-review"><CircleAlert className="size-4" aria-hidden="true" />Perlu dicek</dt><dd className="display num mt-2 text-5xl">{reviewCount}</dd></div>
            <div><dt className="flex items-center gap-2 text-sm text-pass"><CircleCheck className="size-4" aria-hidden="true" />Lolos</dt><dd className="display num mt-2 text-5xl">{passCount}</dd></div>
          </dl>
          <div className="min-w-0 max-w-sm">
          <ProductImage name="close-blocker-detail" mobileName="close-blocker-detail" detailName="close-pass-detail" alt={`Kontrol Tutup Buku ${product.client.name} ${month}: temuan yang perlu diperiksa. Tampilan lengkap mencakup kontrol lolos dan daftar periksa akuntan.`} caption={<>Rincian {blocker?.scope}. Bulan belum bisa dikunci.</>} />
          </div>
          </div>
          <FullProductView name="close-checklist" mobileName="close-checklist-mobile" summary="Lihat daftar periksa lengkap" alt={`Daftar periksa lengkap Tutup Buku ${product.client.name} ${month}, termasuk temuan seluruh entitas, kontrol yang lolos dan persetujuan yang harus diisi akuntan.`} caption={<>{product.firm.name} · {product.client.name} · {month}, semua entitas. Rincian kontrol lolos dibuka untuk PT Ayam Nusantara.</>} />
        </div>
      </section>

      <section aria-labelledby="company-title" className="grid items-start gap-8 border-b py-12 sm:py-20 lg:grid-cols-[1.15fr_0.85fr] lg:gap-20">
        <div className="min-w-0 lg:col-start-2 lg:row-start-1">
          <p className="eyebrow text-muted-foreground">Untuk perusahaan</p>
          <h2 id="company-title" className="display mt-4 text-[2rem] sm:text-5xl">Laporan Anda.<br />Dari buku yang sama.</h2>
          <p className="mt-6 max-w-md text-base leading-relaxed text-muted-foreground">Rekening koran menjadi titik awal. Saldo awal, faktur, daftar aset dan penyesuaian melengkapi pembukuan sesuai kebutuhan klien. Tim keuangan atau kantor akuntan memeriksanya.</p>
          <p className="mt-4 max-w-md text-base leading-relaxed text-muted-foreground">Neraca Saldo, Laba Rugi dan Neraca berasal dari jurnal yang dibukukan. Unduh Excel atau PDF. Angka laporan bisa ditelusuri ke sumbernya.</p>
          <a href="/deck/perusahaan.html" className="drill mt-7 inline-flex items-center gap-2 text-sm">Baca deck perusahaan<ArrowUpRight className="size-4" aria-hidden="true" /></a>
        </div>
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <ProductImage name="trial-balance" mobileName="trial-balance-totals-mobile" reportPreview alt={`Cuplikan Neraca Saldo ${product.reportEntity.name} ${month}. Tampilan lengkap memuat seluruh akun dan total saldo debit dan kredit seimbang sebesar ${amount(product.trialBalance.debit)}.`} caption={<>{product.reportEntity.name} · {month}. Neraca Saldo dari jurnal yang sudah dibukukan; tampilan lengkap memuat seluruh akun dan total.</>} />
          <FullProductView name="trial-balance" mobileName="trial-balance-mobile" summary="Lihat Neraca Saldo lengkap" alt={`Daftar akun dan saldo debit kredit Neraca Saldo ${product.reportEntity.name} ${month}, termasuk total yang seimbang.`} caption={<>{product.reportEntity.name} · {month}.</>} />
        </div>
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
