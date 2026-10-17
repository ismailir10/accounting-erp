import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db";
import { formatDate, formatPeriod, periodBounds } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { incomeStatement, trialBalance } from "@/lib/reports/ledger";
import { closeReadiness, runControls } from "@/lib/controls";
import { setupProgress } from "@/lib/setup-progress";
import { askEvidence } from "@/lib/evidence/answers";
import { completenessMatrix } from "@/lib/controls/completeness";
import { financialYear, fiscalEndMonth } from "@/lib/fiscal";
import { approvalCounts } from "@/lib/approvals/queue";

export type WorkspaceInput = { scope?: string; period?: string };
export class WorkspaceInputError extends Error {}

export function parseWorkspacePeriod(value: string) {
  if (!/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(value)) throw new WorkspaceInputError("Pilih periode yang valid (YYYY-MM, tahun 1900–2199).");
  return { year: Number(value.slice(0, 4)), month: Number(value.slice(5)) };
}

/** Only ids owned by the authenticated firm may reach accounting read helpers. */
/**
 * Whose workspace: the organisation and the clients the member may open (ADR 0017; "ALL" for admins and company members). Every
 * scope, overview and answer is built from these clients only, so an unassigned client is "not found" here like anywhere else.
 */
export type WorkspaceAccess = { firmId: string; clientIds: string[] | "ALL" };

export async function resolveWorkspaceScope(db: Db, access: WorkspaceAccess, input: WorkspaceInput = {}) {
  const firmId = access.firmId;
  const clients = await db.client.findMany({ where: access.clientIds === "ALL" ? { firmId } : { firmId, id: { in: access.clientIds } }, select: { id: true, name: true, entities: { where: { firmId }, select: { id: true, name: true, shortName: true, functionalCurrency: true, clientId: true, kind: true }, orderBy: { name: "asc" } } }, orderBy: { name: "asc" } });
  for (const client of clients) client.entities.sort((a, b) => Number(a.kind === "PERORANGAN") - Number(b.kind === "PERORANGAN"));
  const key = input.scope ?? "all";
  const allEntities = clients.flatMap(c => c.entities);
  const kind = key === "all" ? "all" : key.startsWith("client:") ? "client" : key.startsWith("entity:") ? "entity" : null;
  const client = kind === "client" ? clients.find(c => c.id === key.slice(7)) : undefined;
  const entity = kind === "entity" ? allEntities.find(e => e.id === key.slice(7)) : undefined;
  if (!kind || (kind === "client" && !client) || (kind === "entity" && !entity)) throw new WorkspaceInputError("Cakupan tidak ditemukan dalam kantor Anda.");
  const entities = kind === "entity" ? [entity!] : kind === "client" ? client!.entities : allEntities;
  const clientIds = kind === "client" ? [client!.id] : kind === "entity" ? [entity!.clientId] : clients.map(c => c.id);
  const entityIds = entities.map(e => e.id);
  // The latest month with entries up to this month (lib/periods.ts pickWorkingMonth): a reversal dated next January is not today's work.
  const now = new Date();
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  const where = { firmId, entityId: { in: entityIds }, kind: { not: "OPENING" as const } };
  const latest = input.period
    ? null
    : ((await db.journalEntry.findFirst({ where: { ...where, date: { lte: monthEnd } }, orderBy: { date: "desc" }, select: { date: true } })) ??
      (await db.journalEntry.findFirst({ where, orderBy: { date: "asc" }, select: { date: true } })));
  const period = input.period ?? (latest?.date ?? new Date()).toISOString().slice(0, 7);
  const { year, month } = parseWorkspacePeriod(period);
  // The current month in WIB, computed once on the server so every render lists the same periods.
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
  return { key, kind, label: entity?.name ?? client?.name ?? "Semua klien", period, periodLabel: formatPeriod(year, month), today, year, month, clientIds, entityIds, clients, entities };
}
export type WorkspaceScope = Awaited<ReturnType<typeof resolveWorkspaceScope>>;

export function workspaceHref(path: string, scope: Pick<WorkspaceScope, "key" | "period">, extra: Record<string, string> = {}) {
  const [withoutHash, hash] = path.split("#");
  const [base, query] = withoutHash.split("?");
  const params = new URLSearchParams(query);
  params.set("scope", scope.key); params.set("period", scope.period);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return `${base}?${params}${hash ? `#${hash}` : ""}`;
}

export type WorkspaceTask = { id: string; title: string; detail: string; href: string; priority: "high" | "normal"; clientId: string; entityId?: string };

export async function getWorkspaceOverview(db: Db, access: WorkspaceAccess, input: WorkspaceInput = {}) {
  const firmId = access.firmId;
  const scope = await resolveWorkspaceScope(db, access, input);
  const { start, end } = periodBounds(scope.year, scope.month);
  const entities = await Promise.all(scope.entities.map(async e => {
    const [entries, history, openReview, pl, tb] = await Promise.all([
      db.journalEntry.count({ where: { firmId, entityId: e.id, date: { gte: start, lte: end } } }),
      db.journalEntry.count({ where: { firmId, entityId: e.id, date: { lte: end } } }),
      db.bankTransaction.count({ where: { firmId, bankAccount: { entityId: e.id }, status: "NEEDS_REVIEW", date: { lte: end } } }),
      incomeStatement(db, { clientId: e.clientId, entityIds: [e.id] }, start, end),
      trialBalance(db, { clientId: e.clientId, entityIds: [e.id] }, end),
    ]);
    const cash = tb.filter(r => r.account.fsLine === "KAS_SETARA_KAS" && r.account.type === "ASET").reduce((sum, r) => sum + r.net, 0n);
    const fmt = (v: bigint | null) => v === null ? "Belum ada jurnal" : formatMoney(v, e.functionalCurrency);
    const revenue = entries ? pl.totals.revenue : null, profit = entries ? pl.totals.netProfit : null;
    const cashValue = history ? cash : null;
    const extra = { entity: e.id };
    return { id: e.id, name: e.name, shortName: e.shortName, clientId: e.clientId, clientName: scope.clients.find(c => c.id === e.clientId)!.name, currency: e.functionalCurrency, hasActivity: entries > 0, hasBooks: history > 0, revenue: revenue?.toString() ?? null, profit: profit?.toString() ?? null, cash: cashValue?.toString() ?? null, revenueFormatted: fmt(revenue), profitFormatted: fmt(profit), cashFormatted: fmt(cashValue), openReview,
      reportHref: workspaceHref(`/clients/${e.clientId}/reports`, scope, extra), reviewHref: workspaceHref(`/clients/${e.clientId}/review`, scope, extra), closeHref: workspaceHref(`/clients/${e.clientId}/close`, scope) };
  }));
  // Close is a client/group operation. Never imply that an entity-only filter changes its controls.
  const clients = await Promise.all(scope.clients.filter(c => scope.clientIds.includes(c.id)).map(async c => {
    const [controls, period, activity, completeness, approvals] = await Promise.all([
      runControls(db, c.id, scope.year, scope.month),
      db.period.findUnique({ where: { clientId_year_month: { clientId: c.id, year: scope.year, month: scope.month } }, include: { signoffs: true } }),
      db.journalEntry.count({ where: { firmId, entity: { clientId: c.id }, date: { gte: start, lte: end } } }),
      completenessMatrix(db, c.id, scope.year, scope.month, 1),
      // Persetujuan: the client's Kotak for the month, every company (the same read model as the page, so the counts agree).
      approvalCounts(db, { clientId: c.id, year: scope.year, month: scope.month }),
    ]);
    // Papan kantor (I5a): Sumber is this month's completeness; Terkirim the first report out after the lock (as in close:timeline).
    const sumber = { rows: completeness.rows.length, gaps: completeness.rows.filter((r) => r.cells.some((cell) => cell.state === "missing" || cell.state === "broken")).length };
    const sent = period?.status === "LOCKED" && period.lockedAt
      ? await db.auditEvent.findFirst({ where: { clientId: c.id, kind: "REPORT_EXPORT", subject: `period:${scope.period}`, createdAt: { gte: period.lockedAt } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } })
      : null;
    const readiness = closeReadiness(controls, period?.signoffs.map(s => s.key) ?? []);
    // A failed control outranks "no journal this month": a client with nothing booked can still have broken books.
    const state = period?.status === "LOCKED" ? "LOCKED" : readiness.fails.length ? "FAIL" : !activity ? "EMPTY" : readiness.ready ? "READY" : "REVIEW";
    const labels = { LOCKED: "Buku ditutup", EMPTY: "Belum ada jurnal bulan ini", FAIL: "Kontrol gagal", READY: "Siap tutup buku", REVIEW: "Perlu dicek" };
    const missingStatements = controls.filter(control => control.key.startsWith("bank:") && control.detail.includes("belum diimpor")).map(control => ({ title: control.title, detail: `${control.scope} · ${control.detail}`, href: workspaceHref(control.href ?? `/clients/${c.id}/import`, scope) }));
    // A masa paid short or late is a penalty in waiting (accounting-rules 5j): its own task, until fixed or explained in a note.
    const taxIssues = controls.filter(control => control.key.startsWith("masa:") && control.status === "REVIEW" && !control.ack).map(control => ({ key: control.key, scope: control.scope, detail: control.detail, href: workspaceHref(control.href ?? `/clients/${c.id}/tax/masa`, scope) }));
    const setup = await setupProgress(db, c.id, { period: { year: scope.year, month: scope.month }, missingStatements: missingStatements.map(m => m.title) });
    // The findings that hold the close, failed first: what Tanya Buku names when asked what blocks the books.
    const open = [...readiness.fails, ...readiness.unacked].map((control) => ({ title: control.title, scope: control.scope, status: control.status, href: workspaceHref(control.href ?? `/clients/${c.id}/close`, scope) }));
    return { id: c.id, name: c.name, state, label: labels[state], sumber, open, sentAt: sent?.createdAt ?? null, importHref: workspaceHref(`/clients/${c.id}/import`, scope), approvals: approvals.total, approvalsHref: workspaceHref(`/clients/${c.id}/approvals`, scope, { entity: "combined" }), hasActivity: activity > 0, failCount: readiness.fails.length, reviewCount: readiness.unacked.length, missingSignoffs: readiness.missing.length, missingStatements, taxIssues, setup: { step: setup.current, hasData: setup.hasData, hasBanks: setup.hasBanks, next: setup.next, opening: setup.needsOpening.map(e => e.shortName) }, closeHref: workspaceHref(`/clients/${c.id}/close`, scope) };
  }));
  // The detail names the client when the company's own name doesn't (an owner "Budi Santoso" can belong to two clients).
  const tasks: WorkspaceTask[] = entities.filter(e => e.openReview > 0).map(e => ({ id: `review:${e.id}`, title: `Periksa ${e.openReview} transaksi`, detail: `${e.name === e.clientName ? e.name : `${e.clientName} · ${e.name}`} · sampai ${scope.periodLabel}`, href: e.reviewHref, priority: "high", clientId: e.clientId, entityId: e.id }));
  for (const c of clients) {
    if (c.state === "LOCKED") continue;
    // A client still in setup gets ONE task naming the step (upload, then Saldo Awal), instead of generic "lengkapi" tasks.
    if (c.setup.step === "import" && !c.setup.hasData && c.setup.next) { tasks.push({ id: `setup:${c.id}`, title: c.setup.hasBanks ? `Mulai ${c.name}: unggah rekening koran` : `Mulai ${c.name}: impor buku besar`, detail: c.setup.hasBanks ? "Langkah 1 dari 4 · dari sini Saldo Awal terisi otomatis" : "Langkah 1 dari 4", href: workspaceHref(c.setup.next.href, scope), priority: "normal", clientId: c.id }); continue; }
    if (c.setup.step === "opening" && c.setup.next) { tasks.push({ id: `opening:${c.id}`, title: `Isi saldo awal ${c.setup.opening.join(" dan ")}`, detail: `${c.name} · langkah 2 dari 4, saldo bank sudah terisi dari rekening koran`, href: workspaceHref(c.setup.next.href, scope), priority: "normal", clientId: c.id }); continue; }
    for (const t of c.taxIssues) tasks.push({ id: `tax:${t.key}`, title: `Periksa setoran pajak ${t.scope}`, detail: `${c.name} · ${t.detail}`, href: t.href, priority: "high", clientId: c.id });
    if (c.missingStatements.length) tasks.push({ id: `statement:${c.id}`, title: `Lengkapi ${c.missingStatements.length} rekening koran`, detail: `${c.name} · ${c.missingStatements.map(item => item.detail).join("; ")}`, href: c.missingStatements[0].href, priority: "high", clientId: c.id });
    if (c.state === "EMPTY") tasks.push({ id: `import:${c.id}`, title: "Lengkapi buku bulan ini", detail: c.name, href: workspaceHref(`/clients/${c.id}/import`, scope, scope.kind === "entity" ? { entity: scope.entityIds[0] } : {}), priority: "normal", clientId: c.id });
    else tasks.push({ id: `close:${c.id}`, title: c.failCount ? `Perbaiki ${c.failCount} kontrol gagal` : c.reviewCount ? `Periksa ${c.reviewCount} temuan tutup buku` : c.missingSignoffs ? `Lengkapi ${c.missingSignoffs} pemeriksaan akhir` : "Tutup buku", detail: `${c.name} · seluruh grup/klien`, href: c.closeHref, priority: c.failCount ? "high" : "normal", clientId: c.id });
  }
  // What blocks the books first: failed controls, then missing statements (review of what isn't imported can't finish) and taxes paid
  // short or late (a penalty in waiting), then review.
  const rank = (t: WorkspaceTask) => (t.priority !== "high" ? 3 : t.id.startsWith("close:") ? 0 : t.id.startsWith("statement:") || t.id.startsWith("tax:") ? 1 : 2);
  tasks.sort((a, b) => rank(a) - rank(b));
  return { scope, entities, clients, tasks, counts: { entities: entities.length, openReview: entities.reduce((n, e) => n + e.openReview, 0), closed: clients.filter(c => c.state === "LOCKED").length, clients: clients.length } };
}
export type WorkspaceOverview = Awaited<ReturnType<typeof getWorkspaceOverview>>;
export type WorkspaceAnswer = {
  id: string;
  question: string;
  scope: Pick<WorkspaceScope, "key" | "label" | "period" | "periodLabel">;
  text: string;
  rows: { label: string; value: string; source: string }[];
  citations: { label: string; href: string }[];
  limitations: string[];
  /** Numbers of a month not closed yet are preliminary (use-case feedback UC-X5): which month, for which clients. Null when closed or not from the books. */
  preliminary: string | null;
};

/** Asking Buku to change something (it only reads): an instruction verb at the start, politely or not. */
const CHANGE_REQUEST = /^\s*(?:tolong|mohon|bisa(?:kah)?|coba|please)?\s*(?:ubah|ubahkan|ganti|hapus|hapuskan|edit|koreksi|koreksikan|catat|catatkan|posting|postingkan|jurnalkan|reklas|reklasifikasi(?:kan)?|pindahkan|kunci|buka kembali|unlock|delete|change)\b/i;

export function workspaceQuestionIntent(question: string) {
  const q = question.toLowerCase();
  // "Koreksi fiskal berapa?" asks about a number; "Koreksi akun transaksi ini ke 6100" asks Buku to act.
  if (CHANGE_REQUEST.test(question) && !/\b(berapa|apa|apakah|siapa|mana|bagaimana|kenapa|mengapa|kapan)\b|\?\s*$/.test(q)) return "change";
  if (/\b(prediksi|forecast|proyeksi|ramalan|tahun depan|bulan depan)\b/.test(q)) return "unsupported";
  // "Transaksi apa yang belum jelas / perlu ditanyakan ke klien?": rows still waiting in Review (before the payee search reads "klien" as a name).
  if (/belum jelas|(perlu|harus|mau) (di)?tanya|ditanyakan|tanya(kan)? (ke )?klien|pertanyaan (untuk|ke|buat) klien|konfirmasi (ke )?klien|belum (di)?klasifikasi|menunggu review/.test(q)) return "unclear";
  if (/\b(tutup buku|close|kesiapan|siap|hambatan|penghambat)\b/.test(q)) return "readiness";
  // "transfer ke ALFI YANDRA", "pembayaran dari DINA", "mutasi dengan \"PT PAKAN\"": bank lines by counterparty.
  if (/\b(transfer|transaksi|mutasi|pembayaran|bayar|dibayar|penerimaan|terima|diterima|kiriman|dikirim|setoran)\b/.test(q) && counterpartyOf(question)) return "transactions";
  // "Utang usaha" / "piutang usaha" are accounts, not the business profile the word "usaha" otherwise asks about.
  if (/\b(utang|hutang|piutang|uang muka|persediaan|liabilitas|payables?|receivables?)\b/.test(q) && !/\b(dokumen|file|laporan unggahan)\b/.test(q)) return "balances";
  if (/\b(profil|profile|usaha|industry|industri|konteks)\b/.test(q)) return "context";
  if (/\b(dokumen|file|sumber|rekening koran|laporan unggahan)\b/.test(q)) return "evidence";
  if (/\b(laba|profit|pendapatan|revenue)\b/.test(q)) return "profit";
  if (/\b(saldo|kas|bank|balance|utang|hutang|piutang|modal|ekuitas|uang muka|persediaan|liabilitas|payables?|receivables?)\b/.test(q)) return "balances";
  return "unsupported";
}

/** "Sementara: Agustus 2026 belum ditutup (untuk …)" when any client in scope has the month open; null when all closed it. */
async function preliminaryLabel(db: Db, scope: WorkspaceScope) {
  const locked = await db.period.findMany({ where: { clientId: { in: scope.clientIds }, year: scope.year, month: scope.month, status: "LOCKED" }, select: { clientId: true } });
  const open = scope.clients.filter((c) => scope.clientIds.includes(c.id) && !locked.some((l) => l.clientId === c.id));
  if (!open.length) return null;
  const who = open.length === scope.clientIds.length ? "" : ` untuk ${open.map((c) => c.name).join(", ")}`;
  return `Sementara: ${scope.periodLabel} belum ditutup${who}. Angka bisa berubah sampai buku ditutup.`;
}

const PHRASE_END = /\s+(?:bulan|tahun|dan|di|yang|pada|sampai|dicatat|masuk|keluar|periode|berapa|total|ke akun|di akun)\b|[?.,;:!]|$/i;
/** The counterparty named in a question: a quoted phrase, else the words after ke/dari/kepada/untuk/oleh/dengan. */
export function counterpartyOf(question: string): string | null {
  const quoted = question.match(/["“']([^"”']{3,60})["”']/)?.[1];
  if (quoted) return quoted.trim();
  const m = question.match(/\b(?:ke|dari|kepada|untuk|oleh|dengan)\s+([\p{L}][\p{L}\p{N} .&'-]{2,60})/iu);
  if (!m) return null;
  const name = m[1].split(PHRASE_END)[0].trim();
  // "ke akun apa", "dari bank" name no one.
  if (!name || /^(akun|rekening|bank|mana|siapa|apa)\b/i.test(name) || name.replace(/[^\p{L}]/gu, "").length < 3) return null;
  return name;
}

const MONTHS: [RegExp, number][] = [
  [/^(januari|january|jan)$/, 1], [/^(februari|pebruari|february|feb|peb)$/, 2], [/^(maret|march|mar)$/, 3], [/^(april|apr)$/, 4], [/^(mei|may)$/, 5],
  [/^(juni|june|jun)$/, 6], [/^(juli|july|jul)$/, 7], [/^(agustus|august|agu|agt|aug)$/, 8], [/^(september|sept|sep)$/, 9],
  [/^(oktober|october|okt|oct)$/, 10], [/^(november|nopember|nov|nop)$/, 11], [/^(desember|december|des|dec)$/, 12],
];
/** The month a question names ("laba Maret 2027", "per akhir Desember 2025", "tahun 2025" → December), as YYYY-MM; null when none. */
export function periodIn(question: string): string | null {
  const q = question.toLowerCase();
  for (const m of q.matchAll(/\b([a-z]{3,9})\.?\s+(\d{4})\b/g)) {
    const month = MONTHS.find(([re]) => re.test(m[1]))?.[1];
    if (month) return `${m[2]}-${String(month).padStart(2, "0")}`;
  }
  const year = q.match(/\b(?:tahun|year|full[- ]?year|fy|setahun|sepanjang)\s*(\d{4})\b/)?.[1];
  return year ? `${year}-12` : null;
}

const LEGAL = /\b(pt|cv|ud|tbk|pte|ltd|limited|inc|llc|persero)\b\.?/gi;
const bareName = (n: string) => n.replace(LEGAL, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
/** The scope's entities a question names (short name, full name, or the name without its legal form), in the order they appear. */
export function entitiesNamed<T extends { name: string; shortName: string }>(question: string, entities: T[]): T[] {
  const q = ` ${question.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  // Every place a spelling occurs, as a span: "Chickin" (Chickin Pte. Ltd. without its legal form) inside "Chickin Ayam Hidup" is the other entity.
  const spans = entities.flatMap((e) =>
    [e.shortName, e.name, bareName(e.name), bareName(e.shortName)]
      .map((x) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim())
      .filter((x) => x.length >= 3)
      .flatMap((x) => [...q.matchAll(new RegExp(` ${x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `, "g"))].map((m) => ({ e, start: m.index!, end: m.index! + x.length + 2 }))),
  );
  const kept = spans.filter((a) => !spans.some((b) => b.e !== a.e && b.start <= a.start && b.end >= a.end && b.end - b.start > a.end - a.start));
  const first = new Map<T, number>();
  for (const x of kept) first.set(x.e, Math.min(first.get(x.e) ?? Infinity, x.start));
  return [...first].sort((a, b) => a[1] - b[1]).map(([e]) => e);
}

/** A related-party question: the group's own entities (and 1190) are the related parties Buku knows. */
export const RELATED = /pihak (ber)?elasi|berelasi|related part|afiliasi|affiliat|antar ?entitas|intercompany|inter-company|perusahaan grup|perusahaan induk|induk perusahaan|anak perusahaan/i;

/** Words of a balance question that name no account. */
const NAME_STOP = new Set(
  ("berapa saldo akhir awal bulan tahun total nilai jumlah sampai posisi untuk dengan yang adalah pada dari bagaimana apakah akun account balance " +
    "januari februari maret april juni juli agustus september oktober november desember").split(" "),
);
const CASH_WORDS = /\b(kas|bank|cash)\b/;
/** The client's books mix Indonesian and English names (Jurnal, Accurate exports): a question in one finds an account in the other. */
const NAME_SYNONYMS: [string, string][] = [
  ["utang", "payable"], ["hutang", "payable"], ["piutang", "receivable"], ["berelasi", "related"], ["afiliasi", "related"], ["pihak", "part"],
  ["pemegang saham", "shareholder"], ["modal", "capital"], ["persediaan", "inventory"], ["uang muka", "advance"], ["dibayar di muka", "prepaid"],
  ["pajak", "tax"], ["karyawan", "employee"], ["imbalan kerja", "employee benefit"], ["sewa", "rent"], ["aset tetap", "fixed asset"],
  ["penyusutan", "depreciation"], ["akumulasi", "accumulated"], ["saldo laba", "retained"], ["pinjaman", "loan"], ["jangka panjang", "long term"],
  // A loan to staff is often kept as an advance ("Advanced - Employee", "Uang Muka Karyawan").
  ["piutang karyawan", "advance"], ["piutang karyawan", "uang muka"],
];
/** Accounting words common to many accounts: one of them alone names no particular account. */
const GENERIC = new Set(
  ("utang hutang payable payables piutang receivable receivables lain lainnya other others beban biaya expense expenses pendapatan revenue income " +
    "pajak tax aset asset assets kas bank cash modal capital saldo account akun usaha trade jangka panjang pendek long term short current " +
    "uang muka advance advanced prepaid dibayar karyawan employee pinjaman loan loans").split(" "),
);
function nameWords(text: string): string[] {
  let t = ` ${text.toLowerCase().replace(/[^\p{L}]+/gu, " ")} `;
  for (const [id, en] of NAME_SYNONYMS) {
    if (t.includes(` ${id}`)) t += ` ${en}`;
    if (t.includes(` ${en}`)) t += ` ${id}`;
  }
  return [...new Set(t.split(" ").filter((w) => w.length >= 4))];
}
const sameWord = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

/**
 * The accounts a balance question names ("utang ke pihak berelasi", "piutang karyawan"), best match first: Buku's chart and the client's own
 * accounts from an imported ledger, either language. Only the best-scoring names, and only when at least two of the question's words match.
 */
export function accountsNamed<T extends { name: string }>(question: string, accounts: T[], max = 5, ignore: string[] = []): T[] {
  // The entities' own names ("PT Sinergi Ketahanan Pangan") say whose books, not which account.
  const skip = new Set(ignore.flatMap((n) => nameWords(n)));
  const q = nameWords(question.replace(CASH_WORDS, " ")).filter((w) => !NAME_STOP.has(w) && !skip.has(w));
  if (!q.length) return [];
  const scored = accounts.map((a) => {
    const n = nameWords(a.name);
    const hits = q.filter((w) => n.some((x) => sameWord(w, x)));
    return { a, score: hits.length, hits };
  });
  const best = Math.max(0, ...scored.map((x) => x.score));
  const top = scored.filter((x) => x.score === best);
  // One word is enough when it is distinctive ("Rawasari", "Smartfarm") and names only a few accounts.
  if (best === 1 && (top.length > 3 || top.some((x) => GENERIC.has(x.hits[0]) || x.hits[0].length < 5))) return [];
  return best < 1 ? [] : top.slice(0, max).map((x) => x.a);
}

export async function askWorkspace(db: Db, access: WorkspaceAccess, input: WorkspaceInput & { question: string }): Promise<WorkspaceAnswer> {
  const firmId = access.firmId;
  const question = input.question.trim();
  if (!question || question.length > 2000) throw new WorkspaceInputError("Tulis pertanyaan antara 1 dan 2.000 karakter.");
  // A month named in the question is the month answered ("laba SKP Maret 2027"), never silently another one.
  const asked = periodIn(question);
  const resolved = await resolveWorkspaceScope(db, access, asked ? { ...input, period: asked } : input);
  const { key, label, period, periodLabel } = resolved;
  const answer: WorkspaceAnswer = { id: randomUUID(), question, scope: { key, label, period, periodLabel }, text: "", rows: [], citations: [], limitations: [], preliminary: null };
  const intent = workspaceQuestionIntent(question);
  const accountCode = question.match(/\b(?:akun|account)\s+([0-9][a-z0-9.-]{0,29})\b/i)?.[1];
  if (intent === "change") {
    answer.text = "Tanya Buku hanya membaca buku, tidak mengubahnya. Lakukan perubahan di halamannya agar tercatat dengan nama Anda: klasifikasi di Review atau di buku besar (Ubah akun), jurnal di Jurnal Penyesuaian, saldo awal di Saldo Awal, temuan dan penutupan di Tutup Buku.";
    return answer;
  }
  if (intent !== "context" && intent !== "evidence" && intent !== "unsupported") answer.preliminary = await preliminaryLabel(db, resolved);
  if (intent === "unsupported") {
    answer.text = "Pertanyaan ini belum didukung. Coba kesiapan tutup buku, laba, saldo kas, transfer ke/dari nama tertentu, transaksi yang perlu ditanyakan ke klien, profil perusahaan, atau pencarian dokumen.";
    return answer;
  }
  if (intent === "unclear") {
    // Deterministic: bank lines still in Review (1999) up to the month's end, largest amount first (UC-B3) — the list to ask the client about.
    const { end } = periodBounds(resolved.year, resolved.month);
    const lines = await db.bankTransaction.findMany({
      where: { firmId, entityId: { in: resolved.entityIds }, status: "NEEDS_REVIEW", date: { lte: end } },
      include: { bankAccount: { include: { entity: true } } },
      orderBy: [{ date: "asc" }, { rowNumber: "asc" }],
    });
    const size = (v: bigint) => (v < 0n ? -v : v);
    lines.sort((x, y) => (size(y.amount) > size(x.amount) ? 1 : size(y.amount) < size(x.amount) ? -1 : 0));
    const names = new Map((await db.account.findMany({ where: { clientId: { in: resolved.clientIds } }, select: { clientId: true, code: true, name: true } })).map((a) => [`${a.clientId}|${a.code}`, a.name]));
    const totals = new Map<string, { inn: bigint; out: bigint }>();
    for (const t of lines) {
      const sum = totals.get(t.bankAccount.currency) ?? { inn: 0n, out: 0n };
      if (t.amount > 0n) sum.inn += t.amount;
      else sum.out += -t.amount;
      totals.set(t.bankAccount.currency, sum);
    }
    const total = [...totals].map(([cur, v]) => [v.inn ? `masuk ${formatMoney(v.inn, cur)}` : "", v.out ? `keluar ${formatMoney(v.out, cur)}` : ""].filter(Boolean).join(", ")).join("; ");
    answer.text = lines.length
      ? `${lines.length} transaksi belum jelas sampai ${periodLabel} (${total}). Tanyakan ke klien dari siapa uang masuk dan untuk apa uang keluar, lalu pilih akunnya di Review.`
      : `Tidak ada transaksi yang menunggu review sampai ${periodLabel} di cakupan ini.`;
    for (const t of lines.slice(0, 30)) {
      const clientId = t.bankAccount.entity.clientId;
      const href = workspaceHref(`/clients/${clientId}/review`, resolved, { entity: t.entityId });
      const amount = t.amount < 0n ? -t.amount : t.amount;
      const guess = t.suggestedCode ? `usulan ${t.suggestedCode} ${names.get(`${clientId}|${t.suggestedCode}`) ?? ""}`.trim() : "tanpa usulan";
      answer.rows.push({
        label: `${formatDate(t.date)} · ${t.bankAccount.entity.shortName} · ${t.bankAccount.label} · ${t.description.slice(0, 80)}`,
        value: `${t.amount > 0n ? "Masuk" : "Keluar"} ${formatMoney(amount, t.bankAccount.currency)} · ${guess}`,
        source: href,
      });
    }
    const entities = [...new Map(lines.map((t) => [t.entityId, t.bankAccount.entity])).values()];
    for (const e of entities) answer.citations.push({ label: `${e.shortName} · Review transaksi`, href: workspaceHref(`/clients/${e.clientId}/review`, resolved, { entity: e.id }) });
    if (lines.length > 30) answer.limitations.push(`Menampilkan 30 dari ${lines.length} transaksi, dari nominal terbesar; totalnya dari semua. Daftar lengkapnya bisa diunduh di Review.`);
    answer.limitations.push("Dari mutasi bank yang masih di Review (1999). Transaksi yang sudah diterima dengan tebakan ada di kontrol Tutup Buku.");
    return answer;
  }
  if (intent === "transactions") {
    // Deterministic: bank lines of the scope's entities in the month whose description holds every word of the name.
    const who = counterpartyOf(question)!;
    const words = who.split(/\s+/).filter((w) => w.length >= 2).slice(0, 6);
    const { start, end } = periodBounds(resolved.year, resolved.month);
    const lines = await db.bankTransaction.findMany({
      where: { firmId, entityId: { in: resolved.entityIds }, date: { gte: start, lte: end }, AND: words.map((w) => ({ description: { contains: w, mode: "insensitive" as const } })) },
      include: { bankAccount: { include: { entity: true } } },
      orderBy: [{ date: "asc" }, { rowNumber: "asc" }],
      take: 201,
    });
    const shown = lines.slice(0, 200);
    const names = new Map((await db.account.findMany({ where: { clientId: { in: resolved.clientIds } }, select: { clientId: true, code: true, name: true } })).map((a) => [`${a.clientId}|${a.code}`, a.name]));
    // Totals per account: the transfer itself and the bank's fee on it are different things (1190 vs 7100).
    const byAccount = new Map<string, { n: number; cur: string; inn: bigint; out: bigint }>();
    for (const t of shown) {
      const code = t.status === "NEEDS_REVIEW" ? "1999" : (t.accountCode ?? "1999");
      const k = `${code}|${t.bankAccount.currency}`;
      const sum = byAccount.get(k) ?? { n: 0, cur: t.bankAccount.currency, inn: 0n, out: 0n };
      sum.n++;
      if (t.amount > 0n) sum.inn += t.amount;
      else sum.out += -t.amount;
      byAccount.set(k, sum);
    }
    const accounts = [...byAccount]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([k, v]) => `${k.split("|")[0]} (${v.n}×): ${[v.inn ? `masuk ${formatMoney(v.inn, v.cur)}` : "", v.out ? `keluar ${formatMoney(v.out, v.cur)}` : ""].filter(Boolean).join(", ")}`)
      .join("; ");
    answer.text = shown.length
      ? `${shown.length} mutasi bank dengan "${who}" pada ${periodLabel}. Per akun: ${accounts}.`
      : `Tidak ada mutasi bank dengan "${who}" pada ${periodLabel} di cakupan ini.`;
    for (const t of shown.slice(0, 30)) {
      const clientId = t.bankAccount.entity.clientId;
      const waiting = t.status === "NEEDS_REVIEW";
      const code = waiting ? "1999" : (t.accountCode ?? "1999");
      const href = workspaceHref(`/clients/${clientId}/ledger/${encodeURIComponent(code)}`, resolved, { entity: t.entityId });
      const amount = t.amount < 0n ? -t.amount : t.amount;
      answer.rows.push({
        label: `${formatDate(t.date)} · ${t.bankAccount.entity.shortName} · ${t.bankAccount.label} · ${t.description.slice(0, 80)}`,
        value: `${t.amount > 0n ? "Masuk" : "Keluar"} ${formatMoney(amount, t.bankAccount.currency)} → ${waiting ? `menunggu review (usulan ${t.suggestedCode ?? "-"})` : `${code} ${names.get(`${clientId}|${code}`) ?? ""}`.trim()}`,
        source: href,
      });
      answer.citations.push({ label: `${t.bankAccount.entity.shortName} · buku besar ${code}`, href });
    }
    if (lines.length > 200) answer.limitations.push("Lebih dari 200 mutasi cocok; total dihitung dari 200 pertama. Persempit namanya atau pilih perusahaan.");
    if (shown.length > 30) answer.limitations.push(`Menampilkan 30 dari ${shown.length} mutasi; totalnya dari semua yang cocok.`);
    answer.limitations.push("Dicari dari keterangan rekening koran pada bulan terpilih; jurnal penyesuaian dan buku besar impor tidak ikut dihitung.");
  } else if (intent === "context" || intent === "evidence") {
    // Intake client ownership plus confirmed entity/period selections restrict source passages.
    const intakes = await db.evidenceIntake.findMany({ where: { firmId, clientId: { in: resolved.clientIds } }, orderBy: { id: "asc" }, take: 11 });
    for (const intake of intakes.slice(0, 10)) {
      const searchQuestion = `Cari dokumen ${question.replace(/banding\w*|compare|perbandingan|kurang|missing|belum lengkap|rekonsiliasi|selisih|control|kontrol|kenapa saldo|profil|company|perusahaan|usaha|fiskal/gi, "")}`.slice(0, 2000);
      const result = await askEvidence(db, firmId, intake.id, { question: intent === "context" ? "Profil perusahaan" : searchQuestion, ...(intent === "context" ? {} : { period }), ...(resolved.kind === "entity" ? { entityId: resolved.entityIds[0] } : {}) }, null);
      answer.rows.push(...(result.rows ?? []).slice(0, Math.max(0, 30 - answer.rows.length)).map(r => ({ ...r, label: `${intake.name} · ${r.label}` })));
      answer.citations.push(...result.citations.map(c => ({ label: `${c.label} · ${c.locator}`, href: workspaceHref(`/documents/source/${encodeURIComponent(c.versionId)}#cited-source`, resolved, { at: c.locator, answer: answer.id }) })));
      answer.limitations.push(...result.limitations);
      if (answer.rows.length >= 30) break;
    }
    answer.text = answer.rows.length ? intent === "context" ? "Konteks perusahaan beserta status konfirmasi dan sumbernya." : "Bukti dokumen pada cakupan terpilih. Angka dari sumber belum merupakan saldo buku Buku." : intent === "context" ? "Belum ada konteks perusahaan untuk cakupan terpilih." : "Belum ada bukti dokumen dengan cakupan perusahaan dan periode yang sesuai.";
    if (intakes.length > 10 || answer.rows.length >= 30) answer.limitations.push("Hasil dibatasi 10 kumpulan dan 30 baris; pilih klien atau perusahaan untuk mempersempit pencarian.");
    answer.limitations.push(intent === "context" ? "Profil perusahaan memakai konteks yang tersedia, termasuk tanpa tanggal; ini bukan posisi historis pada bulan terpilih. Dokumen tanpa klien tidak disertakan." : "Dokumen tanpa klien atau periode yang sesuai tidak disertakan. Periksa cakupan dokumen di Dokumen.");
  } else {
    const data = await getWorkspaceOverview(db, access, { scope: key, period });
    if (intent === "readiness") {
      answer.text = `Kesiapan tutup buku untuk ${periodLabel}. Penutupan berlaku untuk seluruh grup/klien.`;
      for (const c of data.clients) {
        answer.rows.push({ label: c.name, value: `${c.label} · ${c.failCount} kontrol gagal · ${c.reviewCount} temuan belum diakui · ${c.missingSignoffs} pemeriksaan akhir`, source: c.closeHref });
        // Name what to do, failed controls first: a count alone tells the accountant nothing to start on.
        for (const f of c.open.slice(0, 10)) answer.rows.push({ label: `${c.name} · ${f.scope}`, value: `${f.status === "FAIL" ? "Gagal" : "Perlu dicek"}: ${f.title}`, source: f.href });
        if (c.open.length > 10) answer.limitations.push(`${c.name}: menampilkan 10 dari ${c.open.length} temuan; daftar lengkap di Tutup Buku.`);
        answer.citations.push({ label: `${c.name} · kontrol tutup buku`, href: c.closeHref });
      }
      if (resolved.kind === "entity") answer.limitations.push("Kesiapan mencakup seluruh klien induk, termasuk perusahaan lain di dalamnya.");
    } else {
      // The entity a question names answers for itself ("saldo BCA Rawasari PT SKP"); in a related-party question the first one named is
      // whose books, the others are the counterparties.
      const mentioned = entitiesNamed(question, data.entities);
      const related = intent === "balances" && RELATED.test(question);
      const subjects = mentioned.length ? (related ? [mentioned[0]] : mentioned) : data.entities;
      if (mentioned.length && subjects.length < data.entities.length) answer.limitations.push(`Dijawab untuk ${subjects.map((e) => e.name).join(", ")}, yang disebut di pertanyaan.`);
      const ownNames = data.entities.flatMap((e) => [e.name, e.shortName]);
      // A balance asked by name: Buku's accounts and the client's own (imported) accounts at the month's end.
      const named: { label: string; value: string; source: string; net: bigint }[] = [];
      const { end } = periodBounds(resolved.year, resolved.month);
      const candidatesOf = async (e: (typeof data.entities)[number]) => {
        const tb = new Map((await trialBalance(db, { clientId: e.clientId, entityIds: [e.id] }, end)).map((r) => [r.account.code, r.net]));
        const chart = await db.account.findMany({ where: { clientId: e.clientId, isSuspense: false, isClearing: false }, select: { code: true, name: true, type: true } });
        // A client's own income or expense account counts from the start of the tahun buku, like Buku's (trialBalance).
        const yearStart = financialYear(await fiscalEndMonth(db, e.clientId), resolved.year, resolved.month).start;
        const sources = await db.sourceAccount.findMany({ where: { entityId: e.id }, select: { id: true, code: true, name: true, account: { select: { type: true } } } });
        const sum = async (from?: Date) => new Map((await db.journalLine.groupBy({ by: ["sourceAccountId"], where: { entityId: e.id, date: { gte: from, lte: end }, sourceAccountId: { not: null } }, _sum: { debit: true, credit: true } })).map((x) => [x.sourceAccountId!, (x._sum.debit ?? 0n) - (x._sum.credit ?? 0n)]));
        const [lifetime, ytd] = await Promise.all([sum(), sum(yearStart)]);
        return [
          ...chart.map((a) => ({ code: a.code, name: a.name, type: a.type as string | null, label: `${a.code} ${a.name}`, net: tb.get(a.code) ?? 0n, href: workspaceHref(`/clients/${e.clientId}/ledger/${encodeURIComponent(a.code)}`, resolved, { entity: e.id }) })),
          ...sources.map((x) => {
            const pl = x.account?.type === "PENDAPATAN" || x.account?.type === "BEBAN";
            return { code: x.code, name: x.name, type: (x.account?.type ?? null) as string | null, label: `${x.code} ${x.name} (akun klien)`, net: (pl ? ytd : lifetime).get(x.id) ?? 0n, href: workspaceHref(`/clients/${e.clientId}/ledger/akun/${x.id}`, resolved, { entity: e.id }) };
          }),
        ];
      };
      const push = (e: (typeof data.entities)[number], c: { label: string; net: bigint; href: string }) => {
        named.push({ label: `${e.name} · ${c.label}`, value: c.net === 0n ? formatMoney(0n, e.currency) : `${formatMoney(c.net < 0n ? -c.net : c.net, e.currency)} ${c.net < 0n ? "Kredit" : "Debit"}`, source: c.href, net: c.net });
        answer.citations.push({ label: `${e.name} · buku besar ${c.label}`, href: c.href });
      };
      if (intent === "balances") {
        for (const e of subjects) {
          const candidates = await candidatesOf(e);
          let found: typeof candidates;
          if (accountCode) {
            // A code is Buku's or the client's own ("akun 10005" from an imported ledger).
            found = candidates.filter((c) => c.code.toLowerCase() === accountCode.toLowerCase());
          } else if (related) {
            // Related parties Buku knows: the group's other entities (by a distinctive word of their name), 1190, and accounts named as such.
            const siblings = (await db.entity.findMany({ where: { clientId: e.clientId, id: { not: e.id } }, select: { name: true, shortName: true } }))
              .flatMap((x) => [bareName(x.name), bareName(x.shortName)]).flatMap((n) => n.split(" ")).filter((w) => w.length >= 4 && !GENERIC.has(w) && !` ${bareName(e.name)} `.includes(` ${w} `));
            const q = question.toLowerCase();
            const side = /\b(utang|hutang|payables?|liabilitas|kewajiban)\b/.test(q) && !/\bpiutang\b/.test(q) ? "LIABILITAS" : /\b(piutang|receivables?|tagihan)\b/.test(q) ? "ASET" : null;
            const words = (n: string) => n.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ");
            found = candidates.filter((c) =>
              (c.code === "1190" || /related|berelasi|afiliasi|affiliat|pemegang saham|shareholder|direksi|director|induk|subsidiar|anak perusahaan/i.test(c.name) || words(c.name).some((w) => siblings.includes(w))) &&
              (!side || !c.type || c.type === side));
          } else {
            found = accountsNamed(question, candidates, 5, ownNames);
          }
          // Balances first; a zero account only when nothing that matched holds a balance (an unused "Related Party Payable" is not the answer).
          const held = found.filter((c) => c.net !== 0n);
          for (const c of (held.length ? held : found).slice(0, 12)) push(e, c);
        }
      }
      const cashToo = (!named.length && !related && !accountCode) || (CASH_WORDS.test(question.toLowerCase()) && !accountCode);
      answer.text =
        intent === "profit" ? `Laba dan pendapatan ${periodLabel}, dihitung dari jurnal Buku.`
        : accountCode ? `Saldo akun ${accountCode} pada akhir ${periodLabel}, dihitung dari jurnal Buku.`
        : related && !named.length ? `Tidak ada akun pihak berelasi dengan saldo pada akhir ${periodLabel}. Buku mengenali pihak berelasi dari nama perusahaan lain di grup dan akun 1190; sebutkan nama akunnya bila berbeda.`
        : related ? `Saldo pihak berelasi pada akhir ${periodLabel}: akun yang menyebut perusahaan lain di grup, 1190, dan akun bernama pihak berelasi, dihitung dari jurnal Buku.`
        : named.length && !cashToo ? `Saldo akun yang disebut pada akhir ${periodLabel}, dihitung dari jurnal Buku.`
        : named.length ? `Saldo kas dan bank aset, dan akun yang disebut, pada akhir ${periodLabel}, dihitung dari jurnal Buku.`
        : `Saldo kas dan bank aset pada akhir ${periodLabel}, dihitung dari jurnal Buku.`;
      answer.rows.push(...named.map((r) => ({ label: r.label, value: r.value, source: r.source })));
      if (accountCode && !named.length) for (const e of subjects) answer.rows.push({ label: `${e.name} · ${accountCode}`, value: "Akun tidak ditemukan", source: e.reportHref });
      if (intent === "profit" || cashToo) for (const e of subjects) {
        if (!e.hasBooks || (intent === "profit" && !e.hasActivity)) answer.limitations.push(`${e.name}: belum ada jurnal pada ${periodLabel}.`);
        const href = intent === "profit" ? e.reportHref : workspaceHref(`/clients/${e.clientId}/trial-balance`, resolved, { entity: e.id });
        answer.rows.push({ label: `${e.name} · ${e.currency}`, value: intent === "profit" ? `Pendapatan ${e.revenueFormatted}; laba bersih ${e.profitFormatted}` : e.cashFormatted, source: href });
        answer.citations.push({ label: `${e.name} · ${intent === "profit" ? "laporan dari buku besar" : "neraca saldo"}`, href });
      }
      answer.limitations.push("Setiap perusahaan dalam mata uangnya sendiri; perbandingan ini bukan konsolidasi. Dokumen laporan unggahan tidak dihitung sebagai jurnal.");
      if (intent === "balances") answer.limitations.push(accountCode || named.length ? "Saldo neraca kumulatif sampai akhir bulan; akun laba rugi dihitung sejak awal tahun buku klien." : "Saldo kumulatif sampai akhir bulan; rekening utang/cerukan tidak termasuk kas aset. Untuk akun lain, sebutkan nama atau kode akunnya.");
      if (/kenapa|mengapa|why|penyebab|banding|compare|perubahan|naik|turun/.test(question.toLowerCase())) answer.limitations.push("Jawaban menampilkan periode terpilih saja; perbandingan antarperiode dan penyebab perubahan belum didukung di Tanya Buku.");
    }
  }
  if (!answer.rows.length) answer.limitations.push("Tidak ada data yang cocok. Ini tidak berarti saldo nol atau pekerjaan telah lengkap.");
  answer.limitations = [...new Set(answer.limitations)];
  answer.citations = [...new Map(answer.citations.map(c => [c.href, c])).values()];
  return answer;
}
