// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PublicLanding } from "@/components/app/public-landing";
import { formatMoney } from "@/lib/money";
import { PUBLIC_BANK_COUNT, PUBLIC_BANK_COVERAGE } from "@/lib/public-product";
import capture from "@/public/product/capture-manifest.json";
import headlineFont from "@/app/fonts/hanken-grotesk-headline-450.json";

vi.mock("@/components/app/public-site-frame", () => ({ PublicSiteFrame: ({ children }: { children: React.ReactNode }) => children }));
const render = () => {
  const dom = document.implementation.createHTMLDocument();
  dom.body.innerHTML = renderToStaticMarkup(createElement(PublicLanding));
  return dom;
};

describe("public product page", () => {
  it("keeps every headline character in the pinned display font", async () => {
    const text = render().querySelector("h1")!.textContent!;
    const bytes = await readFile(join(process.cwd(), "app/fonts", headlineFont.file));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(headlineFont.sha256);
    const css = await readFile(join(process.cwd(), "app/globals.css"), "utf8");
    const embedded = css.match(/data:font\/woff2;base64,([A-Za-z0-9+/=]+)/)![1];
    expect(Buffer.from(embedded, "base64")).toEqual(bytes);
    for (const character of text) expect(headlineFont.codepoints).toContain(character.codePointAt(0));
    expect(headlineFont.weight).toBe(450);
  });

  it("renders the actual bank claims and qualifies inferred formats", () => {
    const dom = render();
    const disclosure = dom.querySelector("[data-testid='public-bank-formats']")!;
    expect(disclosure.querySelector("summary")?.textContent).toContain(`(${PUBLIC_BANK_COUNT} bank)`);
    expect(disclosure.textContent).toContain("bukan semua file dari bank yang sama");
    expect(disclosure.textContent).toContain("Rekening Rupiah");
    const rows = [...disclosure.querySelectorAll("dl > div")];
    expect(rows).toHaveLength(PUBLIC_BANK_COVERAGE.length);
    for (const claim of PUBLIC_BANK_COVERAGE) {
      const row = rows.find((entry) => entry.querySelector("dt")?.textContent === claim.name)!;
      for (const format of claim.formats) expect(row.querySelector("dd")?.textContent).toContain(format.label);
      if (claim.formats.some((format) => format.evidence === "INFERRED")) expect(row.textContent).toContain("pola umum, belum contoh asli");
    }
  });

  it("draws the three product sections from the verified demo instead of shipping screenshots", () => {
    const dom = render();
    expect(dom.querySelectorAll("h1")).toHaveLength(1);
    expect(dom.querySelector("h1")?.textContent).toBe("Dari rekening koran ke laporan keuangan.");
    expect(dom.querySelectorAll("img, picture")).toHaveLength(0);
    const hero = dom.querySelector("svg[role='img']")!;
    expect(hero.getAttribute("aria-label")).toContain(`${capture.source.fileName} baris ${capture.source.rowNumber}`);
    expect(hero.closest("figure")?.querySelector("figcaption")?.textContent).toContain("Ilustrasi alur berdasarkan data demo sintetis");

    const drawing = (title: string) => dom.querySelector(`#${title}`)!.closest("section")!.querySelector("figure [role='img']")!;
    const caption = (title: string) => dom.querySelector(`#${title}`)!.closest("section")!.querySelector("figure figcaption")!.textContent;
    for (const title of ["source-title", "firm-title", "company-title"]) {
      expect(drawing(title)).not.toBeNull();
      expect(caption(title)).toContain("Ilustrasi dari data demonstrasi sintetis");
    }

    const amount = (value: string) => formatMoney(BigInt(value), "IDR", { bare: true });
    const source = drawing("source-title");
    expect(source.getAttribute("aria-label")).toContain(`baris ${capture.source.rowNumber} rekening koran ${capture.source.fileName}`);
    expect(source.textContent).toContain(`Baris ${capture.source.rowNumber}`);
    expect(source.textContent).toContain(capture.source.description);
    for (const line of capture.source.lines) {
      expect(source.textContent).toContain(line.code);
      for (const value of [line.debit, line.credit].filter((v) => v !== "0")) expect(source.textContent).toContain(amount(value));
    }
    expect(source.textContent).toContain("Debit = kredit");

    const close = drawing("firm-title");
    const problems = capture.close.controls.filter((control) => control.status !== "PASS");
    const passes = capture.close.controls.filter((control) => control.status === "PASS");
    expect(close.getAttribute("aria-label")).toContain(`${problems.length} kontrol perlu dicek dan ${passes.length} lolos`);
    for (const control of problems.slice(0, 4)) expect(close.textContent).toContain(control.title);
    expect(close.textContent).toContain(`${passes.length} kontrol lolos`);

    const report = drawing("company-title");
    expect(report.textContent).toContain(`Rp ${amount(capture.trialBalance.debit)}`);
    expect(report.textContent).toContain(`${capture.source.fileName} · baris ${capture.source.rowNumber}`);

    expect(dom.body.textContent).not.toContain("—");
    expect(dom.body.textContent).not.toMatch(/Supabase|Anthropic|OpenAI|OpenCode|Vercel|revolusioner|powered by AI/);
  });

  it("ships no screenshot files and no screenshot entries in the evidence manifest", async () => {
    expect("assets" in capture).toBe(false);
    const files = await readdir(join(process.cwd(), "public/product"));
    expect(files.filter((file) => /\.(webp|png|jpe?g)$/.test(file))).toEqual([]);
  });
});
