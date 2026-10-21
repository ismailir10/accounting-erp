import type { Db } from "@/lib/db";
import { ensureIntercompanyAccounts } from "@/lib/coa/intercompany";
import { createBankAccount, createClient, createEntity, freeGlCodes, type ClientCreator, type ClientSpec } from "@/lib/setup";
import { isCurrency } from "@/lib/fx/currency";
import { isFramework, type Framework } from "@/lib/reports/framework";
import { isBlankBankRow } from "@/lib/blank-bank";
import { BANK_CODES, bankName } from "@/lib/banks";
import type { BankCode } from "@/lib/generated/prisma/enums";

/**
 * "Tambah klien": a real client with its entities (PT/CV/owner), each with its functional currency and optional bank
 * accounts (a company whose books come from a ledger file has none). Reuses createClient(), so the client gets the
 * template COA and one GL bank account (1101–1109) per bank account.
 */
/** `fields` maps a form path ("name", "entities.0.banks.1.number") to what to fix, so the form can mark every field at once. */
export class OnboardingError extends Error {
  constructor(readonly fields: Record<string, string>) {
    const n = Object.keys(fields).length;
    super(n === 1 ? Object.values(fields)[0] : `Periksa ${n} isian yang ditandai.`);
  }
}

const KINDS = ["PT", "CV", "BADAN_USAHA_ASING", "PERORANGAN"] as const;
/** The default account name: the bank's short name ("SMBC", not "SMBC / Jenius"), "Bank" for *Bank lain*. */
const defaultName = (code: string) => (code === "GENERIC" ? "Bank" : bankName(code).split(" / ")[0]);

export type NewClientInput = {
  name: string;
  industry: string;
  entities: { name: string; shortName: string; kind: (typeof KINDS)[number]; npwp: string; currency?: string; reportingFramework?: Framework; banks: { bank: BankCode; number: string; label: string; isOverdraft?: boolean }[] }[];
};

type EntityInput = NewClientInput["entities"][number];
export type BankInput = EntityInput["banks"][number];

/** One bank row: a blank row is skipped (null); otherwise the cleaned account, with problems keyed under `bt`. `seen` holds the numbers already taken. */
export function cleanBank(b: BankInput, bt: string, fields: Record<string, string>, seen: Map<string, string>, duplicate = "Nomor ini sudah dimasukkan di atas.") {
  if (isBlankBankRow(b)) return null;
  if (!(BANK_CODES as readonly string[]).includes(b.bank)) fields[`${bt}.bank`] = "Pilih bank.";
  const number = b.number.replace(/[\s.\-]/g, "");
  if (!number) fields[`${bt}.number`] = "Isi nomor rekening.";
  else if (!/^\d{6,20}$/.test(number)) fields[`${bt}.number`] = "Nomor rekening berisi 6–20 angka.";
  else if (seen.has(number)) fields[`${bt}.number`] = duplicate;
  else seen.set(number, bt);
  const label = b.label.trim() || `${defaultName(b.bank)}${b.isOverdraft ? " PRK" : ""} ••${number.slice(-4)}`;
  return { bank: b.bank, number, label: label.slice(0, 60), isOverdraft: Boolean(b.isOverdraft) };
}

/**
 * An NPWP as the books keep it: blank stays blank, 15 digits print as 99.999.999.9-999.999, 16 digits (NIK-based) as is. Dots, dashes and
 * spaces may be typed; anything else, or any other count of digits, is null (not an NPWP).
 */
export function normalizeNpwp(raw: string): string | null {
  const s = raw.trim();
  if (!s) return "";
  if (!/^[\d.\-\s]+$/.test(s)) return null;
  const d = s.replace(/\D/g, "");
  if (d.length === 16) return d;
  if (d.length === 15) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}.${d[8]}-${d.slice(9, 12)}.${d.slice(12)}`;
  return null;
}

/** One entity with its bank rows; empty rows are skipped but keep their place, so error keys name the rows the form shows. */
function cleanEntity(e: EntityInput, at: string, fields: Record<string, string>, seen: Map<string, string>, duplicate?: string) {
  const eName = e.name.trim();
  if (!eName) fields[`${at}.name`] = e.kind === "PERORANGAN" ? "Isi nama pemilik." : "Isi nama badan usaha.";
  if (!KINDS.includes(e.kind)) fields[`${at}.kind`] = "Pilih jenis entitas.";
  const npwp = normalizeNpwp(e.npwp);
  if (npwp === null) fields[`${at}.npwp`] = "NPWP berisi 15 atau 16 angka, boleh dengan titik dan strip.";
  const currency = (e.currency ?? "IDR").trim().toUpperCase();
  if (!isCurrency(currency)) fields[`${at}.currency`] = "Pilih mata uang dari daftar.";
  const reportingFramework = e.reportingFramework ?? (e.kind === "PERORANGAN" ? "SAK_EMKM" : "SAK_EP");
  if (!isFramework(reportingFramework)) fields[`${at}.reportingFramework`] = "Pilih kerangka pelaporan.";
  const banks = e.banks.flatMap((b, k) => cleanBank(b, `${at}.banks.${k}`, fields, seen, duplicate) ?? []);
  return { name: eName, shortName: e.shortName.trim() || eName, kind: e.kind, npwp: npwp || undefined, functionalCurrency: currency, reportingFramework, banks };
}

/** Every problem at once, keyed by field. Optional: industry, short name, NPWP, framework (SAK EP), bank accounts (an empty row is ignored), account label (defaults to "BCA ••5566"). */
export function validateNewClient(input: NewClientInput): ClientSpec {
  const fields: Record<string, string> = {};
  const name = input.name.trim();
  if (!name) fields.name = "Isi nama klien.";
  else if (name.length > 120) fields.name = "Nama klien maksimal 120 karakter.";
  if (input.entities.length === 0) fields.entities = "Tambahkan minimal satu entitas.";

  const seen = new Map<string, string>();
  const entities = input.entities.map((e, i) => cleanEntity(e, `entities.${i}`, fields, seen));
  if (seen.size > 9) fields.entities = "Maksimal 9 rekening bank per klien.";
  if (Object.keys(fields).length) throw new OnboardingError(fields);

  // Companies first, then owners — the order every list in the app uses.
  const rank = { PT: 0, CV: 1, BADAN_USAHA_ASING: 2, PERORANGAN: 3 } as const;
  return { name, industry: input.industry.trim(), entities: [...entities].sort((a, b) => rank[a.kind] - rank[b.kind]) };
}

export async function addClient(db: Db, firmId: string, input: NewClientInput, creator?: ClientCreator) {
  const spec = validateNewClient(input);
  const { client } = await db.$transaction((tx) => createClient(tx, firmId, spec, { creator }));
  return client;
}

/** The 9-account limit surfaces as a field message, not as an unexpected error. */
const limitReached = (field: string) => (e: unknown): never => {
  if (e instanceof Error && e.message.startsWith("Maksimal 9 rekening")) throw new OnboardingError({ [field]: `${e.message}.` });
  throw e;
};

export const TAKEN = "Nomor ini sudah dipakai rekening lain di klien ini.";
export const SHORT_NAME_TAKEN = "Nama singkat ini sudah dipakai perusahaan lain di klien ini.";

/** Bank numbers of the client, so an added account can't repeat one (the form rule for a new client is the same). */
export async function takenNumbers(db: Db, clientId: string) {
  const banks = await db.bankAccount.findMany({ where: { entity: { clientId } }, select: { number: true } });
  return new Map(banks.map((b) => [b.number, "bank"] as const));
}

/** "Tambah rekening" on an existing entity: one GL bank account (next free 1101–1109, PRK 2201–2209) and the account, in one transaction. */
export async function addBankAccount(db: Db, firmId: string, clientId: string, entityId: string, input: BankInput) {
  const entity = await db.entity.findFirst({ where: { id: entityId, clientId, firmId }, select: { id: true, shortName: true } });
  if (!entity) throw new OnboardingError({ entityId: "Perusahaan tidak ditemukan di klien ini." });
  const fields: Record<string, string> = {};
  const bank = cleanBank(input, "bank", fields, await takenNumbers(db, clientId), TAKEN);
  if (!bank && !Object.keys(fields).length) fields["bank.number"] = "Isi nomor rekening.";
  if (Object.keys(fields).length || !bank) throw new OnboardingError(fields);
  return db.$transaction(async (tx) => createBankAccount(tx, firmId, clientId, entity, bank, await freeGlCodes(tx, clientId))).catch(limitReached("bank"));
}

/** "Tambah perusahaan atau pemilik" on an existing client, with an optional first bank account. */
export async function addEntity(db: Db, firmId: string, clientId: string, input: EntityInput) {
  const client = await db.client.findFirst({ where: { id: clientId, firmId }, select: { id: true } });
  if (!client) throw new OnboardingError({ entity: "Klien tidak ditemukan." });
  const fields: Record<string, string> = {};
  const spec = cleanEntity(input, "entity", fields, await takenNumbers(db, clientId), TAKEN);
  // The ledger import matches a file's entity column by short name, so it stays unique on the client (a rename checks the same).
  const shorts = (await db.entity.findMany({ where: { clientId }, select: { shortName: true } })).map((e) => e.shortName.trim().toLowerCase());
  if (shorts.includes(spec.shortName.toLowerCase())) fields["entity.shortName"] = SHORT_NAME_TAKEN;
  if (Object.keys(fields).length) throw new OnboardingError(fields);
  return db
    .$transaction(async (tx) => {
      const { entity } = await createEntity(tx, firmId, clientId, spec, await freeGlCodes(tx, clientId));
      await ensureIntercompanyAccounts(tx, clientId); // the third company gives every company its intercompany account
      return entity;
    })
    .catch(limitReached("entity"));
}

/**
 * The bank a bank account is recorded at, corrected (the import says when a file names another bank). Only the label: no number,
 * GL account or posted line changes. The account must be one of the client's.
 */
export async function setBankAccountBank(db: Db, clientId: string, bankAccountId: string, bank: string) {
  if (!(BANK_CODES as readonly string[]).includes(bank)) throw new OnboardingError({ bank: "Pilih bank." });
  const account = await db.bankAccount.findFirst({ where: { id: bankAccountId, entity: { clientId } }, select: { id: true } });
  if (!account) throw new OnboardingError({ bank: "Rekening tidak ditemukan di klien ini." });
  return db.bankAccount.update({ where: { id: account.id }, data: { bank: bank as BankCode } });
}
