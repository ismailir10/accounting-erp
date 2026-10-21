import { prisma } from "@/lib/db";
import { loadClientPage } from "@/lib/client-page";
import { type SearchParams, withParams } from "@/lib/scope";
import { formatPeriod } from "@/lib/format";
import { requireWorkspaceSession } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { FS_LINES, type FsLine } from "@/lib/coa/template";
import { ACCOUNT_FS_LINES, moveTargets, protection, removalBlock } from "@/lib/coa/manage";
import { allocateAccountCode, newAccountData } from "@/lib/ledger-import/mapping";
import { trialBalance } from "@/lib/reports/ledger";
import { NextStep, PageHeader } from "@/components/app/page-header";
import { ScopeBar } from "@/components/app/scope-bar";
import { ChartOfAccounts, type AccountSection } from "@/components/app/chart-of-accounts";
import { FxMissing, withFx } from "@/components/app/fx-missing";

export const metadata = { title: "Bagan akun" };

const SECTIONS: { key: string; title: string }[] = [
  { key: "ASET_LANCAR", title: "Aset lancar" },
  { key: "ASET_TIDAK_LANCAR", title: "Aset tidak lancar" },
  { key: "LIABILITAS_JANGKA_PENDEK", title: "Liabilitas jangka pendek" },
  { key: "LIABILITAS_JANGKA_PANJANG", title: "Liabilitas jangka panjang" },
  { key: "EKUITAS", title: "Ekuitas" },
  { key: "LABA_RUGI", title: "Laba rugi" },
  { key: "LAINNYA", title: "Pos belum terpetakan" },
];
const FS_ORDER = Object.keys(FS_LINES);
const TYPE_LABEL = { ASET: "Aset", LIABILITAS: "Liabilitas", EKUITAS: "Ekuitas", PENDAPATAN: "Pendapatan", BEBAN: "Beban" } as const;

/**
 * Bagan akun: the client's chart, one shared chart for all its entities (combined reports line up by code), by statement and report
 * line, with balances at the working month. Writers add, rename, move and remove accounts (lib/coa/manage.ts).
 */
export default async function AccountsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { client, period, scope, periodOptions, entityOptions, base, scopeLabel, currency } = await loadClientPage(params, searchParams);
  const { member } = await requireWorkspaceSession();
  const [accounts, counts, locked] = await Promise.all([
    prisma.account.findMany({ where: { clientId: client.id }, orderBy: { code: "asc" } }),
    prisma.journalLine.groupBy({ by: ["accountId"], where: { account: { clientId: client.id } }, _count: { _all: true } }),
    prisma.period.count({ where: { clientId: client.id, status: "LOCKED" } }),
  ]);
  // A mixed-currency group reads its balances translated to Rupiah, as the trial balance does; a missing rate leaves them out and says so.
  const tb = await withFx(() => trialBalance(prisma, { clientId: client.id, entityIds: scope.entityIds }, period.end));
  const nets = new Map(Array.isArray(tb) ? tb.map((r) => [r.account.id, r.net]) : []);
  const lineCount = new Map(counts.map((c) => [c.accountId, c._count._all]));
  const used = new Set(accounts.map((a) => a.code));
  const proposed = Object.fromEntries(ACCOUNT_FS_LINES.map((l) => [l.key, allocateAccountCode(l.key, used)]));
  const label = (fs: string) => FS_LINES[fs as FsLine]?.label ?? `${fs} (belum terpetakan)`;
  // Archived accounts (Arsip akun) sit in their own section at the end, each with *Aktifkan lagi*.
  const row = (a: (typeof accounts)[number]) => ({
    id: a.id,
    code: a.code,
    name: a.name,
    fsLine: a.fsLine,
    fsLabel: label(a.fsLine),
    side: a.normalBalance === "DEBIT" ? ("D" as const) : ("K" as const),
    balance: Array.isArray(tb) ? ((nets.get(a.id) ?? 0n) * (a.normalBalance === "DEBIT" ? 1n : -1n)).toString() : null,
    lines: lineCount.get(a.id) ?? 0,
    href: withParams(`${base}/ledger/${a.code}`, { period: period.key, entity: scope.value }),
    locked: protection(a),
    keep: removalBlock(a),
    targets: moveTargets(a).map((k) => ({ value: k, label: FS_LINES[k].label })),
    archived: a.archivedAt !== null,
  });
  const byLine = (a: (typeof accounts)[number], b: (typeof accounts)[number]) => FS_ORDER.indexOf(a.fsLine) - FS_ORDER.indexOf(b.fsLine) || a.code.localeCompare(b.code);
  const sections: AccountSection[] = [...SECTIONS.map((s) => ({
    ...s,
    rows: accounts
      .filter((a) => !a.archivedAt && (FS_LINES[a.fsLine as FsLine]?.section ?? "LAINNYA") === s.key)
      .sort(byLine)
      .map(row),
  })), { key: "ARSIP", title: "Diarsipkan", rows: accounts.filter((a) => a.archivedAt).sort(byLine).map(row) }].filter((s) => s.rows.length > 0);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Bagan akun"
        description={`${client.name} · ${accounts.length} akun, dipakai bersama semua perusahaan klien · saldo ${scopeLabel} per akhir ${formatPeriod(period.year, period.month)}`}
        actions={<ScopeBar entities={entityOptions} periods={periodOptions} entity={scope.value} period={period.key} />}
      />
      <NextStep>Tambahkan akun yang dipakai klien ini, atau ubah nama dan pos laporannya agar laporan memakai istilah klien.</NextStep>
      {!Array.isArray(tb) && <FxMissing error={tb} base={base} compact />}
      <ChartOfAccounts
        clientId={client.id}
        sections={sections}
        lines={ACCOUNT_FS_LINES.map((l) => ({ value: l.key, label: `${label(l.key)} (${TYPE_LABEL[newAccountData(l.key, "x").type]})` }))}
        proposed={proposed}
        canWrite={can(member.role, "books.write")}
        hasLocked={locked > 0}
        currency={currency}
      />
    </div>
  );
}
