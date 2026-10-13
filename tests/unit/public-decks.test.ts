import { readFile } from "node:fs/promises";
import { extractLinks, extractText } from "unpdf";
import { describe, expect, it } from "vitest";

describe("downloadable public decks", () => {
  it.each(["kantor", "perusahaan"])("%s PDF has one page per slide and the current access request", async (deck) => {
    const html = await readFile(`public/deck/${deck}.html`, "utf8");
    const name = deck === "kantor" ? "kantor-akuntan" : deck;
    const bytes = await readFile(`public/deck/buku-${name}.pdf`);
    const { totalPages, text } = await extractText(new Uint8Array(bytes), { mergePages: true });
    expect(totalPages).toBe(html.match(/<section class="slide\b/g)?.length);
    expect(text).toContain("Minta akses uji coba");
    expect(text).toContain("ditinjau");
    expect(text).not.toContain("Buku mengerjakan sisanya");
  });

  it.each(["kantor-akuntan", "perusahaan"])("%s PDF annotations point to the public site", async (deck) => {
    const bytes = await readFile(`public/deck/buku-${deck}.pdf`);
    const { links } = await extractLinks(new Uint8Array(bytes));
    const origin = "https://native-erp-v2.vercel.app";
    expect(new Set(links)).toEqual(new Set([
      `${origin}/deck`,
      `${origin}/#bank-formats`,
      `${origin}/kebijakan-privasi`,
      `${origin}/daftar`,
    ]));
    for (const link of links) {
      const url = new URL(link);
      // Requiring the canonical HTTPS origin also rejects localhost, loopback,
      // private IPs, internal hosts and the export server's temporary port.
      expect(url.origin).toBe(origin);
      expect(url.username).toBe("");
      expect(url.password).toBe("");
    }
  });
});
