import type { Tx } from "@/lib/db";
import { ensureIntercompanyAccounts } from "@/lib/coa/intercompany";
import type { BankCode, EntityKind, GrantKind, MemberRole, OrgKind, ReportingFramework } from "@/lib/generated/prisma/enums";
import { isAdminRole } from "@/lib/auth/permissions";
import { assertCanAddClient } from "@/lib/org";
import { bankAccountCode, COA_TEMPLATE, overdraftAccountCode } from "@/lib/coa/template";
import { FIRM_RULES, type RuleLike } from "@/lib/classify/rules";

export type ClientSpec = {
  name: string;
  industry: string;
  entities: { name: string; shortName: string; kind: EntityKind; npwp?: string; functionalCurrency?: string; reportingFramework?: ReportingFramework; banks: { bank: BankCode; number: string; label: string; isOverdraft?: boolean }[] }[];
  rules?: Omit<RuleLike, "clientId">[];
};

export type FirmGrant = { kind: GrantKind; startsAt: Date; endsAt: Date | null; note?: string; grantedById?: string };

/**
 * An organisation with its firm-level rules and its first access grant (ADR 0017). The default grant is open-ended COMP: what
 * operator, demo and test paths have always meant by "a firm". Trial approvals pass their own TRIAL grant.
 */
export async function createFirm(tx: Tx, name: string, opts: { kind?: OrgKind; grant?: FirmGrant } = {}) {
  const firm = await tx.firm.create({ data: { name, kind: opts.kind } });
  await tx.rule.createMany({ data: FIRM_RULES.map((r) => ({ ...r, firmId: firm.id, source: "SEED" })) });
  const grant = opts.grant ?? { kind: "COMP", startsAt: firm.createdAt, endsAt: null };
  await tx.accessGrant.create({ data: { firmId: firm.id, ...grant } });
  return firm;
}

/** A client made by an AKUNTAN is assigned to its maker, or they could not open what they just created. Admins see all anyway. */
export type ClientCreator = { id: string; role: MemberRole };

/** Client + COA template + one GL account per bank account + client rules. */
export async function createClient(tx: Tx, firmId: string, spec: ClientSpec, opts: { creator?: ClientCreator } = {}) {
  await assertCanAddClient(tx, firmId);
  const client = await tx.client.create({ data: { firmId, name: spec.name, industry: spec.industry } });
  if (opts.creator && !isAdminRole(opts.creator.role)) await tx.clientAccess.create({ data: { memberId: opts.creator.id, clientId: client.id } });
  await tx.account.createMany({ data: COA_TEMPLATE.map((a) => ({ ...a, firmId, clientId: client.id })) });
  let bankIndex = 0;
  let overdraftIndex = 0;
  const codes: GlCodes = { bank: () => bankAccountCode(bankIndex++), overdraft: () => overdraftAccountCode(overdraftIndex++) };
  const entities = [];
  for (const e of spec.entities) entities.push(await createEntity(tx, firmId, client.id, e, codes));
  await ensureIntercompanyAccounts(tx, client.id);
  if (spec.rules?.length) {
    await tx.rule.createMany({ data: spec.rules.map((r) => ({ ...r, firmId, clientId: client.id, source: "SEED" })) });
  }
  return { client, entities };
}

/** Where the next bank GL account goes: 1101–1109 for a bank account, 2201–2209 for a PRK. */
export type GlCodes = { bank: () => string; overdraft: () => string };
type EntitySpec = ClientSpec["entities"][number];

/** One entity of a client with a GL bank account per bank account (used by createClient and by adding to an existing client). */
export async function createEntity(tx: Tx, firmId: string, clientId: string, e: EntitySpec, codes: GlCodes) {
  const entity = await tx.entity.create({ data: { firmId, clientId, name: e.name, shortName: e.shortName, kind: e.kind, npwp: e.npwp, functionalCurrency: e.functionalCurrency ?? "IDR", reportingFramework: e.reportingFramework } });
  const banks = [];
  for (const b of e.banks) banks.push(await createBankAccount(tx, firmId, clientId, entity, b, codes));
  return { entity, banks };
}

export async function createBankAccount(tx: Tx, firmId: string, clientId: string, entity: { id: string; shortName: string }, b: EntitySpec["banks"][number], codes: GlCodes) {
  // PRK (overdraft) accounts are liabilities in 2201–2209; their statement balance is negative.
  const gl = await tx.account.create({
    data: b.isOverdraft
      ? { firmId, clientId, code: codes.overdraft(), name: `${b.label} (${entity.shortName})`, type: "LIABILITAS", normalBalance: "CREDIT", fsLine: "UTANG_BANK", isBank: true }
      : { firmId, clientId, code: codes.bank(), name: `${b.label} (${entity.shortName})`, type: "ASET", normalBalance: "DEBIT", fsLine: "KAS_SETARA_KAS", isBank: true },
  });
  return tx.bankAccount.create({ data: { firmId, entityId: entity.id, accountId: gl.id, bank: b.bank, number: b.number, label: b.label, isOverdraft: Boolean(b.isOverdraft) } });
}

/** The lowest unused bank GL codes of a client, for adding accounts later. Throws the same limit message as creation when none is left. */
export async function freeGlCodes(tx: Tx, clientId: string): Promise<GlCodes> {
  const used = new Set((await tx.account.findMany({ where: { clientId, isBank: true }, select: { code: true } })).map((a) => a.code));
  const next = (make: (i: number) => string) => () => {
    for (let i = 0; i < 9; i++) if (!used.has(make(i))) { used.add(make(i)); return make(i); }
    return make(9); // throws "Maksimal 9 rekening …"
  };
  return { bank: next(bankAccountCode), overdraft: next(overdraftAccountCode) };
}
