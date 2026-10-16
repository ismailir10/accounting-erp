import { BANKS } from "@/lib/banks";

/** The public claim follows the parser registry; fixture coverage is enforced before it can ship. */
export const PUBLIC_BANK_COVERAGE = BANKS.map((bank) => ({
  code: bank.code,
  name: bank.name,
  formats: bank.formats.map((format) => ({ ...format })),
}));
export const PUBLIC_BANK_COUNT = PUBLIC_BANK_COVERAGE.length;

export type PublicProductEvidence = {
  period: string;
  firm: { name: string };
  client: { name: string };
  reportEntity: { name: string; currency: string };
  source: { date: string; description: string; amount: string; journalDebit: string; journalCredit: string; fileName: string; rowNumber: number; lines: { code: string; name: string; debit: string; credit: string }[] };
  trialBalance: { debit: string; credit: string };
  close: { lockEnabled: boolean; controls: { key: string; scope: string; title: string; status: string; detail: string }[] };
};
