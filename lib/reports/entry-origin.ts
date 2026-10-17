import type { Db } from "@/lib/db";
import { runControls } from "@/lib/controls";
import { parseAccrualKey } from "@/lib/adjust/accruals";
import { readLines } from "@/lib/adjust/proposals";
import { formatMoney } from "@/lib/money";

/**
 * The proposal a posted entry came from (Kotak persetujuan): one line under its source on Jurnal Umum, in the Buku Besar drawer and in
 * the Excel source column. Read from what each writer already keeps, never stored: the draft's or approved accrual's
 * `ProposedEntry.entryId` (an accrual's counterparty from its key, "diubah dari" when the posted amount isn't Buku's), the booked
 * invoice whose number is a Coretax faktur's (written by `bookFaktur`), and the reviewer's `CLASSIFY` event (the suggestion it decided
 * on and the RECLASS it posted). An instalment already names its schedule in the source line. Decisions taken before the review
 * writer kept the suggestion show nothing: audit events are never rewritten.
 */

export type OriginFacts =
  | { kind: "draft"; source: "AI_CONTROL" | "SUSPENSE"; control: string | null }
  | { kind: "accrual"; counterparty: string; /** The amount Buku proposed, when another one was posted. */ changedFrom: string | null }
  | { kind: "faktur"; fileName: string; sourceRef: string }
  | { kind: "review"; suggestion: { accountCode: string; taxTag: string | null; method: string; confidence: number }; accountCode: string; taxTag: string | null };

const METHOD_LABEL: Record<string, string> = { AI: "Usulan AI", HEURISTIC: "Tebakan", RULE: "Aturan", MEMORY: "Pilihan yang diingat", TRANSFER: "Pasangan transfer" };
const TAX_LABEL: Record<string, string> = { PPN_KELUARAN: "PPN Keluaran", PPN_MASUKAN: "PPN Masukan", PPH_21: "PPh 21", PPH_23: "PPh 23", PPH_4_2: "PPh 4(2)", PPH_25: "PPh 25" };
const target = (code: string, tax: string | null) => `${code}${tax ? ` ${TAX_LABEL[tax] ?? tax}` : ""}`;

export function originText(f: OriginFacts): string {
  if (f.kind === "draft") return f.source === "SUSPENSE" ? "Koreksi selisih 1999" : `Usulan AI (Jelaskan${f.control ? ` · ${f.control}` : ""})`;
  if (f.kind === "accrual") return `Usulan akrual (riwayat ${f.counterparty})${f.changedFrom ? ` diubah dari ${f.changedFrom}` : ""}`;
  if (f.kind === "faktur") return `Faktur Coretax ${f.fileName} ${f.sourceRef}`;
  const s = f.suggestion;
  const what = `${METHOD_LABEL[s.method] ?? "Usulan"} ${target(s.accountCode, s.taxTag)}${s.method === "AI" ? ` (${Math.round(s.confidence * 100)} %)` : ""}`;
  const same = s.accountCode === f.accountCode && (s.taxTag ?? null) === (f.taxTag ?? null);
  return same ? `${what} disetujui` : `${what} diubah ke ${target(f.accountCode, f.taxTag)}`;
}

/** The `CLASSIFY` event's `after`, as the reviewer's writer keeps it (lib/review.ts); anything else reads as no origin. */
function reviewFacts(after: unknown): { entryId: string; facts: OriginFacts } | null {
  const a = after as { accountCode?: unknown; taxTag?: unknown; entryId?: unknown; suggestion?: { accountCode?: unknown; taxTag?: unknown; method?: unknown; confidence?: unknown } | null } | null;
  const s = a?.suggestion;
  if (!a || typeof a.entryId !== "string" || typeof a.accountCode !== "string" || !s || typeof s.accountCode !== "string" || typeof s.method !== "string" || typeof s.confidence !== "number") return null;
  return {
    entryId: a.entryId,
    facts: { kind: "review", suggestion: { accountCode: s.accountCode, taxTag: typeof s.taxTag === "string" ? s.taxTag : null, method: s.method, confidence: s.confidence }, accountCode: a.accountCode, taxTag: typeof a.taxTag === "string" ? a.taxTag : null },
  };
}

/** The origin line of each entry that came from a proposal, by entry id (entries with none are absent). */
export async function entryOrigins(db: Db, entryIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!entryIds.length) return out;
  const ids = [...new Set(entryIds)];
  const [drafts, invoices, reclasses] = await Promise.all([
    db.proposedEntry.findMany({ where: { entryId: { in: ids } }, select: { entryId: true, source: true, controlKey: true, clientId: true, year: true, month: true, key: true, lines: true, entity: { select: { functionalCurrency: true } } } }),
    db.invoice.findMany({ where: { entryId: { in: ids } }, select: { entryId: true, entityId: true, direction: true, number: true, description: true } }),
    db.journalEntry.findMany({ where: { id: { in: ids }, kind: "RECLASS", bankTransactionId: { not: null } }, select: { id: true, bankTransactionId: true } }),
  ]);

  // A review decision first, so a draft that went through the reviewer's writer (a bank-line RECLASS) is named as the draft below.
  if (reclasses.length) {
    const events = await db.auditEvent.findMany({ where: { kind: "CLASSIFY", subject: { in: reclasses.map((r) => `bankTx:${r.bankTransactionId}`) } }, select: { after: true } });
    const wanted = new Set(reclasses.map((r) => r.id));
    for (const e of events) {
      const r = reviewFacts(e.after);
      if (r && wanted.has(r.entryId)) out.set(r.entryId, originText(r.facts));
    }
  }

  // A booked faktur: the invoice `bookFaktur` wrote carries the faktur's number and says so in its description.
  const fromFaktur = invoices.filter((i) => i.description.startsWith(`Faktur pajak ${i.number} (Coretax`));
  if (fromFaktur.length) {
    const faktur = await db.coretaxFaktur.findMany({
      where: { OR: fromFaktur.map((i) => ({ entityId: i.entityId, direction: i.direction === "SALES" ? "KELUARAN" : "MASUKAN", number: i.number })) },
      select: { entityId: true, direction: true, number: true, fileName: true, sourceRef: true },
    });
    for (const i of fromFaktur) {
      const f = faktur.find((x) => x.entityId === i.entityId && x.number === i.number && x.direction === (i.direction === "SALES" ? "KELUARAN" : "MASUKAN"));
      if (f && i.entryId) out.set(i.entryId, originText({ kind: "faktur", fileName: f.fileName, sourceRef: f.sourceRef }));
    }
  }

  // A *Jelaskan* draft names the control it explained; titles come from that month's controls, read once per client-month.
  const titles = new Map<string, Map<string, string>>();
  for (const d of drafts.filter((x) => x.source === "AI_CONTROL" && x.controlKey)) {
    const k = `${d.clientId}|${d.year}|${d.month}`;
    if (!titles.has(k)) titles.set(k, new Map((await runControls(db, d.clientId, d.year, d.month)).map((c) => [c.key, c.title])));
  }
  for (const d of drafts) {
    if (!d.entryId) continue;
    if (d.source === "ACCRUAL") continue;
    const control = d.controlKey ? (titles.get(`${d.clientId}|${d.year}|${d.month}`)?.get(d.controlKey) ?? null) : null;
    out.set(d.entryId, originText({ kind: "draft", source: d.source, control }));
  }
  for (const [entryId, text] of await accrualOrigins(db, drafts.filter((d) => d.source === "ACCRUAL"))) out.set(entryId, text);
  return out;
}

/**
 * An approved *Usulan akrual*: its counterparty, read back from the stored key (a payee's words, a supplier's name, a ledger bucket's
 * account), and the amount Buku proposed when the accountant posted another one (*Ubah*).
 */
async function accrualOrigins(db: Db, rows: { entryId: string | null; clientId: string; key: string; lines: unknown; entity: { functionalCurrency: string } }[]) {
  const out = new Map<string, string>();
  const parsed = rows.flatMap((r) => {
    const k = parseAccrualKey(r.key);
    return r.entryId && k ? [{ ...r, entryId: r.entryId, k }] : [];
  });
  if (!parsed.length) return out;
  const [contacts, accounts, posted] = await Promise.all([
    db.contact.findMany({ where: { id: { in: parsed.flatMap((p) => (p.k.bucket.kind === "contact" ? [p.k.bucket.contactId] : [])) } }, select: { id: true, name: true } }),
    db.account.findMany({ where: { OR: parsed.map((p) => ({ clientId: p.clientId, code: p.k.code })) }, select: { clientId: true, code: true, name: true } }),
    db.journalLine.groupBy({ by: ["entryId"], where: { entryId: { in: parsed.map((p) => p.entryId) } }, _sum: { debit: true } }),
  ]);
  for (const p of parsed) {
    const b = p.k.bucket;
    const counterparty =
      b.kind === "bank" ? b.merchantKey : b.kind === "contact" ? (contacts.find((c) => c.id === b.contactId)?.name ?? "") : `${p.k.code} ${accounts.find((a) => a.clientId === p.clientId && a.code === p.k.code)?.name ?? ""}`.trim();
    const proposed = BigInt(readLines(p.lines)[0]?.debit ?? "0");
    const amount = posted.find((x) => x.entryId === p.entryId)?._sum.debit ?? proposed;
    out.set(p.entryId, originText({ kind: "accrual", counterparty, changedFrom: amount !== proposed ? formatMoney(proposed, p.entity.functionalCurrency) : null }));
  }
  return out;
}
