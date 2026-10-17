import { prisma } from "@/lib/db";
import { loadClientPage } from "@/lib/client-page";
import { type SearchParams, withParams } from "@/lib/scope";
import { formatDate, formatPeriod } from "@/lib/format";
import { NextStep, PageHeader } from "@/components/app/page-header";
import { ScopeBar } from "@/components/app/scope-bar";
import { LinkTabs } from "@/components/app/link-tabs";
import { ApprovalQueue } from "@/components/app/approval-queue";
import { APPROVAL_KINDS, approvalQueue, type ApprovalKind } from "@/lib/approvals/queue";
import { accessView, requireWorkspaceSession } from "@/lib/auth/session";

export const metadata = { title: "Kotak persetujuan" };

/**
 * Kotak persetujuan (Phase 2 item 1): every proposal of the month waiting for a click — bank classifications, journal drafts, scheduled
 * journals and Coretax faktur not in the books — in one queue for the scope. Read from the owning pages' own data; every button is
 * that page's own action.
 */
export default async function ApprovalsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { client, base, scope, period, scopeLabel, entityOptions, periodOptions, sp } = await loadClientPage(params, searchParams);
  const [q, session] = await Promise.all([
    approvalQueue(prisma, { clientId: client.id, year: period.year, month: period.month, entityIds: scope.entityIds }),
    requireWorkspaceSession(),
  ]);
  const { canWrite } = accessView(session);
  const label = formatPeriod(period.year, period.month);
  const query = { entity: scope.value, period: period.key };
  // A kind with nothing waiting has no tab; an unknown or empty `?jenis=` falls back to Semua (ui-rules 13a).
  const present = APPROVAL_KINDS.filter((k) => q.counts[k.key] > 0);
  const chosen = present.find((k) => k.param === sp.jenis);
  const kinds: ApprovalKind[] = chosen ? [chosen.key] : present.map((k) => k.key);
  const draftAccounts = q.drafts.length ? await prisma.account.findMany({ where: { clientId: client.id, isBank: false }, select: { code: true, name: true }, orderBy: { code: "asc" } }) : [];
  const closeHref = withParams(`${base}/close`, { period: period.key });
  const n = q.counts.total;

  return (
    <div className="space-y-6">
      <PageHeader title="Kotak persetujuan" description={`${scopeLabel} · usulan sampai ${formatDate(period.end)}`} actions={<ScopeBar entities={entityOptions} periods={periodOptions} entity={scope.value} period={period.key} />} />
      {q.locked ? (
        <NextStep href={closeHref} cta="Buka Tutup Buku">
          Buku {label} sudah ditutup, jadi usulan{n ? " di bawah" : ""} hanya bisa dilihat. Minta admin membuka kembali {label} (dengan alasan) untuk mengubahnya.
        </NextStep>
      ) : n === 0 ? (
        <NextStep href={closeHref} cta="Tutup buku" tone="done">Tidak ada usulan menunggu persetujuan untuk {label}.</NextStep>
      ) : canWrite ? (
        <NextStep>Setujui, ubah atau tolak {n} usulan di bawah. Tidak ada yang dicatat tanpa klik Anda.</NextStep>
      ) : (
        <NextStep>{n} usulan menunggu persetujuan akuntan. Anda dapat melihatnya tanpa mengubah buku.</NextStep>
      )}
      {present.length > 1 && (
        <LinkTabs
          label="Jenis usulan"
          items={[
            { href: withParams(`${base}/approvals`, query), label: `Semua ${n}`, active: !chosen },
            ...present.map((k) => ({ href: withParams(`${base}/approvals`, { ...query, jenis: k.param }), label: `${k.label} ${q.counts[k.key]}`, active: chosen?.key === k.key })),
          ]}
        />
      )}
      {n > 0 && (
        <ApprovalQueue
          clientId={client.id}
          year={period.year}
          month={period.month}
          entityId={scope.mode === "entity" ? scope.value : undefined}
          kinds={kinds}
          labels={Object.fromEntries(APPROVAL_KINDS.map((k) => [k.key, k.label])) as Record<ApprovalKind, string>}
          bank={q.bank}
          bankTotal={q.counts.bank}
          confident={q.confident}
          drafts={q.drafts}
          scheduled={q.scheduled}
          faktur={q.faktur}
          fakturAccounts={q.fakturAccounts}
          draftAccounts={draftAccounts}
          reviewHref={withParams(`${base}/review`, query)}
          adjustHref={withParams(`${base}/journals/new`, query)}
          readOnly={q.locked || !canWrite}
        />
      )}
    </div>
  );
}
