import { readFile } from "node:fs/promises";
import { extractText } from "unpdf";
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
});
