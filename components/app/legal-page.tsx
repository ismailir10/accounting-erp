import Link from "next/link";
import { PublicSiteFrame } from "@/components/app/public-site-frame";
import { PublicContact } from "@/components/app/public-contact";
import { PUBLIC_LEGAL_DRAFT, PUBLIC_LEGAL_UPDATED, type PublicLegalDocument } from "@/lib/public-legal";

const CONTACT_ID = "kontak-pengelola";

export function LegalPage({ document }: { document: PublicLegalDocument }) {
  const contents = [...document.sections.map((section) => ({ id: section.id, title: section.title })), { id: CONTACT_ID, title: "Hubungi pengelola" }];
  return <PublicSiteFrame>
    <article className="page-settle mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-16" aria-labelledby="legal-title">
      <div className="mb-8 max-w-3xl rounded-xl border border-review/30 bg-review-subtle p-4 text-sm leading-relaxed" role="note">
        <p className="font-medium text-review">Draf ketentuan</p>
        <p className="mt-1">{PUBLIC_LEGAL_DRAFT}</p>
      </div>
      <div className="max-w-3xl">
        <h1 id="legal-title" className="display text-4xl sm:text-5xl">{document.title}</h1>
        <p className="mt-3 text-sm text-muted-foreground">Diperbarui <time dateTime={PUBLIC_LEGAL_UPDATED.iso}>{PUBLIC_LEGAL_UPDATED.label}</time></p>
        <p className="mt-6 text-lg leading-relaxed text-muted-foreground">{document.introduction}</p>
      </div>
      <div className="mt-10 grid gap-10 lg:grid-cols-[15rem_minmax(0,48rem)] lg:gap-16">
        <nav aria-label="Isi halaman" className="lg:sticky lg:top-8 lg:self-start">
          <p className="eyebrow text-muted-foreground">Isi halaman</p>
          <ol className="mt-3 space-y-2 border-l pl-4 text-sm">
            {contents.map((item) => <li key={item.id}><a href={`#${item.id}`} className="text-muted-foreground hover:text-foreground focus-visible:text-foreground">{item.title}</a></li>)}
          </ol>
        </nav>
        <div className="min-w-0 space-y-9">
          {document.sections.map((section) => <section key={section.id} aria-labelledby={section.id} className="scroll-mt-8">
            <h2 id={section.id} className="text-xl font-medium">{section.title}</h2>
            <div className="mt-3 space-y-3 text-base leading-7">
              {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            </div>
          </section>)}
          <section aria-labelledby={CONTACT_ID} className="scroll-mt-8">
            <h2 id={CONTACT_ID} className="text-xl font-medium">Hubungi pengelola</h2>
            <p className="mt-3 text-base leading-7">Untuk pertanyaan tentang uji coba, dukungan, atau permintaan terkait data: <PublicContact />.</p>
          </section>
          <div className="border-t pt-6 text-sm"><Link href={document.relatedHref} className="drill">{document.relatedLabel}</Link></div>
        </div>
      </div>
    </article>
  </PublicSiteFrame>;
}
