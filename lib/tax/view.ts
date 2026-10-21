import type { Db } from "@/lib/db";
import type { TaxPack } from "@/lib/tax/pack";
import { formatDate } from "@/lib/format";
import { COA_TEMPLATE } from "@/lib/coa/template";

/** Serialisable view of the tax pack for the Pajak Badan page (bigint as string across the server → client boundary, rule 6). */
export type TaxPackView = ReturnType<typeof toView> & { postings: { id: string; kind: "CURRENT" | "DEFERRED"; date: string; memo: string; amount: string; ledgerCode: string; period: string }[]; accountNames: Record<string, string> };

const s = (v: bigint) => v.toString();

function toView(p: TaxPack) {
  return {
    entity: p.entity,
    year: p.year,
    month: p.month,
    applicable: p.applicable,
    regime: p.regime,
    profitBeforeTax: s(p.profitBeforeTax),
    turnover: s(p.turnover),
    finalWithheld: s(p.finalWithheld),
    months: p.months,
    annualTurnover: s(p.tax.annualTurnover),
    corrections: p.corrections.map((c) => ({ key: c.key, label: c.label, direction: c.direction, kind: c.kind, amount: s(c.amount), source: c.source })),
    suggestions: p.suggestions.map((x) => ({ ...x, amount: s(x.amount), corrected: s(x.corrected) })),
    positive: s(p.positive),
    negative: s(p.negative),
    fiscalProfit: s(p.fiscalProfit),
    losses: p.losses.map((l) => ({ id: l.id, originYear: l.originYear, opening: s(l.opening), used: s(l.used), remaining: s(l.remaining), expiresAfter: l.expiresAfter, expired: l.expired })),
    compensation: s(p.compensation),
    lossSuggestion: p.lossSuggestion ? { originYear: p.lossSuggestion.originYear, amount: s(p.lossSuggestion.amount) } : null,
    tax: { regime: p.tax.regime, pkp: s(p.tax.pkp), facilityPkp: s(p.tax.facilityPkp), facilityTax: s(p.tax.facilityTax), regularPkp: s(p.tax.regularPkp), regularTax: s(p.tax.regularTax), due: s(p.tax.due) },
    credits: p.credits.map((c) => ({ key: c.key, type: c.type, label: c.label, date: formatDate(c.date), month: `${c.date.getUTCFullYear()}-${String(c.date.getUTCMonth() + 1).padStart(2, "0")}`, masa: c.masa ? `${c.masa.getUTCFullYear()}-${String(c.masa.getUTCMonth() + 1).padStart(2, "0")}` : null, amount: s(c.amount), accountCode: c.accountCode, source: c.source })),
    settlement: p.settlement ? { credits: s(p.settlement.credits), balance: s(p.settlement.balance), nextInstalment: s(p.settlement.nextInstalment) } : null,
    deferred: p.deferred ? { assets: s(p.deferred.assets), allowance: s(p.deferred.allowance), leases: s(p.deferred.leases), employeeBenefits: s(p.deferred.employeeBenefits), temporaryDifference: s(p.deferred.temporaryDifference), amount: s(p.deferred.amount), oci: s(p.deferred.oci) } : null,
    proposals: { CURRENT: p.proposals.CURRENT.map((l) => ({ code: l.code, amount: s(l.amount) })), DEFERRED: p.proposals.DEFERRED.map((l) => ({ code: l.code, amount: s(l.amount) })) },
    laterPosting: { CURRENT: p.laterPosting.CURRENT ? formatDate(p.laterPosting.CURRENT) : null, DEFERRED: p.laterPosting.DEFERRED ? formatDate(p.laterPosting.DEFERRED) : null },
  };
}

export async function taxPackView(db: Db, clientId: string, p: TaxPack): Promise<TaxPackView> {
  const postings = await db.taxPosting.findMany({
    where: { taxYear: { entityId: p.entity.id, year: p.year } },
    include: { entry: { include: { lines: true } } },
    orderBy: { createdAt: "asc" },
  });
  const codes = [...new Set([...p.proposals.CURRENT, ...p.proposals.DEFERRED].map((l) => l.code))];
  const accounts = await db.account.findMany({ where: { clientId, code: { in: codes } }, select: { code: true, name: true } });
  return {
    ...toView(p),
    postings: postings.map((x) => ({
      id: x.id,
      kind: x.kind,
      date: formatDate(x.entry.date),
      memo: x.entry.memo,
      amount: x.entry.lines.reduce((t, l) => t + l.debit, 0n).toString(),
      ledgerCode: x.kind === "CURRENT" ? "8100" : "8110",
      period: `${x.entry.date.getUTCFullYear()}-${String(x.entry.date.getUTCMonth() + 1).padStart(2, "0")}`,
    })),
    // Pack accounts the client doesn't have yet are created on the first posting: show the template's name until then.
    accountNames: Object.fromEntries(codes.map((code) => [code, accounts.find((a) => a.code === code)?.name ?? COA_TEMPLATE.find((a) => a.code === code)?.name ?? code])),
  };
}
