import type { Db, Tx } from "@/lib/db";
import { recordEvent } from "@/lib/audit";
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

type Counted = { _count: { _all: number } };

/** groupBy rows → id → count. */
function tally<K extends string>(key: K, rows: (Counted & Record<K, string | null>)[]): Map<string, number> {
  return new Map(rows.flatMap((r) => (r[key] ? [[r[key]!, r._count._all] as const] : [])));
}

/** Counts of one thing grouped on several columns (an invoice's two accounts), added up. */
function sum(...maps: Map<string, number>[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const one of maps) for (const [k, n] of one) m.set(k, (m.get(k) ?? 0) + n);
  return m;
}

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
 * What points at every company/owner and bank account of a client (empty = removable), in one query per table. The settings page and the
 * removal (inside its transaction) read the same function, so the reason shown is the reason enforced.
 */
export async function clientUsage(db: Db | Tx, clientId: string): Promise<ClientUsage> {
  const entities = await db.entity.findMany({ where: { clientId }, select: { id: true, bankAccounts: { select: { id: true, accountId: true, account: { select: { code: true } } } } } });
  const entityIds = entities.map((e) => e.id);
  const banks = entities.flatMap((e) => e.bankAccounts);
  const bankIds = banks.map((b) => b.id);
  const glIds = banks.map((b) => b.accountId);
  const codes = banks.map((b) => b.account.code);
  const byEntity = { entityId: { in: entityIds } };
  const byBank = { bankAccountId: { in: bankIds } };
  const all = { _all: true } as const;
  const onClient = { bankAccount: { entity: { clientId } } };

  const [
    entries, rows, sources, schedules, proposals, assets, invoices, taxYears, ckpn, leases, employees, benefitSettings, benefitPostings, stock,
    subledgers, findings, comments, faktur, bupot, instalments, selections, checks, drafts,
    imports, bankRows, ocr, bankSelections, lines, sourceMaps, credits, corrections, invCounter, invArAp, schDebit, schCredit, schSource, faAsset, faAccum,
    classified, suggested, splits, rules, memories,
  ] = await Promise.all([
    db.journalEntry.groupBy({ by: ["entityId"], where: byEntity, _count: all }),
    db.bankTransaction.groupBy({ by: ["entityId"], where: byEntity, _count: all }),
    db.sourceAccount.groupBy({ by: ["entityId"], where: byEntity, _count: all }),
    db.adjustmentSchedule.groupBy({ by: ["entityId"], where: byEntity, _count: all }),
    db.proposedEntry.groupBy({ by: ["entityId"], where: byEntity, _count: all }),
    db.fixedAsset.groupBy({ by: ["entityId"], where: byEntity, _count: all }),
    db.invoice.groupBy({ by: ["entityId"], where: byEntity, _count: all }),
    db.taxYear.groupBy({ by: ["entityId"], where: byEntity, _count: all }),
    db.ckpnSetting.groupBy({ by: ["entityId"], where: byEntity, _count: all }),
    db.lease.groupBy({ by: ["entityId"], where: byEntity, _count: all }),
    db.employee.groupBy({ by: ["entityId"], where: byEntity, _count: all }),
    db.benefitSetting.groupBy({ by: ["entityId"], where: byEntity, _count: all }),
    db.benefitPosting.groupBy({ by: ["entityId"], where: byEntity, _count: all }),
    db.inventoryCount.groupBy({ by: ["entityId"], where: byEntity, _count: all }),
    db.subledgerImport.groupBy({ by: ["entityId"], where: byEntity, _count: all }),
    db.finding.groupBy({ by: ["entityId"], where: byEntity, _count: all }),
    db.reportComment.groupBy({ by: ["entityId"], where: byEntity, _count: all }),
    db.coretaxFaktur.groupBy({ by: ["entityId"], where: byEntity, _count: all }),
    db.coretaxBupot.groupBy({ by: ["entityId"], where: byEntity, _count: all }),
    db.taxInstalment.groupBy({ by: ["entityId"], where: byEntity, _count: all }),
    db.evidenceSelection.groupBy({ by: ["entityId"], where: byEntity, _count: all }),
    db.importCheck.groupBy({ by: ["entityId"], where: byEntity, _count: all }),
    // A draft ledger import keeps its entity mapping in JSON until it is posted.
    db.ledgerImport.findMany({ where: { clientId, status: "DRAFT" }, select: { data: true } }),

    db.statementImport.groupBy({ by: ["bankAccountId"], where: byBank, _count: all }),
    db.bankTransaction.groupBy({ by: ["bankAccountId"], where: byBank, _count: all }),
    db.ocrDraft.groupBy({ by: ["bankAccountId"], where: { clientId, ...byBank }, _count: all }),
    db.evidenceSelection.groupBy({ by: ["bankAccountId"], where: byBank, _count: all }),
    db.journalLine.groupBy({ by: ["accountId"], where: { accountId: { in: glIds } }, _count: all }),
    db.sourceAccount.groupBy({ by: ["accountId"], where: { accountId: { in: glIds } }, _count: all }),
    db.taxCredit.groupBy({ by: ["accountId"], where: { accountId: { in: glIds } }, _count: all }),
    db.fiscalCorrection.groupBy({ by: ["accountId"], where: { accountId: { in: glIds } }, _count: all }),
    db.invoice.groupBy({ by: ["counterAccountId"], where: { counterAccountId: { in: glIds } }, _count: all }),
    db.invoice.groupBy({ by: ["arApAccountId"], where: { arApAccountId: { in: glIds } }, _count: all }),
    db.adjustmentSchedule.groupBy({ by: ["debitAccountId"], where: { debitAccountId: { in: glIds } }, _count: all }),
    db.adjustmentSchedule.groupBy({ by: ["creditAccountId"], where: { creditAccountId: { in: glIds } }, _count: all }),
    db.adjustmentSchedule.groupBy({ by: ["sourceAccountId"], where: { sourceAccountId: { in: glIds } }, _count: all }),
    db.fixedAsset.groupBy({ by: ["assetAccountId"], where: { assetAccountId: { in: glIds } }, _count: all }),
    db.fixedAsset.groupBy({ by: ["accumulatedAccountId"], where: { accumulatedAccountId: { in: glIds } }, _count: all }),
    // By code: a bank row or split filed to the account, a client rule or a remembered choice that would file to it.
    db.bankTransaction.groupBy({ by: ["accountCode"], where: { ...onClient, accountCode: { in: codes } }, _count: all }),
    db.bankTransaction.groupBy({ by: ["suggestedCode"], where: { ...onClient, suggestedCode: { in: codes } }, _count: all }),
    db.bankTxSplit.groupBy({ by: ["accountCode"], where: { bankTransaction: onClient, accountCode: { in: codes } }, _count: all }),
    db.rule.groupBy({ by: ["accountCode"], where: { clientId, accountCode: { in: codes } }, _count: all }),
    db.memory.groupBy({ by: ["accountCode"], where: { clientId, accountCode: { in: codes } }, _count: all }),
  ]);

  const e = (rows: (Counted & { entityId: string | null })[]) => tally("entityId", rows);
  const ownLists: [string, Map<string, number>][] = [
    ["jurnal (termasuk saldo awal)", e(entries)],
    ["mutasi bank", e(rows)],
    ["akun dari impor buku besar", e(sources)],
    ["draf impor buku besar", new Map(entityIds.map((id) => [id, drafts.filter((d) => JSON.stringify(d.data).includes(id)).length]))],
    ["jadwal penyesuaian", e(schedules)],
    ["usulan jurnal", e(proposals)],
    ["aset tetap", e(assets)],
    ["faktur", e(invoices)],
    ["tahun pajak", e(taxYears)],
    ["pengaturan CKPN", e(ckpn)],
    ["sewa", e(leases)],
    ["karyawan", e(employees)],
    ["pengaturan imbalan kerja", e(benefitSettings)],
    ["posting imbalan kerja", e(benefitPostings)],
    ["stok opname", e(stock)],
    ["rekonsiliasi subledger", e(subledgers)],
    ["temuan", e(findings)],
    ["catatan laporan", e(comments)],
    ["faktur Coretax", e(faktur)],
    ["bukti potong Coretax", e(bupot)],
    ["angsuran PPh 25", e(instalments)],
    ["dokumen yang dikonfirmasi untuk perusahaan ini", e(selections)],
    ["pemeriksaan impor buku besar", e(checks)],
  ];
  const gl = new Map(banks.map((b) => [b.accountId, b.id]));
  const code = new Map(banks.map((b) => [b.account.code, b.id]));
  const toBank = (from: Map<string, string>, counts: Map<string, number>): Map<string, number> => new Map([...counts].map(([k, n]) => [from.get(k)!, n]));
  const bankLists: [string, Map<string, number>][] = [
    ["impor rekening koran", tally("bankAccountId", imports)],
    ["mutasi bank", tally("bankAccountId", bankRows)],
    ["draf rekening koran hasil baca", tally("bankAccountId", ocr)],
    ["dokumen yang dikonfirmasi sebagai rekening koran ini", tally("bankAccountId", bankSelections)],
    ["baris jurnal", toBank(gl, tally("accountId", lines))],
    ["pemetaan akun dari impor buku besar", toBank(gl, tally("accountId", sourceMaps))],
    ["kredit pajak", toBank(gl, tally("accountId", credits))],
    ["koreksi fiskal", toBank(gl, tally("accountId", corrections))],
    ["faktur", toBank(gl, sum(tally("counterAccountId", invCounter), tally("arApAccountId", invArAp)))],
    ["jadwal penyesuaian", toBank(gl, sum(tally("debitAccountId", schDebit), tally("creditAccountId", schCredit), tally("sourceAccountId", schSource)))],
    ["aset tetap", toBank(gl, sum(tally("assetAccountId", faAsset), tally("accumulatedAccountId", faAccum)))],
    ["mutasi yang diklasifikasikan ke akun ini", toBank(code, sum(tally("accountCode", classified), tally("suggestedCode", suggested), tally("accountCode", splits)))],
    ["aturan klasifikasi ke akun ini", toBank(code, tally("accountCode", rules))],
    ["pilihan yang diingat ke akun ini", toBank(code, tally("accountCode", memories))],
  ];

  const bankUsage = new Map(bankIds.map((id) => [id, [] as Usage]));
  for (const [label, counts] of bankLists) for (const [id, n] of counts) add(bankUsage.get(id)!, label, n);

  const entityUsage = new Map<string, Usage>();
  for (const ent of entities) {
    const usage: Usage = [];
    for (const [label, counts] of ownLists) add(usage, label, counts.get(ent.id));
    // Its bank accounts add only what the entity's own counts can't show: their rows are the entity's rows, their journal lines its journals.
    const hasEntries = usage.some((u) => u.label === "jurnal (termasuk saldo awal)");
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

/** E1: name, short name, NPWP. Labels only — the bank GL names follow, nothing else moves. */
export async function renameEntity(db: Db, input: Actor & { entityId: string; name: string; shortName: string; npwp: string }) {
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
  // The ledger import matches a file's entity column by short name: two with the same one would make that ambiguous.
  if (!fields.shortName && shortName) {
    const siblings = await db.entity.findMany({ where: { clientId: input.clientId, id: { not: entity.id } }, select: { shortName: true } });
    if (siblings.some((s) => s.shortName.trim().toLowerCase() === shortName.toLowerCase())) fields.shortName = SHORT_NAME_TAKEN;
  }
  if (Object.keys(fields).length) throw new OnboardingError(fields);
  const before = { name: entity.name, shortName: entity.shortName, npwp: entity.npwp ?? "" };
  const after = { name, shortName, npwp: npwp ?? "" };
  if (JSON.stringify(before) === JSON.stringify(after)) return entity;
  return db.$transaction(async (tx) => {
    const updated = await tx.entity.update({ where: { id: entity.id }, data: { name, shortName, npwp: npwp || null } });
    for (const b of entity.bankAccounts) await tx.account.update({ where: { id: b.accountId }, data: { name: glName(b.label, shortName) } });
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
  if (clean.number !== ba.number && numberLocked((await clientUsage(db, input.clientId)).banks.get(ba.id) ?? [])) {
    throw new OnboardingError({ "bank.number": "Rekening koran rekening ini sudah dibaca, jadi nomornya tetap (file berikutnya dicocokkan dengan nomor ini). Ubah nama atau banknya saja, atau tambahkan rekening baru." });
  }
  const before = { label: ba.label, bank: ba.bank, number: ba.number };
  const after = { label: clean.label, bank: clean.bank, number: clean.number };
  if (JSON.stringify(before) === JSON.stringify(after)) return ba;
  return db.$transaction(async (tx) => {
    const updated = await tx.bankAccount.update({ where: { id: ba.id }, data: after });
    await tx.account.update({ where: { id: ba.accountId }, data: { name: glName(clean.label, ba.entity.shortName) } });
    await recordEvent(tx, { clientId: input.clientId, entityId: ba.entity.id, kind: "COMPANY_BANK", subject: `bankAccount:${ba.id}`, summary: `Rekening ${ba.label} diubah${ba.label !== clean.label ? ` menjadi ${clean.label}` : ""}`, before, after, actorId: input.actorId });
    return updated;
  });
}

/** Close acknowledgements keyed by a company or bank account ("<control>:<id>"): an empty one has none worth keeping. */
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
  const entity = await db.entity.findFirst({ where: { id: input.entityId, clientId: input.clientId, firmId: input.firmId }, select: { id: true, name: true, shortName: true, kind: true, bankAccounts: { select: { id: true, accountId: true, label: true } } } });
  if (!entity) throw new EntityEditError("Perusahaan tidak ditemukan di klien ini.");
  return db
    .$transaction(async (tx) => {
      if ((await tx.entity.count({ where: { clientId: input.clientId } })) < 2) throw new EntityEditError(LAST_ENTITY);
      const reason = blockedReason("entity", (await clientUsage(tx, input.clientId)).entities.get(entity.id) ?? []);
      if (reason) throw new EntityEditError(reason);
      const banks = entity.bankAccounts;
      await dropAcks(tx, input.clientId, [entity.id, ...banks.map((b) => b.id)]);
      await tx.bankAccount.deleteMany({ where: { entityId: entity.id } });
      await tx.account.deleteMany({ where: { id: { in: banks.map((b) => b.accountId) } } });
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
