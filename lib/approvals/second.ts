import type { JournalApprovalSource, MemberRole } from "@/lib/generated/prisma/enums";
import { can, isAdminRole, ROLE_LABEL } from "@/lib/auth/permissions";
import { formatRupiah } from "@/lib/money";
import type { SecondApproval } from "@/lib/settings/approvals";

/**
 * Persetujuan kedua (cycle 2026-10-18-persetujuan-kedua): the pure rules — which journal waits (source × amount × currency × the firm's
 * card), who may approve it, when no second person exists, who confirms a reopen, and the texts. The DB layer (lib/approvals/journals.ts,
 * lib/approvals/reopen.ts) reads the facts and applies these; every refusal is shown verbatim.
 */
export class ApprovalError extends Error {}

export const SOURCE_LABEL: Record<JournalApprovalSource, string> = { MANUAL: "Jurnal manual", REVERSAL: "Balik jurnal", AI_DRAFT: "Draf AI" };
export const REOPEN_LABEL = "Buka kembali";

export type Routing = { routed: false } | { routed: true; threshold: bigint | null };

/**
 * Whether a journal of this source waits for a second member. Off routes nothing; on with no threshold routes every journal; otherwise a
 * journal waits when its amount (Σdebit, minor units of the company's currency) is strictly above the threshold — equal posts, as
 * Otomasi's cap. A threshold is whole Rupiah and never compared with another currency's minor units (rule 3): a company kept in another
 * currency routes every journal of a switched-on source.
 */
export function routing(settings: SecondApproval, source: JournalApprovalSource, amount: bigint, currency: string): Routing {
  const on = source === "AI_DRAFT" ? settings.aiDraft : settings.manual;
  if (!on) return { routed: false };
  const threshold = source === "AI_DRAFT" ? settings.aiDraftAbove : settings.manualAbove;
  if (threshold === null || currency !== "IDR" || amount > threshold) return { routed: true, threshold };
  return { routed: false };
}

/** Why it waits, as Kotak and the forms say it: "di atas Rp 100.000.000", "semua nominal", or the other-currency rule. */
export function waitReason(threshold: bigint | null, currency: string): string {
  if (threshold === null) return "semua nominal perlu persetujuan";
  if (currency !== "IDR") return `perusahaan berbuku ${currency}: semua jurnal perlu persetujuan`;
  return `di atas ${formatRupiah(threshold)}`;
}

/** For approval Pemilik and Admin are one tier (*admin kantor*), the tier that may reopen a month; Akuntan below; Peninjau never approves. */
export const APPROVAL_TIER: Record<MemberRole, number> = { OWNER: 2, ADMIN: 2, AKUNTAN: 1, VIEWER: 0 };

type Actor = { id: string; role: MemberRole };
type Request = { makerId: string; makerRole: MemberRole };

/**
 * Why this member may not approve or reject the request, or null: a writer, never the maker (an admin's own journal included), and of a
 * tier at least the maker's at submission. Client access, being active and the organisation's state are the action guard's.
 */
export function approverProblem(actor: Actor, req: Request): string | null {
  if (!can(actor.role, "books.write")) return `Peran ${ROLE_LABEL[actor.role]} hanya dapat melihat, jadi tidak dapat menyetujui jurnal.`;
  if (actor.id === req.makerId) return "Anda yang mengajukan jurnal ini, jadi persetujuannya oleh anggota lain. Tarik kembali bila ingin mengubahnya.";
  if (APPROVAL_TIER[actor.role] < APPROVAL_TIER[req.makerRole]) {
    return `Jurnal ini diajukan ${ROLE_LABEL[req.makerRole]}, jadi hanya Admin atau Pemilik lain yang dapat memutuskannya.`;
  }
  return null;
}

/** "Menunggu Akuntan lain, Admin atau Pemilik" — who may decide, for everyone else looking at the row. */
export const waitingFor = (makerRole: MemberRole) => (APPROVAL_TIER[makerRole] >= APPROVAL_TIER.ADMIN ? "Menunggu Admin atau Pemilik lain" : "Menunggu Akuntan lain, Admin atau Pemilik");

/** A member as these rules read them: role, active, and whether they can open this client. */
export type Candidate = { id: string; role: MemberRole; disabled: boolean; canOpen: boolean };

/** Whether another active member who holds the client may approve this maker's journal. None → the fallback (it posts at once). */
export const hasApprover = (people: Iterable<Candidate>, maker: Actor) =>
  [...people].some((p) => !p.disabled && p.canOpen && approverProblem(p, { makerId: maker.id, makerRole: maker.role }) === null);

/** Whether another active Pemilik or Admin exists to confirm this admin's reopen. None → the fallback (it reopens at once). */
export const hasSecondAdmin = (people: Iterable<Pick<Candidate, "id" | "role" | "disabled">>, requesterId: string) =>
  [...people].some((p) => p.id !== requesterId && !p.disabled && isAdminRole(p.role));

/** Who may confirm or reject a reopen request: another admin. The requester only cancels it. */
export function reopenDeciderProblem(actor: Actor, req: { requestedById: string }): string | null {
  if (!can(actor.role, "period.unlock")) return "Hanya admin kantor yang dapat membuka kembali periode.";
  if (actor.id === req.requestedById) return "Anda yang meminta membuka kembali bulan ini, jadi konfirmasinya oleh admin lain. Batalkan permintaan bila tidak jadi.";
  return null;
}

export const NOTE_MIN = 5;
export const NOTE_MESSAGE = `Tulis alasan menolak (min. ${NOTE_MIN} karakter).`;
export const PENDING_DRAFT = "Draf ini menunggu persetujuan kedua. Putuskan di Kotak persetujuan.";
export const JOURNAL_FALLBACK = "Dicatat tanpa persetujuan kedua: tidak ada anggota lain yang berhak menyetujui";
export const REOPEN_FALLBACK = "Dibuka tanpa konfirmasi kedua: hanya satu admin aktif";

/** The Riwayat subject of a journal request and of a reopen request. */
export const approvalSubject = (id: string) => `approval:${id}`;
export const reopenSubject = (id: string) => `reopen:${id}`;

/** `Jurnal manual "Akrual gaji" 31 Jul 2026 · Rp 150.000.000` — the head of every journal event. */
export const journalHead = (source: JournalApprovalSource, memo: string, date: string, amount: string) => `${SOURCE_LABEL[source]} "${memo}" ${date} · ${amount}`;
