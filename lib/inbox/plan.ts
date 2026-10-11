import type { Db } from "@/lib/db";
import type { BankCode, EntityKind, UploadItem } from "@/lib/generated/prisma/client";
import { json } from "@/lib/evidence/store";
import { addBankAccount, addEntity, OnboardingError } from "@/lib/onboarding";
import { itemView, recheckItem, type BankSection, type InboxItem } from "./check";
import { withLiveOutcome } from "./live";
import { isCompanyName, matchEntity, normalName, titleCase } from "./names";
import { accountDisplay } from "./view";

/**
 * The Unggah confirm card (cycle 2026-10-10-unggah-inbox, Decisions 2 and 5): which rekening every bank file of a drop goes to. A number
 * the client has routes there with no question; new numbers — every section of a combined PDF included — are listed once with a proposed
 * owner; a file without a readable number asks for its rekening. Books nothing (lib/inbox/process.ts does, item by item).
 */

/** A user-facing refusal of the inbox (a foreign entity, rekening or file): the action shows the message as is. */
export class InboxError extends Error {}

export type Proposal = { entityId: string } | { newOwner: { name: string } };
export type KnownSection = { itemId: string; number: string | null; bankAccountId: string; label: string };
export type NewAccount = {
  bank: BankCode;
  /** "BCA ·3814". */
  display: string;
  number: string;
  currency: string;
  holder: string | null;
  /** The statement's balance is below zero (a loan / PRK account): added on 2201–2209. */
  overdraft: boolean;
  itemIds: string[];
  /** Null when `blocked`. */
  proposed: Proposal | null;
  /** The holder is a company that is neither the client's company nor its owner (Decision 5): warn, don't block. */
  warning?: string;
  /** Can't be booked at all (foreign currency): listed, never created. */
  blocked?: string;
};
export type AccountOption = { bankAccountId: string; label: string; bank: BankCode; number: string; entity: string };
export type NumberlessItem = { itemId: string; fileName: string; bank: BankCode; options: AccountOption[] };
export type PlanEntity = { id: string; name: string; shortName: string; kind: EntityKind };
export type InboxPlan = {
  items: InboxItem[];
  entities: PlanEntity[];
  known: KnownSection[];
  newAccounts: NewAccount[];
  numberless: NumberlessItem[];
  needsPassword: string[];
  ready: boolean;
};

type Scope = { firmId: string; clientId: string; batchId: string };

export const VALAS_BLOCKED = "Rekening valas belum bisa dibukukan; file disimpan di Dokumen.";
const SKIPPED = "Tidak dibukukan; disimpan di Dokumen.";
const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
export { accountDisplay };
const isRupiah = (s: BankSection) => (s.currency ?? "IDR") === "IDR";
const RANK: Record<EntityKind, number> = { PT: 0, CV: 1, BADAN_USAHA_ASING: 2, PERORANGAN: 3 };

/** Items the plan still routes: read, and waiting for nothing but a rekening. */
const open = (row: UploadItem) => row.kind === "BANK" && (row.status === "CHECKED" || row.status === "NEEDS_ACCOUNT");
const bankSections = (row: UploadItem) => (row.kind === "BANK" ? (row.sections as BankSection[]) : []);

/** Processing order (Decision 6): bank files oldest period first, then ledgers, then the rest; ties by drop order. */
function order(a: UploadItem, b: UploadItem) {
  const rank = (r: UploadItem) => (r.kind === "BANK" ? 0 : r.kind === "LEDGER" ? 1 : 2);
  const time = (d: Date | null) => (d ? +d : Number.MAX_SAFE_INTEGER);
  return rank(a) - rank(b) || (a.kind === "BANK" ? time(a.periodStart) - time(b.periodStart) : 0) || +a.createdAt - +b.createdAt || a.id.localeCompare(b.id);
}

async function load(db: Db, scope: Scope) {
  const client = await db.client.findFirst({ where: { id: scope.clientId, firmId: scope.firmId }, select: { id: true } });
  if (!client) throw new InboxError("Klien tidak ditemukan.");
  const [rows, entities] = await Promise.all([
    db.uploadItem.findMany({ where: { firmId: scope.firmId, clientId: scope.clientId, batchId: scope.batchId } }).then((r) => withLiveOutcome(db, scope.firmId, r)),
    db.entity.findMany({ where: { clientId: scope.clientId, firmId: scope.firmId }, include: { bankAccounts: true }, orderBy: { name: "asc" } }),
  ]);
  entities.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
  const accounts = entities.flatMap((e) => e.bankAccounts.map((b) => ({ ...b, entity: e.shortName })));
  return { rows: rows.sort(order), entities, accounts };
}

type Loaded = Awaited<ReturnType<typeof load>>;

/** Who a new rekening belongs to (Decision 2 and 5). */
function propose(entities: Loaded["entities"], holder: string | null): { proposed: Proposal; warning?: string } {
  const matched = matchEntity(entities, holder);
  if (matched) return { proposed: { entityId: matched.id } };
  if (holder && !isCompanyName(holder)) return { proposed: { newOwner: { name: titleCase(holder) } } };
  const companies = entities.filter((e) => e.kind !== "PERORANGAN");
  const target = companies.length === 1 ? companies[0] : entities[0];
  const warning = holder ? `Nama di file: ${holder} — bukan perusahaan atau pemilik klien ini. Klien yang benar?` : undefined;
  if (!target) return { proposed: { newOwner: { name: titleCase(holder ?? "Pemilik") } }, warning };
  return { proposed: { entityId: target.id }, ...(warning ? { warning } : {}) };
}

/** The confirm card for the loaded batch, and the status each open item should have (NEEDS_ACCOUNT while a rekening is missing). */
function build({ rows, entities, accounts }: Loaded) {
  const byNumber = new Map(accounts.map((a) => [digits(a.number), a]));
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const known: KnownSection[] = [];
  const fresh = new Map<string, NewAccount>();
  const numberless: NumberlessItem[] = [];
  const waiting = new Map<string, string>();

  for (const row of rows.filter(open)) {
    const missing: string[] = [];
    let asks = false;
    for (const s of bankSections(row)) {
      // A foreign-currency section is listed (blocked) even when the reader refused it for its currency; any other refusal is the file's line.
      if (s.error && isRupiah(s)) continue;
      if (!s.number || !digits(s.number)) {
        if (!isRupiah(s)) continue;
        const chosen = s.bankAccountId ? byId.get(s.bankAccountId) : undefined;
        if (chosen) {
          known.push({ itemId: row.id, number: null, bankAccountId: chosen.id, label: chosen.label });
          continue;
        }
        asks = true;
        if (!numberless.some((n) => n.itemId === row.id)) {
          const options = [...accounts]
            .sort((a, b) => Number(b.bank === s.bank) - Number(a.bank === s.bank) || a.label.localeCompare(b.label))
            .map((a) => ({ bankAccountId: a.id, label: a.label, bank: a.bank, number: a.number, entity: a.entity }));
          numberless.push({ itemId: row.id, fileName: row.fileName, bank: s.bank as BankCode, options });
        }
        continue;
      }
      const account = byNumber.get(digits(s.number));
      if (account) {
        known.push({ itemId: row.id, number: s.number, bankAccountId: account.id, label: account.label });
        continue;
      }
      const key = `${s.bank}|${digits(s.number)}`;
      const entry = fresh.get(key);
      if (entry) {
        if (!entry.itemIds.includes(row.id)) entry.itemIds.push(row.id);
        entry.holder ??= s.holder;
        entry.overdraft ||= BigInt(s.opening) < 0n || BigInt(s.closing) < 0n;
      } else {
        fresh.set(key, {
          bank: s.bank as BankCode,
          display: accountDisplay(s.bank, s.number),
          number: digits(s.number),
          currency: s.currency ?? "IDR",
          holder: s.holder,
          overdraft: BigInt(s.opening) < 0n || BigInt(s.closing) < 0n,
          itemIds: [row.id],
          proposed: null,
        });
      }
      // A foreign-currency section never waits: it can't be booked, the rest of the file still can.
      if (isRupiah(s)) missing.push(accountDisplay(s.bank, s.number));
    }
    if (missing.length) waiting.set(row.id, `Rekening ${[...new Set(missing)].join(", ")} belum ada di klien ini. Tambahkan lewat kartu rekening baru.`);
    else if (asks) waiting.set(row.id, "Nomor rekening tidak terbaca di file. Pilih rekeningnya.");
  }

  const newAccounts = [...fresh.values()].map((a) => (a.currency !== "IDR" ? { ...a, blocked: VALAS_BLOCKED } : { ...a, ...propose(entities, a.holder) }));
  return { known, newAccounts, numberless, waiting };
}

/**
 * The lines of one drop for the Unggah page, in processing order — of `batchId`, or of the client's most recent drop when none is
 * given (the page shows the last drop after a reload). Reads only: the plan's status updates happen in `planBatch`.
 */
export async function batchItems(db: Db, input: { firmId: string; clientId: string; batchId?: string }): Promise<{ batchId: string | null; items: InboxItem[] }> {
  const where = { firmId: input.firmId, clientId: input.clientId };
  const batchId = input.batchId ?? (await db.uploadItem.findFirst({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { batchId: true } }))?.batchId ?? null;
  if (!batchId) return { batchId: null, items: [] };
  const rows = await withLiveOutcome(db, input.firmId, await db.uploadItem.findMany({ where: { ...where, batchId } }));
  return { batchId, items: rows.sort(order).map(itemView) };
}

/**
 * The batch's plan: its items in processing order, the sections routed to a known rekening, the new rekening to confirm, the files
 * without a readable number and the locked ones. Open items whose rekening is missing are marked NEEDS_ACCOUNT (the page shows why
 * they wait), and back to CHECKED once it exists.
 */
export async function planBatch(db: Db, scope: Scope): Promise<InboxPlan> {
  return (await planWith(db, scope)).plan;
}

async function planWith(db: Db, scope: Scope): Promise<{ plan: InboxPlan; loaded: Loaded }> {
  const loaded = await load(db, scope);
  const { known, newAccounts, numberless, waiting } = build(loaded);
  const items: InboxItem[] = [];
  for (const row of loaded.rows) {
    let current = row;
    if (open(row)) {
      const message = waiting.get(row.id);
      const status = message ? "NEEDS_ACCOUNT" : "CHECKED";
      if (row.status !== status || (message && row.message !== message)) {
        // Only while the row is still as read: a parallel processNext may have claimed it (PROCESSING) since.
        const { count } = await db.uploadItem.updateMany({ where: { id: row.id, status: row.status }, data: { status, message: message ?? null } });
        current = count ? { ...row, status, message: message ?? null } : await db.uploadItem.findUniqueOrThrow({ where: { id: row.id } });
      }
    }
    items.push(itemView(current));
  }
  const needsPassword = items.filter((i) => i.status === "NEEDS_PASSWORD").map((i) => i.id);
  const plan: InboxPlan = {
    items,
    entities: loaded.entities.map((e) => ({ id: e.id, name: e.name, shortName: e.shortName, kind: e.kind })),
    known,
    newAccounts,
    numberless,
    needsPassword,
    ready: newAccounts.every((a) => a.blocked) && numberless.length === 0 && needsPassword.length === 0,
  };
  return { plan, loaded };
}

export type ConfirmAccount = { bank: string; number: string; target: Proposal; label?: string; overdraft?: boolean };
export type ConfirmInput = Scope & { actorId?: string | null; accounts: ConfirmAccount[]; numberless: { itemId: string; bankAccountId: string }[] };
export type ConfirmError = { bank: string; number: string; error: string };

/**
 * *Tambah & impor*: creates the confirmed rekening (and the new owners they belong to), stores the rekening chosen for files without a
 * readable number, and returns the new plan. Everything named must be this client's and in this batch's plan; a rekening the onboarding
 * rules refuse (number, 9-account limit) is reported on its own while the others are created.
 */
export async function confirmBatch(db: Db, input: ConfirmInput): Promise<{ plan: InboxPlan; errors: ConfirmError[] }> {
  const scope = { firmId: input.firmId, clientId: input.clientId, batchId: input.batchId };
  const { plan: before, loaded } = await planWith(db, scope);
  const entityIds = new Set(before.entities.map((e) => e.id));
  const accountIds = new Set(loaded.accounts.map((a) => a.id));

  // Tenancy first, before anything is written: every entity, rekening and file must be this client's.
  for (const a of input.accounts) {
    if ("entityId" in a.target && !entityIds.has(a.target.entityId)) throw new InboxError("Entitas tidak ditemukan di klien ini.");
  }
  for (const n of input.numberless) {
    if (!accountIds.has(n.bankAccountId)) throw new InboxError("Rekening tidak ditemukan di klien ini.");
    if (!before.numberless.some((x) => x.itemId === n.itemId)) throw new InboxError("File tidak ditemukan di unggahan ini.");
  }

  const errors: ConfirmError[] = [];
  const valid: (ConfirmAccount & { entry: NewAccount })[] = [];
  for (const a of input.accounts) {
    const entry = before.newAccounts.find((x) => x.bank === a.bank && x.number === digits(a.number));
    if (!entry) errors.push({ bank: a.bank, number: a.number, error: "Rekening ini tidak ada di file unggahan ini." });
    else if (entry.blocked) errors.push({ bank: a.bank, number: a.number, error: entry.blocked });
    else valid.push({ ...a, entry });
  }

  // New owners, once per name (same words = same person); a name that is already an entity of the client is that entity.
  const owners = new Map<string, { id: string } | { error: string }>();
  for (const a of valid) {
    if (!("newOwner" in a.target)) continue;
    const name = a.target.newOwner.name.trim();
    const key = normalName(name);
    if (owners.has(key)) continue;
    if (!key) {
      owners.set(key, { error: "Isi nama pemilik." });
      continue;
    }
    const existing = matchEntity(loaded.entities, name);
    if (existing) {
      owners.set(key, { id: existing.id });
      continue;
    }
    try {
      const entity = await addEntity(db, input.firmId, input.clientId, { name, shortName: name.split(/\s+/)[0], kind: "PERORANGAN", npwp: "", banks: [] });
      owners.set(key, { id: entity.id });
    } catch (e) {
      if (!(e instanceof OnboardingError)) throw e;
      owners.set(key, { error: e.message });
    }
  }

  for (const a of valid) {
    let entityId: string;
    if ("entityId" in a.target) entityId = a.target.entityId;
    else {
      const owner = owners.get(normalName(a.target.newOwner.name))!;
      if ("error" in owner) {
        errors.push({ bank: a.bank, number: a.number, error: owner.error });
        continue;
      }
      entityId = owner.id;
    }
    try {
      await addBankAccount(db, input.firmId, input.clientId, entityId, { bank: a.entry.bank, number: a.entry.number, label: a.label?.trim() ?? "", isOverdraft: a.overdraft ?? a.entry.overdraft });
    } catch (e) {
      if (!(e instanceof OnboardingError)) throw e;
      errors.push({ bank: a.bank, number: a.number, error: e.message });
    }
  }

  for (const n of input.numberless) {
    const row = loaded.rows.find((r) => r.id === n.itemId)!;
    const sections = bankSections(row).map((s) => (!digits(s.number) && !s.error ? { ...s, bankAccountId: n.bankAccountId } : s));
    await db.uploadItem.update({ where: { id: row.id }, data: { sections: json(sections) } });
  }

  return { plan: await planBatch(db, scope), errors };
}

/** *Batal* on the card (a file of another client): the files are kept in Dokumen only, never booked. */
export async function skipItems(db: Db, input: Scope & { itemIds: string[] }): Promise<InboxPlan> {
  const scope = { firmId: input.firmId, clientId: input.clientId, batchId: input.batchId };
  await db.uploadItem.updateMany({
    where: { ...scope, id: { in: input.itemIds }, status: { in: ["CHECKED", "NEEDS_ACCOUNT", "NEEDS_PASSWORD", "FAILED"] } },
    data: { status: "KEPT", message: SKIPPED },
  });
  return planBatch(db, scope);
}

/**
 * The drop's one password field: every locked file of the batch is read again from its stored version with `password` (and the keyring).
 * Opened files are read as usual (CHECKED, password kept for the client); the others stay NEEDS_PASSWORD with their message.
 */
export async function unlockBatch(db: Db, input: Scope & { password: string; actorId?: string | null }): Promise<InboxPlan> {
  const scope = { firmId: input.firmId, clientId: input.clientId, batchId: input.batchId };
  const { rows } = await load(db, scope);
  for (const row of rows.filter((r) => r.status === "NEEDS_PASSWORD")) {
    await recheckItem(db, row, { password: input.password, actorId: input.actorId });
  }
  return planBatch(db, scope);
}
