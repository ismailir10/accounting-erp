// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LegalPage } from "@/components/app/legal-page";
import { PUBLIC_PRIVACY, PUBLIC_TERMS } from "@/lib/public-legal";

// The server-only contact and frame are verified separately; exercise the real legal renderer and content here.
vi.mock("@/components/app/public-site-frame", () => ({ PublicSiteFrame: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/components/app/public-contact", () => ({ PublicContact: () => createElement("span", null, "Hubungi pengelola Buku") }));

const pages = [{ name: "Terms", document: PUBLIC_TERMS }, { name: "Privacy", document: PUBLIC_PRIVACY }];
const render = (legalDocument: typeof PUBLIC_TERMS) => {
  const dom = document.implementation.createHTMLDocument();
  dom.body.innerHTML = renderToStaticMarkup(createElement(LegalPage, { document: legalDocument }));
  return dom;
};

describe.each(pages)("public $name", ({ document }) => {
  it("opens with the draft notice, a readable dated title, and its related legal destination", () => {
    const dom = render(document);
    const article = dom.querySelector("article")!;
    expect(article.firstElementChild?.getAttribute("role")).toBe("note");
    expect(article.firstElementChild?.textContent).toContain("Draf");
    expect(dom.querySelector("h1")?.textContent).toBe(document.title);
    expect(dom.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-11");
    expect(dom.querySelector("time")?.textContent).toBe("11 Oktober 2026");
    expect(dom.querySelector(`a[href='${document.relatedHref}']`)?.textContent).toBe(document.relatedLabel);
  });

  it("discloses trial data, actual expiry behaviour, retention and quiet support access on each page", () => {
    const dom = render(document);
    const section = (id: string) => dom.getElementById(id)?.parentElement?.textContent;
    expect(section("permintaan-uji-coba")).toMatch(/nama, email kerja, nama organisasi, dan jenis organisasi/);
    expect(section("permintaan-uji-coba")).toMatch(/WhatsApp dan catatan bersifat opsional/);
    expect(section("permintaan-uji-coba")).toMatch(/alamat IP/);
    expect(section("permintaan-uji-coba")).toMatch(/Catatan permintaan terpisah/);
    expect(section("akses-uji-coba")).toMatch(/membaca data dan mengunduh laporan/);
    expect(section("akses-uji-coba")).toMatch(/Perubahan data dan penggunaan AI tidak tersedia/);
    expect(section("akses-uji-coba")).toMatch(/dicabut atau organisasi ditangguhkan/);
    expect(section("penyimpanan-data")).toMatch(/belum ada penghapusan terjadwal/);
    expect(section("penyimpanan-data")).toMatch(/satu jam.*tidak menghapus catatan/);
    expect(section("penyimpanan-data")).toMatch(/kewajiban penyimpanan hukum atau akuntansi/);
    expect(section("akses-dukungan")).toMatch(/mode hanya baca/);
    expect(section("akses-dukungan")).toMatch(/60 menit.*verifikasi dua langkah.*alasan yang dicatat/);
    expect(section("akses-dukungan")).toMatch(/tidak diberi pemberitahuan setiap kali/);
    expect(section("akses-dukungan")).toMatch(/sesi, halaman yang dibuka, dan unduhan/);
    expect(section("akses-dukungan")).toMatch(/bukan ditampilkan sebagai riwayat aktivitas organisasi/);
    expect(section("kontak-pengelola")).toContain("Hubungi pengelola Buku");
    expect(dom.body.textContent).not.toMatch(/Supabase|Anthropic|OpenAI|OpenCode|Vercel/);
  });

  it("labels every reading section with a unique visible heading", () => {
    const dom = render(document);
    const ids = Array.from(dom.querySelectorAll("[id]"), (element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const section of dom.querySelectorAll("section")) {
      const heading = dom.getElementById(section.getAttribute("aria-labelledby")!);
      expect(heading?.tagName).toBe("H2");
      expect(heading?.textContent?.trim()).toBeTruthy();
    }
  });
});

describe("public Privacy AI and rights disclosures", () => {
  it("distinguishes each task's payload and avoids extending classification limits to all AI", () => {
    const dom = render(PUBLIC_PRIVACY);
    const paragraphs = Array.from(dom.getElementById("pemrosesan-ai")!.parentElement!.querySelectorAll("p"), (p) => p.textContent ?? "");
    const classification = paragraphs.find((p) => p.startsWith("Klasifikasi"))!;
    expect(classification).toMatch(/80 karakter.*arah.*jenis usaha.*kode\/nama akun/);
    expect(classification).toMatch(/Kolom nominal transaksi dan saldo tidak dikirim untuk tugas klasifikasi ini/);
    expect(classification).toMatch(/tetap dapat memuat angka atau identitas rekening/);
    expect(paragraphs.find((p) => p.startsWith("Pemetaan"))).toMatch(/kode dan nama akun sumber/);
    expect(paragraphs.find((p) => p.startsWith("Analisis"))).toMatch(/kutipan dokumen yang dibatasi.*pertanyaan.*konteks entitas\/periode/);
    expect(paragraphs.find((p) => p.startsWith("Penjelasan"))).toMatch(/baris terkait beserta nominal.*fakta naratif yang dihitung/);
    expect(paragraphs.find((p) => p.startsWith("Baca scan"))).toMatch(/mati kecuali Buku menyalakannya.*gambar halaman.*nominal, saldo/);
    // ADR 0018: Unggah remembers PDF passwords per client; the other import paths still don't.
    expect(paragraphs.find((p) => p.startsWith("Baca scan"))).toMatch(/tidak pernah dikirim ke penyedia AI.*disimpan terenkripsi untuk klien itu saja.*admin dapat menghapusnya.*cara impor lain.*tidak disimpan/);
    expect(paragraphs.join(" ")).toMatch(/tidak ada jaminan bahwa semua nominal atau identitas rekening selalu tinggal di Buku/);
  });

  it("separates Singapore hosting from provider processing and explains qualified UU PDP rights", () => {
    const dom = render(PUBLIC_PRIVACY);
    const hosting = dom.getElementById("lokasi-dan-pihak-ketiga")!.parentElement!.textContent;
    expect(hosting).toMatch(/Server aplikasi dan basis data.*Singapura/);
    expect(hosting).toMatch(/tidak dijamin seluruhnya berlangsung di Singapura/);
    expect(hosting).toMatch(/tidak menjanjikan jangka retensi penyedia, larangan penggunaan untuk pelatihan, atau sertifikasi/);
    const rights = dom.getElementById("hak-data-pribadi")!.parentElement!.textContent;
    expect(rights).toMatch(/UU PDP.*akses dan salinan data.*mengoreksi.*menarik persetujuan.*keberatan.*penghapusan data/);
    expect(rights).toMatch(/kewajiban penyimpanan hukum atau akuntansi membatasi penghapusan/);
    expect(dom.getElementById("tujuan-dan-dasar")!.parentElement!.textContent).toMatch(/pelaksanaan perjanjian.*kepentingan sah.*kewajiban hukum.*Persetujuan/);
  });
});
