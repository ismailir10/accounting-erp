import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import PDFDocument from "pdfkit";
import { encodePng } from "@/lib/ocr/png";
import { OcrError, pageImages, sniffImageFile } from "@/lib/ocr/pages";
import { proveRows, type OcrRow } from "@/lib/ocr/prove";

const pdfOf = (draw: (doc: PDFKit.PDFDocument) => void) =>
  new Promise<Buffer>((resolve) => {
    const doc = new PDFDocument();
    const parts: Buffer[] = [];
    doc.on("data", (b: Buffer) => parts.push(b));
    doc.on("end", () => resolve(Buffer.concat(parts)));
    draw(doc);
    doc.end();
  });

describe("page images", () => {
  it("encodes pixels as a PNG that decodes back", () => {
    const px = new Uint8Array([10, 20, 30, 40, 50, 60]); // 2×1 RGB
    const png = encodePng(2, 1, 3, px);
    expect(sniffImageFile(png)).toBe("PNG");
    const idat = png.subarray(png.indexOf("IDAT") + 4, png.indexOf("IEND") - 8);
    expect([...inflateSync(idat)]).toEqual([0, 10, 20, 30, 40, 50, 60]);
  });

  it("takes each page's embedded image out of a scanned PDF and never sends a PDF with text", async () => {
    const img = encodePng(40, 20, 1, new Uint8Array(800).fill(128));
    const scan = await pdfOf((doc) => doc.image(img, 10, 10, { width: 400 }));
    const pages = await pageImages(scan);
    expect(pages).toHaveLength(1);
    expect(pages[0].mime).toBe("image/png");
    expect(sniffImageFile(pages[0].data)).toBe("PNG");
    const text = await pdfOf((doc) => doc.text("REKENING KORAN BCA 01/08/2026 SALDO AWAL 1.000.000,00"));
    await expect(pageImages(text)).rejects.toBeInstanceOf(OcrError);
    await expect(pageImages(text)).rejects.toThrow(/berisi teks/);
    expect(await pageImages(img)).toHaveLength(1);
    await expect(pageImages(Buffer.from("a;b;c"))).rejects.toThrow(/bukan scan PDF atau gambar/);
  });
});

describe("proof by running balance", () => {
  const row = (date: string, debit: bigint | null, credit: bigint | null, balance: bigint | null, description = "x"): OcrRow => ({ date, description, debit, credit, balance });

  it("accepts a chain that ties on every row and on the printed closing balance", () => {
    const p = proveRows([row("2026-08-03", null, 500_000n, 1_500_000n), row("2026-08-05", 200_000n, null, 1_300_000n)], 1_000_000n, 1_300_000n);
    expect(p).toMatchObject({ importable: true, problems: 0, closingOk: true });
    expect(p.rows.map((r) => r.state)).toEqual(["OK", "OK"]);
  });

  it("flags one misread amount on its own row only, and a missing balance", () => {
    const p = proveRows([row("2026-08-03", null, 50_000n, 1_500_000n), row("2026-08-05", 200_000n, null, 1_300_000n), row("2026-08-06", 100_000n, null, null), row("2026-08-07", 100_000n, null, 1_100_000n)], 1_000_000n, null);
    expect(p.rows.map((r) => r.state)).toEqual(["BREAK", "OK", "NO_BALANCE", "OK"]);
    expect(p.rows[0].expected).toBe(1_050_000n);
    expect(p).toMatchObject({ importable: false, problems: 2, closingOk: null });
  });

  it("needs an opening balance, a real date, an amount, and the printed closing balance", () => {
    expect(proveRows([row("2026-08-03", null, 1n, 1n)], null, null).rows[0].state).toBe("NO_OPENING");
    expect(proveRows([row("2026-02-30", null, 1n, 1n)], 0n, null).rows[0].state).toBe("BAD_DATE");
    expect(proveRows([row("2026-08-03", null, null, 0n)], 0n, null).rows[0].state).toBe("NO_AMOUNT");
    const p = proveRows([row("2026-08-03", null, 10n, 10n)], 0n, 99n);
    expect(p).toMatchObject({ closingOk: false, importable: false, problems: 1 });
    expect(proveRows([], 0n, null).importable).toBe(false);
  });
});

describe("printed amounts", async () => {
  const { readAmount } = await import("@/lib/ocr/amount");
  it("reads Indonesian and English grouping, markers and brackets, and nothing else", () => {
    expect(readAmount("1.250.000,00")).toBe(1_250_000n);
    expect(readAmount("1,250,000.00")).toBe(1_250_000n);
    expect(readAmount("1,250,000.00 CR")).toBe(1_250_000n);
    expect(readAmount("(2.500)")).toBe(-2_500n);
    expect(readAmount("12500.00")).toBe(12_500n);
    expect(readAmount("")).toBeNull();
    expect(readAmount("1.25O.000")).toBeNull();
    expect(readAmount("12,34,56")).toBeNull();
    expect(readAmount("1.23.456")).toBeNull();
    expect(readAmount("1,2.00")).toBeNull();
    expect(readAmount("12.500,50")).toBeNull(); // sen are not whole Rupiah: unreadable, never rounded
  });
});

describe("readStatement on an OpenAI-compatible gateway", async () => {
  const { OpenAiCompatibleProvider } = await import("@/lib/ai/provider");
  it("sends the page images as image parts, never anything else, and parses the transcription", async () => {
    let sent: { messages: { role: string; content: unknown }[]; max_tokens: number } | null = null;
    const fakeFetch = (async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      const answer = { bank: "BCA", accountNumber: "1111111111", periodStart: "2026-08-01", periodEnd: "2026-08-31", opening: "1.000.000,00", closing: "", rows: [{ date: "2026-08-03", description: "SETORAN", debit: "", credit: "500.000,00", balance: "1.500.000,00" }] };
      return new Response(JSON.stringify({ choices: [{ message: { content: "```json\n" + JSON.stringify(answer) + "\n```" }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 120 }, model: "vision-1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new OpenAiCompatibleProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", model: "vision-1", maxCallsPerRun: 20, monthlyTokenBudget: 100_000 }, fakeFetch);
    const png = encodePng(1, 1, 1, new Uint8Array([255]));
    const r = await p.readStatement({ images: [{ mime: "image/png", data: png }] });
    expect(r.transcript.rows).toEqual([{ date: "2026-08-03", description: "SETORAN", debit: "", credit: "500.000,00", balance: "1.500.000,00" }]);
    expect(r).toMatchObject({ promptTokens: 900, completionTokens: 120, model: "vision-1" });
    const user = sent!.messages[1].content as { type: string; text?: string; image_url?: { url: string } }[];
    expect(user.map((c) => c.type)).toEqual(["text", "image_url"]);
    expect(user[1].image_url!.url).toBe(`data:image/png;base64,${png.toString("base64")}`);
    // Nothing but the instruction and the image: no expected balance, no account list.
    expect(JSON.stringify(sent!.messages)).not.toMatch(/1\.000\.000|saldo awal impor/);
  });
});
