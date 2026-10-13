import type { BankCode, UploadKind, UploadStatus } from "@/lib/generated/prisma/enums";
import type { BankSection, LedgerSection } from "./check";
import { isCompanyName, normalName, titleCase } from "./names";
import { accountDisplay, monthSpan } from "./view";

/**
 * *Klien baru* from files (cycle 2026-10-10-new-client-from-files): what the dropped files say the new client is — its companies and
 * owners, and every rekening under its holder. Pure and client-safe (the page recomputes it as each file is read). Nothing is guessed
 * silently: the card shows all of it, editable, before anything is created.
 */

/** One dropped file as read without a client (lib/inbox/preview.ts): the same outcome an Unggah line has, nothing stored. */
export type PreviewFile = {
  fileName: string;
  kind: UploadKind;
  status: UploadStatus;
  message: string | null;
  sections: BankSection[] | LedgerSection[];
  /** The company a spreadsheet's title rows name (a Neraca, laba rugi or arus kas without an entity column). */
  companyName?: string | null;
};

export type ProposedKind = "PT" | "CV" | "PERORANGAN";
export type ProposedAccount = {
  /** `bank|digits`: one rekening however many files carry it. */
  key: string;
  bank: BankCode;
  number: string;
  /** "BCA ·3814". */
  display: string;
  holder: string | null;
  /** A balance below zero on any statement: a loan / PRK account (2201–2209), as Unggah adds it. */
  isOverdraft: boolean;
  /** "Jun–Jul 2026". */
  months: string;
  /** Months between its first and last statement that no file covers ("Jul 2026", "Jun–Jul 2026"): the saldo won't connect there. */
  gaps: string[];
  fileNames: string[];
};
export type ProposedEntity = {
  key: string;
  name: string;
  shortName: string;
  kind: ProposedKind;
  /** No holder named it: its name follows the client name the user types. */
  fromClientName?: boolean;
  /** A ledger's entity label is its short name (the rows are matched by it), kept when the name is edited. */
  labelled?: boolean;
  /** The ledger's rows of this entity per currency, most first ("USD 700 · SGD 300 · IDR 2"). */
  rowsByCurrency?: { currency: string; rows: number }[];
  /**
   * Its rows aren't mostly Rupiah: the bookkeeping currency is a judgement (a holding can keep SGD books over mostly USD rows), so the
   * card asks for it instead of creating the company in Rupiah and booking foreign amounts as Rupiah.
   */
  currencyRequired?: boolean;
  banks: ProposedAccount[];
};
export type ClientProposal = {
  /** The first company holder, else the first person; "" when no file names one. */
  clientName: string;
  entities: ProposedEntity[];
  /** Foreign-currency rekening: listed, never created (Unggah can't book valas yet). */
  valas: { key: string; display: string; currency: string; fileNames: string[] }[];
  /** Files Buku couldn't read, or read without a usable rekening, with why. */
  unread: { fileName: string; reason: string }[];
  /** Ledgers and other documents: uploaded with the rest, Unggah sorts them (booked or kept in Dokumen). */
  documents: string[];
  /** Something to create the client from: a rekening, a ledger, or a bank file whose number Unggah will ask. */
  readable: boolean;
};

export const CLIENT_KEY = "klien";
const NUMBERLESS = "Nomor rekening tidak terbaca; rekeningnya ditanyakan di Unggah.";
const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const legalWord = (w: string) => w.toUpperCase().replace(/\./g, "");
const RANK: Record<ProposedKind, number> = { PT: 0, CV: 1, PERORANGAN: 2 };

/** PT for PT / Tbk / Persero; CV for CV and the other small business forms (UD, PD) — the card lets the accountant change it. */
function companyKind(holder: string): ProposedKind {
  const forms = words(holder).map(legalWord);
  return forms.includes("PT") || forms.includes("TBK") || forms.includes("PERSERO") ? "PT" : "CV";
}

/** "BELIFI MAHAJAYA NUSANTARA PT" → "PT Belifi Mahajaya Nusantara"; "budi  santoso" → "Budi Santoso". */
export function entityName(holder: string): string {
  if (!isCompanyName(holder)) return titleCase(holder.replace(/[^\p{L}\p{N}' ]+/gu, " "));
  const forms = words(holder.replace(/[,]/g, " ")).map(legalWord);
  const form = ["PT", "CV", "UD", "PD"].find((f) => forms.includes(f)) ?? "PT";
  const rest = words(holder.replace(/[,]/g, " ")).filter((w) => !["PT", "CV", "TBK", "PERSERO", "UD", "PD"].includes(legalWord(w)));
  return [form, titleCase(rest.join(" "))].filter(Boolean).join(" ");
}

/** The short name tables use: "PT Belifi" for a company, "Budi" for a person; a company named without its legal form keeps its name. */
export function shortNameOf(name: string, kind: ProposedKind): string {
  const w = words(name);
  if (kind === "PERORANGAN") return w[0] ?? "";
  if (w.length > 1 && ["PT", "CV", "UD", "PD"].includes(legalWord(w[0]))) return `${w[0]} ${w[1]}`;
  return w.join(" ");
}

/** Months strictly between the first and last statement that none covers, as runs ("Jul 2026", "Jun–Jul 2026"). Dates are `YYYY-MM-DD`. */
function missingMonths(periods: (readonly [string, string])[]): string[] {
  const index = (d: string) => (/^\d{4}-\d{2}/.test(d) ? Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1 : null);
  const covered = new Set<number>();
  for (const [start, end] of periods) {
    const a = index(start) ?? index(end);
    const b = index(end) ?? a;
    if (a === null || b === null) continue;
    for (let m = a; m <= b; m++) covered.add(m);
  }
  if (covered.size < 2) return [];
  const all = [...covered];
  const first = Math.min(...all);
  const last = Math.max(...all);
  const runs: [number, number][] = [];
  for (let m = first + 1; m < last; m++) {
    if (covered.has(m)) continue;
    const run = runs.at(-1);
    if (run && run[1] === m - 1) run[1] = m;
    else runs.push([m, m]);
  }
  const iso = (m: number) => `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}-01`;
  return runs.map(([a, b]) => monthSpan(iso(a), iso(b)));
}

type Group = { key: string; holders: string[]; company: boolean; banks: ProposedAccount[] };

/** The new client the files describe (Decision 1): holders grouped into entities by name, every Rupiah rekening under its holder. */
/** A ledger entity's rows per currency, and whether its bookkeeping currency must be asked: only when Rupiah rows aren't the majority. */
function currencyOf(counts: Map<string, number> | undefined): Pick<ProposedEntity, "rowsByCurrency" | "currencyRequired"> {
  if (!counts?.size) return {};
  const rowsByCurrency = [...counts].map(([currency, rows]) => ({ currency, rows })).sort((a, b) => b.rows - a.rows || a.currency.localeCompare(b.currency));
  const total = rowsByCurrency.reduce((s, c) => s + c.rows, 0);
  const idr = counts.get("IDR") ?? 0;
  return idr * 2 > total ? {} : { rowsByCurrency, currencyRequired: true };
}

export function proposeClient(files: PreviewFile[]): ClientProposal {
  const accounts = new Map<string, ProposedAccount>();
  const spans = new Map<string, { start: string[]; end: string[] }>();
  const valas = new Map<string, ClientProposal["valas"][number]>();
  const unread: ClientProposal["unread"] = [];
  const documents: string[] = [];
  let numberless = false;
  let ledger = false;
  // Companies the files name outside any bank statement: a ledger's entity labels ("SKP"), or a report's own title ("PT FKM").
  const labels = new Map<string, string>();
  const labelCurrencies = new Map<string, Map<string, number>>();
  const titled = new Map<string, string>();

  for (const f of files) {
    if (f.status === "NEEDS_PASSWORD") {
      unread.push({ fileName: f.fileName, reason: f.message ?? "PDF ini dikunci kata sandi." });
      continue;
    }
    if (f.kind === "LEDGER") {
      ledger = true;
      documents.push(f.fileName);
      for (const section of f.sections as LedgerSection[]) {
        for (const label of section.entities ?? []) if (!labels.has(label.toLowerCase())) labels.set(label.toLowerCase(), label);
        for (const [label, counts] of Object.entries(section.entityCurrencies ?? {})) {
          const into = labelCurrencies.get(label.toLowerCase()) ?? new Map<string, number>();
          for (const [currency, n] of Object.entries(counts)) into.set(currency, (into.get(currency) ?? 0) + n);
          labelCurrencies.set(label.toLowerCase(), into);
        }
      }
    }
    if (f.kind !== "BANK" && f.companyName) {
      const key = normalName(f.companyName);
      if (key && !titled.has(key)) titled.set(key, f.companyName);
    }
    if (f.kind === "LEDGER") continue;
    if (f.kind !== "BANK") {
      documents.push(f.fileName);
      continue;
    }
    if (f.status === "FAILED") {
      unread.push({ fileName: f.fileName, reason: f.message ?? "File ini tidak terbaca." });
      continue;
    }
    let used = false;
    for (const s of f.sections as BankSection[]) {
      const currency = s.currency ?? "IDR";
      if (currency !== "IDR") {
        if (!digits(s.number)) continue;
        const key = `${s.bank}|${digits(s.number)}`;
        const entry = valas.get(key) ?? { key, display: accountDisplay(s.bank, s.number!), currency, fileNames: [] };
        if (!entry.fileNames.includes(f.fileName)) entry.fileNames.push(f.fileName);
        valas.set(key, entry);
        used = true;
        continue;
      }
      if (s.error) continue;
      if (!digits(s.number)) {
        numberless = true;
        if (!unread.some((u) => u.fileName === f.fileName)) unread.push({ fileName: f.fileName, reason: NUMBERLESS });
        continue;
      }
      used = true;
      const key = `${s.bank}|${digits(s.number)}`;
      const overdraft = BigInt(s.opening) < 0n || BigInt(s.closing) < 0n;
      const entry = accounts.get(key);
      if (entry) {
        entry.holder ??= s.holder;
        entry.isOverdraft ||= overdraft;
        if (!entry.fileNames.includes(f.fileName)) entry.fileNames.push(f.fileName);
      } else {
        accounts.set(key, { key, bank: s.bank as BankCode, number: digits(s.number), display: accountDisplay(s.bank, s.number!), holder: s.holder, isOverdraft: overdraft, months: "", gaps: [], fileNames: [f.fileName] });
      }
      const span = spans.get(key) ?? { start: [], end: [] };
      span.start.push(s.periodStart);
      span.end.push(s.periodEnd);
      spans.set(key, span);
    }
    // Every section refused: the file's own reason (the first section's).
    if (!used && !unread.some((u) => u.fileName === f.fileName)) {
      const error = (f.sections as BankSection[]).find((s) => s.error)?.error;
      unread.push({ fileName: f.fileName, reason: error ?? "File ini tidak terbaca." });
    }
  }
  for (const [key, a] of accounts) {
    const span = spans.get(key)!;
    a.months = monthSpan([...span.start].sort()[0] ?? null, [...span.end].sort().at(-1) ?? null);
    a.gaps = missingMonths(span.start.map((start, i) => [start, span.end[i]] as const));
  }

  // Holders become entities: the same words in any order, legal-form words and punctuation ignored, are one entity.
  const groups: Group[] = [];
  const holderless: ProposedAccount[] = [];
  for (const a of accounts.values()) {
    const key = a.holder ? normalName(a.holder) : "";
    if (!key) {
      holderless.push(a);
      continue;
    }
    let group = groups.find((g) => g.key === key);
    if (!group) groups.push((group = { key, holders: [], company: false, banks: [] }));
    group.holders.push(a.holder!);
    group.company ||= isCompanyName(a.holder!);
    group.banks.push(a);
  }

  const entities: ProposedEntity[] = groups.map((g) => {
    // A company's name as printed with its legal form, if any statement printed one.
    const holder = (g.company ? g.holders.find(isCompanyName) : g.holders[0])!;
    const kind = g.company ? companyKind(holder) : "PERORANGAN";
    const name = entityName(holder);
    return { key: g.key, name, shortName: shortNameOf(name, kind), kind, banks: g.banks };
  });
  // A ledger's entity column names the companies exactly (its labels are the short names Unggah matches rows by); without one, the
  // company a report's title names — unless a bank holder already is that company.
  if (labels.size) {
    for (const label of labels.values()) {
      const currency = currencyOf(labelCurrencies.get(label.toLowerCase()));
      // A label that is a bank holder's company too (same words, legal form ignored) is that entity: its short name becomes the label.
      const holder = entities.find((e) => e.key === normalName(label));
      if (holder) Object.assign(holder, { shortName: label, labelled: true, ...currency });
      else entities.push({ key: `label:${label.toLowerCase()}`, name: label, shortName: label, kind: "PT", labelled: true, ...currency, banks: [] });
    }
  } else {
    for (const [key, title] of titled) {
      if (groups.some((g) => g.key === key)) continue;
      const name = entityName(title);
      const kind = isCompanyName(title) ? companyKind(title) : "PT";
      entities.push({ key: `title:${key}`, name, shortName: shortNameOf(name, kind), kind, banks: [] });
    }
  }
  const firstCompany = entities.find((e) => e.kind !== "PERORANGAN");
  const firstNamed = entities.find((e) => e.kind !== "PERORANGAN" && !e.key.startsWith("label:")) ?? entities.find((e) => !e.key.startsWith("label:"));
  const clientName = firstNamed?.name ?? "";

  // A rekening without a holder belongs to the client's company: the first one found, else one named after the client.
  const readable = accounts.size > 0 || ledger || numberless || valas.size > 0 || titled.size > 0;
  if (holderless.length && firstCompany) firstCompany.banks.push(...holderless);
  else if (holderless.length || (readable && !entities.length)) entities.push({ key: CLIENT_KEY, name: "", shortName: "", kind: "PT", fromClientName: true, banks: holderless });

  entities.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
  return { clientName, entities, valas: [...valas.values()], unread, documents, readable };
}
