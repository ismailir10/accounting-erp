import type { Db, Tx } from "@/lib/db";
import { intercompanyName } from "@/lib/coa/intercompany";
import { Prisma } from "@/lib/generated/prisma/client";
import { recordEvent } from "@/lib/audit";
import { npwp16, readNitku } from "@/lib/tax/coretax-codes";
import { cleanBank, normalizeNpwp, OnboardingError, takenNumbers, TAKEN, SHORT_NAME_TAKEN, type BankInput } from "@/lib/onboarding";

/**
 * Fix a company/owner or a bank account entered by mistake (Pengaturan klien → *Perusahaan & rekening*; the caller checks the role:
 * removal is admin only). Cycle docs/cycles/2026-10-12-entity-bank-edit.md.
 *
 * Names are labels: a rename never touches a journal, a period or a figure, only the bank GL account names built from `label (shortName)`.
 * Removal is for something still empty: anything a posted entry, a bank row, an import, a draft or a register points to stays
 * (accounting-rules 3) and is refused with the reason. The foreign keys are the last line of defence: a delete that races a concurrent
 * write fails instead of cascading. Every change is in Riwayat.
 */
export class EntityEditError extends Error {}

export type Usage = { label: string; n: number }[];

/**
 * What can point at a company/owner (by `entityId`), a bank account (by `bankAccountId`), its GL account (by account id) or its code
 * (a bank row or split filed to it, a client rule or remembered choice that would file to it — the code would point at the next account
 * added). Labels are the words the reason uses; table and column names are fixed identifiers, never input.
 */
const BY_ENTITY: [label: string, table: string][] = [
  ["jurnal (termasuk saldo awal)", "JournalEntry"],
  ["mutasi bank", "BankTransaction"],
  ["akun dari impor buku besar", "SourceAccount"],
  ["jadwal penyesuaian", "AdjustmentSchedule"],
  ["usulan jurnal", "ProposedEntry"],
  ["aset tetap", "FixedAsset"],
  ["faktur", "Invoice"],
  ["tahun pajak", "TaxYear"],
  ["pengaturan CKPN", "CkpnSetting"],
  ["sewa", "Lease"],
  ["karyawan", "Employee"],
  ["pengaturan imbalan kerja", "BenefitSetting"],
  ["posting imbalan kerja", "BenefitPosting"],
  ["stok opname", "InventoryCount"],
  ["rekonsiliasi subledger", "SubledgerImport"],
  ["temuan", "Finding"],
  ["catatan laporan", "ReportComment"],
  ["penjelasan akun laba rugi", "FluxExplanation"],
  ["faktur Coretax", "CoretaxFaktur"],
  ["bukti potong Coretax", "CoretaxBupot"],
  ["angsuran PPh 25", "TaxInstalment"],
  ["dokumen yang dikonfirmasi untuk perusahaan ini", "EvidenceSelection"],
  ["pemeriksaan impor buku besar", "ImportCheck"],
  ["anggaran", "Budget"],
];
const DRAFT = "draf impor buku besar";
const LOCKED_NOTE = "catatan kontrol di bulan yang sudah ditutup";
const BY_BANK: [label: string, table: string][] = [
  ["impor rekening koran", "StatementImport"],
  ["mutasi bank", "BankTransaction"],
  ["draf rekening koran hasil baca", "OcrDraft"],
  ["dokumen yang dikonfirmasi sebagai rekening koran ini", "EvidenceSelection"],
];
const BY_GL: [label: string, table: string, column: string][] = [
  ["baris jurnal", "JournalLine", "accountId"],
  ["pemetaan akun dari impor buku besar", "SourceAccount", "accountId"],
  ["kredit pajak", "TaxCredit", "accountId"],
  ["koreksi fiskal", "FiscalCorrection", "accountId"],
  ["faktur", "Invoice", "counterAccountId"],
  ["faktur", "Invoice", "arApAccountId"],
  ["jadwal penyesuaian", "AdjustmentSchedule", "debitAccountId"],
  ["jadwal penyesuaian", "AdjustmentSchedule", "creditAccountId"],
  ["jadwal penyesuaian", "AdjustmentSchedule", "sourceAccountId"],
  ["aset tetap", "FixedAsset", "assetAccountId"],
  ["aset tetap", "FixedAsset", "accumulatedAccountId"],
];
const BY_CODE = { c: "mutasi yang diklasifikasikan ke akun ini", r: "aturan klasifikasi ke akun ini", m: "pilihan yang diingat ke akun ini" } as const;

const add = (usage: Usage, label: string, n: number | undefined) => {
  if (!n) return;
  const same = usage.find((u) => u.label === label);
  if (same) same.n += n;
  else usage.push({ label, n });
};

/** What reads a bank account's number: once any of these exist, the number stays (Unggah routes files by it). */
const NUMBER_READ = new Set(["impor rekening koran", "mutasi bank", "draf rekening koran hasil baca", "dokumen yang dikonfirmasi sebagai rekening koran ini"]);

export type ClientUsage = { entities: Map<string, Usage>; banks: Map<string, Usage> };

/**
 * What points at every company/owner and bank account of a client (empty = removable), in one round trip: the settings page shows it
 * and the removal re-runs it inside its transaction, so the reason shown is the reason enforced.
 */
export async function clientUsage(db: Db | Tx, clientId: string): Promise<ClientUsage> {
  const entities = await db.entity.findMany({ where: { clientId }, select: { id: true, bankAccounts: { select: { id: true, accountId: true, account: { select: { code: true } } } } } });
  const entityIds = entities.map((e) => e.id);
  const banks = entities.flatMap((e) => e.bankAccounts);
  const bankIds = banks.map((b) => b.id);
  const glIds = banks.map((b) => b.accountId);
  const codes = banks.map((b) => b.account.code);
  const count = (key: string, table: string, column: string, ids: string[]) =>
    Prisma.sql`SELECT ${key} AS k, ${Prisma.raw(`"${column}"`)} AS id, count(*)::int AS n FROM ${Prisma.raw(`"${table}"`)} WHERE ${Prisma.raw(`"${column}"`)} = ANY(${ids}::text[]) GROUP BY 2`;
  const parts = [
    ...BY_ENTITY.map(([, table], i) => count(`e${i}`, table, "entityId", entityIds)),
    ...BY_BANK.map(([, table], i) => count(`b${i}`, table, "bankAccountId", bankIds)),
    ...BY_GL.map(([, table, column], i) => count(`g${i}`, table, column, glIds)),
    // By code, within this client: its bank rows and their splits, its own rules and remembered choices (firm rules are templates).
    Prisma.sql`SELECT 'c' AS k, "accountCode" AS id, count(*)::int AS n FROM "BankTransaction" WHERE "bankAccountId" = ANY(${bankIds}::text[]) AND "accountCode" = ANY(${codes}::text[]) GROUP BY 2`,
    Prisma.sql`SELECT 'c' AS k, "suggestedCode" AS id, count(*)::int AS n FROM "BankTransaction" WHERE "bankAccountId" = ANY(${bankIds}::text[]) AND "suggestedCode" = ANY(${codes}::text[]) GROUP BY 2`,
    Prisma.sql`SELECT 'c' AS k, s."accountCode" AS id, count(*)::int AS n FROM "BankTxSplit" s JOIN "BankTransaction" t ON t.id = s."bankTransactionId" WHERE t."bankAccountId" = ANY(${bankIds}::text[]) AND s."accountCode" = ANY(${codes}::text[]) GROUP BY 2`,
    Prisma.sql`SELECT 'r' AS k, "accountCode" AS id, count(*)::int AS n FROM "Rule" WHERE "clientId" = ${clientId} AND "accountCode" = ANY(${codes}::text[]) GROUP BY 2`,
    Prisma.sql`SELECT 'm' AS k, "accountCode" AS id, count(*)::int AS n FROM "Memory" WHERE "clientId" = ${clientId} AND "accountCode" = ANY(${codes}::text[]) GROUP BY 2`,
    // A note on a control of a month already closed is part of that close: it stays, so the company or rekening it names stays too.
    Prisma.sql`SELECT 'l' AS k, x.id, count(*)::int AS n FROM unnest(${[...entityIds, ...bankIds]}::text[]) AS x(id) JOIN "ControlAck" a ON strpos(a."controlKey", x.id) > 0 JOIN "Period" p ON p.id = a."periodId" AND p."clientId" = ${clientId} AND p.status = 'LOCKED' GROUP BY 2`,
    // A draft ledger import keeps its entity mapping in JSON until it is posted.
    Prisma.sql`SELECT 'd' AS k, e.id, count(*)::int AS n FROM unnest(${entityIds}::text[]) AS e(id) JOIN "LedgerImport" l ON l."clientId" = ${clientId} AND l.status = 'DRAFT' AND strpos(l.data::text, e.id) > 0 GROUP BY 2`,
  ];
  const rows = entityIds.length ? await db.$queryRaw<{ k: string; id: string; n: number }[]>`${Prisma.join(parts, " UNION ALL ")}` : [];

  const glToBank = new Map(banks.map((b) => [b.accountId, b.id]));
  const codeToBank = new Map(banks.map((b) => [b.account.code, b.id]));
  const own = new Map(entityIds.map((id) => [id, [] as Usage]));
  const bankUsage = new Map(bankIds.map((id) => [id, [] as Usage]));
  // In the order the lists above are written, so the reason reads the same every time.
  const rank = (k: string) => "edlbgcrm".indexOf(k[0]) * 100 + (Number(k.slice(1)) || 0);
  for (const r of [...rows].sort((a, b) => rank(a.k) - rank(b.k))) {
    const kind = r.k[0];
    const i = Number(r.k.slice(1));
    if (kind === "e") add(own.get(r.id)!, BY_ENTITY[i][0], r.n);
    else if (kind === "d") add(own.get(r.id)!, DRAFT, r.n);
    else if (kind === "l") add((own.get(r.id) ?? bankUsage.get(r.id))!, LOCKED_NOTE, r.n);
    else if (kind === "b") add(bankUsage.get(r.id)!, BY_BANK[i][0], r.n);
    else if (kind === "g") add(bankUsage.get(glToBank.get(r.id)!)!, BY_GL[i][0], r.n);
    else add(bankUsage.get(codeToBank.get(r.id)!)!, BY_CODE[kind as keyof typeof BY_CODE], r.n);
  }

  const entityUsage = new Map<string, Usage>();
  for (const ent of entities) {
    const usage = own.get(ent.id)!;
    // Its bank accounts add only what the entity's own counts can't show: their rows are the entity's rows, their journal lines its journals.
    const hasEntries = usage.some((u) => u.label === BY_ENTITY[0][0]);
    for (const b of ent.bankAccounts) {
      for (const u of bankUsage.get(b.id)!) {
        if (u.label === "mutasi bank" || (u.label === "baris jurnal" && hasEntries)) continue;
        add(usage, u.label, u.n);
      }
    }
    entityUsage.set(ent.id, usage);
  }
  return { entities: entityUsage, banks: bankUsage };
}

/** Whether a bank account's number may still change: nothing was read for it yet. */
export const numberLocked = (usage: Usage) => usage.some((u) => NUMBER_READ.has(u.label));

const list = (u: Usage) => u.map((x) => `${x.n.toLocaleString("id-ID")} ${x.label}`).join(", ");

export const LAST_ENTITY = "Klien harus punya minimal satu perusahaan atau pemilik. Kalau seluruh klien salah dimasukkan, hapus kliennya (admin).";

/** The sentence shown where *Hapus* would be (and in the refusal), or null when nothing blocks. */
export function blockedReason(kind: "entity" | "bank", usage: Usage): string | null {
  if (!usage.length) return null;
  return kind === "entity"
    ? `Sudah ada ${list(usage)}. Pembukuan yang sudah tercatat tidak bisa dihapus; koreksi lewat Jurnal Penyesuaian.`
    : `Sudah ada ${list(usage)}. Rekening yang sudah dipakai tidak bisa dihapus.`;
}

const raced = (what: string) => (e: unknown): never => {
  if (typeof e === "object" && e !== null && (e as { code?: string }).code === "P2003") {
    throw new EntityEditError(`${what} baru saja dipakai (ada data yang masuk saat dihapus), jadi tidak dihapus. Muat ulang halaman.`);
  }
  throw e;
};

/** The name of a bank GL account: what createBankAccount() writes. */
export const glName = (label: string, shortName: string) => `${label} (${shortName})`;

type Actor = { firmId: string; clientId: string; actorId?: string | null };

/** E1: name, short name, NPWP and (when given) the seller NITKU. Labels only — the bank GL names follow, nothing else moves. */
export async function renameEntity(db: Db, input: Actor & { entityId: string; name: string; shortName: string; npwp: string; nitku?: string }) {
  const entity = await db.entity.findFirst({ where: { id: input.entityId, clientId: input.clientId, firmId: input.firmId }, include: { bankAccounts: { select: { accountId: true, label: true } } } });
  if (!entity) throw new OnboardingError({ entity: "Perusahaan tidak ditemukan di klien ini." });
  const fields: Record<string, string> = {};
  const name = input.name.trim();
  if (!name) fields.name = entity.kind === "PERORANGAN" ? "Isi nama pemilik." : "Isi nama badan usaha.";
  else if (name.length > 120) fields.name = "Nama maksimal 120 karakter.";
  const shortName = input.shortName.trim() || name;
  if (shortName.length > 60) fields.shortName = "Nama singkat maksimal 60 karakter.";
  const npwp = entity.kind === "BADAN_USAHA_ASING" ? "" : normalizeNpwp(input.npwp);
  if (npwp === null) fields.npwp = "NPWP berisi 15 atau 16 angka, boleh dengan titik dan strip.";
  // The seller NITKU of the Coretax faktur file (cycle 2026-10-17-coretax-files); undefined keeps it.
  const typed = input.nitku === undefined ? undefined : readNitku(input.nitku, npwp ? npwp16(npwp) : null, "perusahaan");
  if (typed && !typed.ok) fields.nitku = typed.error;
  const nitku = typed?.ok ? typed.nitku : undefined;
  // The ledger import matches a file's entity column by short name: two with the same one would make that ambiguous.
  if (!fields.shortName && shortName) {
    const siblings = await db.entity.findMany({ where: { clientId: input.clientId, id: { not: entity.id } }, select: { shortName: true } });
    if (siblings.some((s) => s.shortName.trim().toLowerCase() === shortName.toLowerCase())) fields.shortName = SHORT_NAME_TAKEN;
  }
  if (Object.keys(fields).length) throw new OnboardingError(fields);
  const before = { name: entity.name, shortName: entity.shortName, npwp: entity.npwp ?? "", ...(nitku === undefined ? {} : { nitku: entity.nitku ?? "" }) };
  const after = { name, shortName, npwp: npwp ?? "", ...(nitku === undefined ? {} : { nitku: nitku ?? "" }) };
  if (JSON.stringify(before) === JSON.stringify(after)) return entity;
  return db.$transaction(async (tx) => {
    const updated = await tx.entity.update({ where: { id: entity.id }, data: { name, shortName, npwp: npwp || null, ...(nitku === undefined ? {} : { nitku }) } });
    for (const b of entity.bankAccounts) await tx.account.update({ where: { id: b.accountId }, data: { name: glName(b.label, shortName) } });
    await tx.account.updateMany({ where: { clientId: input.clientId, counterpartyEntityId: entity.id }, data: { name: intercompanyName(shortName) } });
    await recordEvent(tx, { clientId: input.clientId, entityId: entity.id, kind: "COMPANY_BANK", subject: `entity:${entity.id}`, summary: `Data ${before.name} diubah${before.name !== name ? ` menjadi ${name}` : ""}`, before, after, actorId: input.actorId });
    return updated;
  });
}

/** E2: label and bank any time (labels; the GL name follows the label); the number only while nothing was read for the account. */
export async function updateBankAccount(db: Db, input: Actor & { bankAccountId: string; label: string; bank: BankInput["bank"]; number: string }) {
  const ba = await db.bankAccount.findFirst({ where: { id: input.bankAccountId, entity: { clientId: input.clientId, firmId: input.firmId } }, include: { entity: { select: { id: true, shortName: true } } } });
  if (!ba) throw new OnboardingError({ bankAccountId: "Rekening tidak ditemukan di klien ini." });
  const fields: Record<string, string> = {};
  const taken = await takenNumbers(db, input.clientId);
  taken.delete(ba.number); // its own number is not a duplicate
  const clean = cleanBank({ bank: input.bank, number: input.number, label: input.label, isOverdraft: ba.isOverdraft }, "bank", fields, taken, TAKEN);
  if (!clean && !Object.keys(fields).length) fields["bank.number"] = "Isi nomor rekening.";
  if (Object.keys(fields).length || !clean) throw new OnboardingError(fields);
  const before = { label: ba.label, bank: ba.bank, number: ba.number };
  const after = { label: clean.label, bank: clean.bank, number: clean.number };
  if (JSON.stringify(before) === JSON.stringify(after)) return ba;
  return db.$transaction(async (tx) => {
    if (clean.number !== ba.number) {
      // Checked under the account's row lock: a statement being imported for it takes a key-share lock on the same row, so it either
      // committed before this check (and the number stays) or waits until the new number is in.
      await tx.$queryRaw`SELECT id FROM "BankAccount" WHERE id = ${ba.id} FOR UPDATE`;
      if (numberLocked((await clientUsage(tx, input.clientId)).banks.get(ba.id) ?? [])) {
        throw new OnboardingError({ "bank.number": "Rekening koran rekening ini sudah dibaca, jadi nomornya tetap (file berikutnya dicocokkan dengan nomor ini). Ubah nama atau banknya saja, atau tambahkan rekening baru." });
      }
    }
    const updated = await tx.bankAccount.update({ where: { id: ba.id }, data: after });
    await tx.account.update({ where: { id: ba.accountId }, data: { name: glName(clean.label, ba.entity.shortName) } });
    await recordEvent(tx, { clientId: input.clientId, entityId: ba.entity.id, kind: "COMPANY_BANK", subject: `bankAccount:${ba.id}`, summary: `Rekening ${ba.label} diubah${ba.label !== clean.label ? ` menjadi ${clean.label}` : ""}`, before, after, actorId: input.actorId });
    return updated;
  });
}

/** Close notes keyed by a company or bank account ("<control>:<id>") in open months: an empty one has none worth keeping (a closed month's block removal). */
const dropAcks = (tx: Tx, clientId: string, ids: string[]) => tx.controlAck.deleteMany({ where: { period: { clientId }, OR: ids.map((id) => ({ controlKey: { contains: id } })) } });

/** E3: a bank account nothing points to, with its GL account (the code is free for the next add). */
export async function removeBankAccount(db: Db, input: Actor & { bankAccountId: string }) {
  const ba = await db.bankAccount.findFirst({ where: { id: input.bankAccountId, entity: { clientId: input.clientId, firmId: input.firmId } }, select: { id: true, accountId: true, label: true, bank: true, number: true, entityId: true } });
  if (!ba) throw new EntityEditError("Rekening tidak ditemukan di klien ini.");
  return db
    .$transaction(async (tx) => {
      const reason = blockedReason("bank", (await clientUsage(tx, input.clientId)).banks.get(ba.id) ?? []);
      if (reason) throw new EntityEditError(reason);
      await dropAcks(tx, input.clientId, [ba.id]);
      await tx.bankAccount.delete({ where: { id: ba.id } });
      await tx.account.delete({ where: { id: ba.accountId } });
      await recordEvent(tx, { clientId: input.clientId, entityId: ba.entityId, kind: "COMPANY_BANK", subject: `bankAccount:${ba.id}`, summary: `Rekening ${ba.label} dihapus`, before: { label: ba.label, bank: ba.bank, number: ba.number }, actorId: input.actorId });
      return { label: ba.label };
    })
    .catch(raced("Rekening ini"));
}

/** E4: a company/owner nothing points to, with its empty bank accounts; the client keeps at least one. */
export async function removeEntity(db: Db, input: Actor & { entityId: string }) {
  const entity = await db.entity.findFirst({ where: { id: input.entityId, clientId: input.clientId, firmId: input.firmId }, select: { id: true, name: true, shortName: true, kind: true } });
  if (!entity) throw new EntityEditError("Perusahaan tidak ditemukan di klien ini.");
  return db
    .$transaction(async (tx) => {
      // The client's row serialises removals (two admins can't each remove one of the last two) without holding back other writes to the
      // client; the entity's row holds back a rekening being added to it (its insert takes a key-share lock on it), so the bank accounts
      // read next are all there are.
      await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${input.clientId} FOR NO KEY UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Entity" WHERE id = ${entity.id} FOR UPDATE`;
      if ((await tx.entity.count({ where: { clientId: input.clientId } })) < 2) throw new EntityEditError(LAST_ENTITY);
      const reason = blockedReason("entity", (await clientUsage(tx, input.clientId)).entities.get(entity.id) ?? []);
      if (reason) throw new EntityEditError(reason);
      const banks = await tx.bankAccount.findMany({ where: { entityId: entity.id }, select: { id: true, accountId: true, label: true } });
      await dropAcks(tx, input.clientId, [entity.id, ...banks.map((b) => b.id)]);
      await tx.bankAccount.deleteMany({ where: { id: { in: banks.map((b) => b.id) } } });
      await tx.account.deleteMany({ where: { id: { in: banks.map((b) => b.accountId) } } });
      // Its intercompany account (a group of three or more) goes with it while no company has recorded anything on it.
      const ic = await tx.account.findFirst({ where: { clientId: input.clientId, counterpartyEntityId: entity.id }, select: { id: true, code: true, name: true, _count: { select: { lines: true } } } });
      if (ic?._count.lines) throw new EntityEditError(`${ic.code} ${ic.name} masih berisi saldo perusahaan lain dengan ${entity.shortName}. Selesaikan saldonya dulu.`);
      if (ic) await tx.account.delete({ where: { id: ic.id } });
      await tx.entity.delete({ where: { id: entity.id } });
      await recordEvent(tx, {
        clientId: input.clientId,
        entityId: entity.id,
        kind: "COMPANY_BANK",
        subject: `entity:${entity.id}`,
        summary: `${entity.name} dihapus${banks.length ? ` beserta ${banks.length} rekening kosong` : ""}`,
        before: { name: entity.name, shortName: entity.shortName, kind: entity.kind, bankAccounts: banks.map((b) => b.label) },
        actorId: input.actorId,
      });
      return { name: entity.name, bankAccounts: banks.length };
    })
    .catch(raced("Perusahaan ini"));
}
