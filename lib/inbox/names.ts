/**
 * Matching the account holder printed on a statement with the client's entities (Unggah, Decision 2 and 5). Pure: no fuzzy match,
 * only the same words in any order once punctuation and legal-form words are dropped.
 */
const LEGAL = new Set(["PT", "CV", "TBK", "PERSERO", "UD", "PD"]);

const tokens = (s: string) =>
  s
    .toUpperCase()
    .replace(/\./g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);

/** "BELIFI MAHAJAYA NUSANTARA PT" and "PT. Belifi Mahajaya Nusantara" both give "BELIFI MAHAJAYA NUSANTARA". */
export function normalName(s: string): string {
  return tokens(s)
    .filter((t) => !LEGAL.has(t))
    .sort()
    .join(" ");
}

/** A company's name carries a legal-form word (PT, CV, Tbk, Persero, UD, PD); a person's doesn't. */
export function isCompanyName(s: string): boolean {
  return tokens(s).some((t) => LEGAL.has(t));
}

/** The entity whose name or short name is the holder's name (same words, any order, legal-form words ignored); else null. */
export function matchEntity<E extends { name: string; shortName: string }>(entities: E[], holder: string | null | undefined): E | null {
  const key = holder ? normalName(holder) : "";
  if (!key) return null;
  return entities.find((e) => normalName(e.name) === key || normalName(e.shortName) === key) ?? null;
}

/** "BUDI SANTOSO" → "Budi Santoso". */
export function titleCase(s: string): string {
  return s
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}
