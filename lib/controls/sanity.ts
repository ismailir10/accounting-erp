import { ACCOUNT_CODES, isIntercompanyCode } from "@/lib/coa/template";
import type { Db } from "@/lib/db";
import type { EntityKind } from "@/lib/generated/prisma/enums";
import { formatMoney } from "@/lib/money";
import type { TbRow } from "@/lib/reports/ledger";
import type { Control } from "@/lib/controls";
import { FINANCING, FINANCING_COST } from "@/lib/classify/financing";

/**
 * Sanity controls (accounting-rules 22a, ADR 0009): the books add up, but do they make sense?
 * Deterministic only. Each check is emitted only when it flags; `runControls` adds one PASS row for a clean entity.
 */

/** The same financing words the classifier uses (lib/classify/financing), so suggestion and control can't disagree. */
export { FINANCING, FINANCING_COST };
/** Below this, an AI answer is a guess; HEURISTIC always is. */
export const GUESS_CONFIDENCE = 0.6;

type Args = {
  clientId: string;
  entity: { id: string; shortName: string; functionalCurrency: string; kind: EntityKind };
  /** The client's *Bidang usaha* as typed (free text). */
  industry: string | null;
  /** The Neraca's totals at period end (intercompany 1190 credits presented as liabilities, as the report shows them). */
  bsTotals: { assets: bigint; liabilities: bigint; equity: bigint };
  tb: TbRow[];
  start: Date;
  end: Date;
  base: string;
  acks: Map<string, string>;
  /** A bank control already says this month's statement is missing: don't flag the empty month twice. */
  statementMissing: boolean;
};

export async function sanityControls(db: Db, a: Args): Promise<Control[]> {
  const fmt = (v: bigint) => formatMoney(v, a.entity.functionalCurrency);
  const e = a.entity;
  const out: Control[] = [];
  const control = (key: string, title: string, status: Control["status"], detail: string, href?: string) =>
    out.push({ key: `${key}:${e.id}`, title, scope: e.shortName, status, detail, href, ack: status === "REVIEW" ? a.acks.get(`${key}:${e.id}`) : undefined });

  // 1. Total assets can't be negative — as the Neraca presents them (an intercompany 1190 credit is a liability there).
  const assets = a.bsTotals.assets;
  if (assets < 0n) control("nature-total", "Total aset negatif", "FAIL", `Total aset ${fmt(assets)} — tidak mungkin; cek klasifikasi transaksi`, `${a.base}/reports?entity=${e.id}`);

  // 2. Balance-sheet accounts against their nature (contra accounts already carry the opposite normal balance).
  const against = a.tb.filter(
    (r) =>
      (r.account.type === "ASET" || r.account.type === "LIABILITAS") &&
      !r.account.isIntercompany && !r.account.isClearing && !r.account.isSuspense &&
      (r.account.normalBalance === "DEBIT" ? r.net < 0n : r.net > 0n),
  );
  if (against.length) {
    const list = against.slice(0, 5).map((r) => `${r.account.code} ${r.account.name} saldo ${r.net < 0n ? "kredit" : "debit"} ${fmt(r.net < 0n ? -r.net : r.net)}`);
    control("nature", "Saldo berlawanan dengan sifat akun", "REVIEW", list.join("; ") + (against.length > 5 ? `; +${against.length - 5} lainnya` : ""), `${a.base}/ledger/${against[0].account.code}?entity=${e.id}`);
  }

  // 3. Financing text classified to the P&L (bank lines; ledger lines keep no description per line).
  const { txs, financing, guesses } = await flaggedBankRows(db, a.clientId, e.id, a.start, a.end);
  if (financing.length) {
    const total = financing.reduce((s, t) => s + (t.amount < 0n ? -t.amount : t.amount), 0n);
    const top = [...financing].sort((x, y) => (abs(y.amount) > abs(x.amount) ? 1 : -1)).slice(0, 3);
    control(
      "pl-financing",
      "Pinjaman / modal / pindah dana tercatat di Laba Rugi",
      "REVIEW",
      `${financing.length} transaksi, total ${fmt(total)}: ${top.map((t) => `“${t.description.slice(0, 40)}” ${fmt(t.amount)} → ${t.accountCode}`).join("; ")}`,
      `${a.base}/ledger/${top[0].accountCode}?period=${periodKey(a.start)}&entity=${e.id}`,
    );
  }

  // 4. A month without data after the entity started and outside any posted ledger file's date range.
  if (!a.statementMissing && txs.length === 0) {
    const inPeriod = await db.journalLine.count({ where: { entityId: e.id, date: { gte: a.start, lte: a.end } } });
    const before = inPeriod === 0 && (await db.journalLine.findFirst({ where: { entityId: e.id, date: { lt: a.start } }, select: { id: true } }));
    // A posted ledger file whose rows span this month already says "nothing happened here" (e.g. an annual GL).
    const covered = before && (await db.ledgerImport.findFirst({ where: { clientId: a.clientId, status: "POSTED", mode: "LEDGER", periodStart: { lte: a.end }, periodEnd: { gte: a.start }, entries: { some: { entityId: e.id } } }, select: { id: true } }));
    if (before && !covered) control("activity", "Tidak ada transaksi bulan ini", "REVIEW", "Belum ada mutasi atau buku besar untuk bulan ini. Pastikan datanya sudah lengkap sebelum ditutup", `${a.base}/import`);
  }

  // 5. Guesses accepted as they were.
  if (guesses.length) {
    const total = guesses.reduce((s, t) => s + abs(t.amount), 0n);
    // How much of the month's money that is (UC-B3: leakage into the default account shows as a share, not only a count).
    // Own transfers and intercompany moves count out and in again without being anyone's money in or out: left out of the base.
    const moved = txs.filter((t) => t.accountCode !== ACCOUNT_CODES.CLEARING && !isIntercompanyCode(t.accountCode)).reduce((s, t) => s + abs(t.amount), 0n);
    const share = moved > 0n ? `, ${percentOf(total, moved)} dari uang masuk dan keluar bulan ini` : "";
    control("guess", "Tebakan diterima tanpa diubah", "REVIEW", `${guesses.length} transaksi (${fmt(total)}${share}) disetujui persis seperti tebakan dengan keyakinan rendah`, `${a.base}/ledger?entity=${e.id}`);
  }

  // 6. Capital deficiency: a company whose liabilities exceed its assets (going concern, SAK EP / PSAK 201).
  if (e.kind !== "PERORANGAN" && assets >= 0n) {
    const { liabilities, equity } = a.bsTotals;
    if (equity < 0n) {
      control(
        "going-concern",
        "Defisiensi modal",
        "REVIEW",
        `Ekuitas ${fmt(equity)}: liabilitas ${fmt(liabilities)} melebihi aset ${fmt(assets)}. Nilai kelangsungan usaha dan ungkapkan rencana manajemen di CALK`,
        `${a.base}/reports?entity=${e.id}&tab=bs`,
      );
    }
  }

  // 7. A trading business with sales this month and no cost of sales: purchases may sit elsewhere (paid by the owner, another account).
  if (a.industry && TRADING.test(a.industry)) {
    const moved = await db.journalLine.groupBy({
      by: ["accountId"],
      where: { entityId: e.id, date: { gte: a.start, lte: a.end }, entry: { kind: { not: "OPENING" } }, account: { fsLine: { in: ["PENDAPATAN_USAHA", "HPP"] } } },
      _sum: { debit: true, credit: true },
    });
    const lines = await db.account.findMany({ where: { id: { in: moved.map((m) => m.accountId) } }, select: { id: true, fsLine: true } });
    const net = (fsLine: string) =>
      moved.filter((m) => lines.find((l) => l.id === m.accountId)?.fsLine === fsLine).reduce((s, m) => s + (m._sum.credit ?? 0n) - (m._sum.debit ?? 0n), 0n);
    const revenue = net("PENDAPATAN_USAHA");
    if (revenue > 0n && net("HPP") === 0n) {
      control(
        "no-cogs",
        "Penjualan tanpa harga pokok",
        "REVIEW",
        `Penjualan ${fmt(revenue)} bulan ini tanpa pembelian atau HPP, padahal bidang usaha perdagangan. Cek apakah barang dibeli lewat rekening lain atau dibayar pemilik (1190), dan catat HPP/persediaannya`,
        `${a.base}/reports?entity=${e.id}`,
      );
    }
  }

  return out;
}

/** Words in the client's *Bidang usaha* that mean it resells goods (so revenue without cost of sales is odd). */
export const TRADING = /dagang|perdagangan|toko|retail|ritel|distribut|grosir|jual[ -]?beli|trading|reseller/i;

type SplitLine = { amount: bigint; accountCode: string | null; description: string; splits: { accountCode: string; amount: bigint }[] };
/**
 * A bank line as the rows a check reads: one per part when it is split (pecah transaksi), each with that part's account and signed
 * amount, so a 200 jt line split 120/80 is never read as 200 jt on its largest part. `only`: keep the parts on these accounts.
 */
export function byPart<T extends SplitLine>(t: T, only?: Set<string>): T[] {
  if (!t.splits.length) return [t];
  return t.splits
    .filter((p) => !only || only.has(p.accountCode))
    .map((p) => ({ ...t, accountCode: p.accountCode, amount: t.amount < 0n ? -p.amount : p.amount, description: `${t.description} (bagian ${p.accountCode})` }));
}

/** Bank rows behind the financing and guess checks; shared with the AI close review so both see the same rows. */
export async function flaggedBankRows(db: Db, clientId: string, entityId: string, start: Date, end: Date) {
  const txs = await db.bankTransaction.findMany({
    where: { entityId, date: { gte: start, lte: end }, status: { in: ["POSTED", "REVIEWED"] }, accountCode: { not: null } },
    include: { splits: { orderBy: { position: "asc" } } },
    orderBy: [{ date: "asc" }, { rowNumber: "asc" }],
  });
  const plCodes = new Set((await db.account.findMany({ where: { clientId, type: { in: ["PENDAPATAN", "BEBAN"] } }, select: { code: true } })).map((x) => x.code));
  return {
    txs,
    financing: txs.flatMap((t) => byPart(t)).filter((t) => plCodes.has(t.accountCode!) && FINANCING.test(t.description) && !FINANCING_COST.test(t.description)),
    guesses: txs.filter((t) => t.status === "REVIEWED" && (t.method === "HEURISTIC" || (t.method === "AI" && t.confidence < GUESS_CONFIDENCE))),
  };
}

const abs = (v: bigint) => (v < 0n ? -v : v);
/** "12,5%" of a whole, half up to one decimal, in bigint (no float on amounts). */
const percentOf = (part: bigint, whole: bigint) => {
  const tenths = (part * 1000n + whole / 2n) / whole;
  return `${tenths / 10n}${tenths % 10n ? `,${tenths % 10n}` : ""}%`;
};
const periodKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
