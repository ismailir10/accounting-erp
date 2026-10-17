/**
 * Which cards carry *Lihat alasan* (cycle 2026-10-17-lihat-alasan): an AI bank line (Review, Kotak) or an AI draft (*Jelaskan*, Kotak), and
 * an accrual proposal (cycle 2026-10-18-usulan-akrual): an estimate the accountant must judge, whose history rows are the evidence.
 * Rule, memory, transfer, simple-guess, financing/tax-hint and 1999-correction cards are deterministic: their reason already says why.
 * Its own module so the client components can import it without the read model's server code.
 */
export const hasReasoning = (card: { method: string } | { source: string }) => ("method" in card ? card.method === "AI" : card.source === "AI_CONTROL" || card.source === "ACCRUAL");
