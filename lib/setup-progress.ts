import type { Db } from "@/lib/db";
import { formatPeriod } from "@/lib/format";
import { withParams } from "@/lib/scope";

/**
 * The first-run journey of a client, derived from the books only (nothing is stored):
 * Unggah data → Saldo awal → Review → Tutup buku. Every page that says "what next" reads it, so they never disagree.
 * Saldo Awal comes after the upload because the bank opening is prefilled from the imported statement (`lib/opening.ts`).
 */
export type StepKey = "import" | "opening" | "review" | "close";
export type StepState = "done" | "current" | "todo";
export type SetupStep = { key: StepKey; label: string; state: StepState; href: string; detail?: string };
export type SetupNext = { text: string; href: string; cta: string };
export type SetupProgress = {
  steps: SetupStep[];
  /** First step that isn't done; null once the period is closed. */
  current: StepKey | null;
  next: SetupNext | null;
  /** Companies/owners whose statement is imported but whose Saldo Awal is still missing (empty until something is imported). */
  needsOpening: { id: string; name: string; shortName: string }[];
  hasBanks: boolean;
  hasData: boolean;
};

export const STEP_LABEL: Record<StepKey, string> = { import: "Unggah data", opening: "Saldo awal", review: "Review transaksi", close: "Tutup buku" };

export async function setupProgress(
  db: Db,
  clientId: string,
  opts: { period?: { year: number; month: number }; /** Titles of "Mutasi … belum diimpor" close controls for that period. */ missingStatements?: string[]; params?: Record<string, string | undefined> } = {},
): Promise<SetupProgress> {
  const base = `/clients/${clientId}`;
  const entities = await db.entity.findMany({ where: { clientId }, select: { id: true, name: true, shortName: true, kind: true, bankAccounts: { select: { id: true } } } });
  const entityIds = entities.map((e) => e.id);
  const [uploaded, postedLedger, draft, withBooks, toReview, period] = await Promise.all([
    db.statementImport.findMany({ where: { bankAccount: { entityId: { in: entityIds } } }, select: { bankAccountId: true }, distinct: ["bankAccountId"] }),
    db.ledgerImport.count({ where: { clientId, status: "POSTED" } }),
    db.ledgerImport.findFirst({ where: { clientId, status: "DRAFT" }, orderBy: { createdAt: "desc" }, select: { id: true, fileName: true } }),
    db.journalEntry.findMany({ where: { entityId: { in: entityIds }, kind: { in: ["OPENING", "IMPORTED"] } }, select: { entityId: true }, distinct: ["entityId"] }),
    db.bankTransaction.count({ where: { entityId: { in: entityIds }, status: "NEEDS_REVIEW" } }),
    opts.period ? db.period.findUnique({ where: { clientId_year_month: { clientId, year: opts.period.year, month: opts.period.month } } }) : null,
  ]);
  const hasBanks = entities.some((e) => e.bankAccounts.length > 0);
  const hasData = uploaded.length > 0 || postedLedger > 0;
  const booked = new Set(withBooks.map((j) => j.entityId));
  const uploadedBanks = new Set(uploaded.map((u) => u.bankAccountId));
  // Saldo Awal is asked once an entity's statement is in (its bank lines are prefilled from it). An entity with no bank account
  // has nothing to prefill, and one whose statement isn't uploaded yet is waiting for the upload (the bank control names the gap).
  const needsOpening = hasData
    ? entities.filter((e) => e.bankAccounts.some((b) => uploadedBanks.has(b.id)) && !booked.has(e.id)).sort((a, b) => Number(a.kind === "PERORANGAN") - Number(b.kind === "PERORANGAN")).map(({ id, name, shortName }) => ({ id, name, shortName }))
    : [];
  const missing = opts.missingStatements ?? [];
  const openingDone = hasData && needsOpening.length === 0;
  const done: Record<StepKey, boolean> = {
    import: hasData && !(openingDone && missing.length > 0),
    opening: openingDone,
    review: hasData && toReview === 0,
    close: period?.status === "LOCKED",
  };
  const order: StepKey[] = ["import", "opening", "review", "close"];
  const current = order.find((k) => !done[k]) ?? null;
  const periodLabel = opts.period ? formatPeriod(opts.period.year, opts.period.month) : "";
  const importHref = `${base}/import`;
  const href: Record<StepKey, string> = {
    import: importHref,
    opening: `${base}/opening`,
    review: withParams(`${base}/review`, opts.params ?? {}),
    close: withParams(`${base}/close`, opts.params ?? {}),
  };
  const detail: Record<StepKey, string | undefined> = {
    import: !hasData ? undefined : missing.length ? `${missing.length} rekening belum lengkap` : "Selesai",
    opening: needsOpening.length ? needsOpening.map((e) => e.shortName).join(", ") : undefined,
    review: toReview ? `${toReview} perlu dicek` : undefined,
    close: periodLabel || undefined,
  };
  const steps = order.map((key): SetupStep => ({ key, label: STEP_LABEL[key], state: done[key] ? "done" : key === current ? "current" : "todo", href: href[key], detail: detail[key] }));

  let next: SetupNext | null = null;
  if (current === "import") {
    if (!hasData && draft) next = { text: `Lanjutkan impor ${draft.fileName}: petakan akunnya lalu catat.`, href: `${base}/import/ledger/${draft.id}`, cta: "Lanjutkan impor" };
    else if (!hasData) next = hasBanks
      ? { text: "Unggah rekening koran pertama. Setelah itu saldo bank di Saldo Awal terisi otomatis.", href: importHref, cta: "Unggah rekening koran" }
      : { text: "Unggah rekening koran atau file pembukuan klien. Rekening baru ditambahkan dari file.", href: importHref, cta: "Unggah" };
    else next = { text: `Mutasi ${missing.map((m) => m.replace("Rekonsiliasi ", "")).join(", ")}${periodLabel ? ` untuk ${periodLabel}` : ""} belum diimpor.`, href: importHref, cta: "Impor mutasi" };
  } else if (current === "opening") {
    next = { text: `Isi saldo awal ${needsOpening.map((e) => e.shortName).join(" dan ")}. Saldo bank sudah terisi dari rekening koran, tinggal periksa.`, href: href.opening, cta: "Isi saldo awal" };
  } else if (current === "review") {
    next = { text: `${toReview} transaksi perlu dicek. Semuanya sudah punya usulan akun.`, href: href.review, cta: "Review transaksi" };
  } else if (current === "close") {
    next = { text: "Semua transaksi sudah terklasifikasi. Cek kontrol lalu tutup buku.", href: href.close, cta: "Tutup buku" };
  }
  return { steps, current, next, needsOpening, hasBanks, hasData };
}
