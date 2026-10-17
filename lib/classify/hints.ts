/**
 * Accountant hints in Review (accounting-rules 13b): what an Indonesian reviewer checks on a line before accepting it, as plain
 * Bahasa notes with an optional one-click fill. Deterministic and never applied on their own: the accountant decides (AI-free, so
 * they cost nothing and work in rules-only mode). Each hint reacts to the current selection, so it disappears once handled.
 */
export type HintInput = {
  description: string;
  /** Signed bank amount in minor units: + in, − out. */
  amount: bigint;
  /** The selected account. */
  account: { code: string; name: string; group: string } | null;
  /** Withholding chosen ("none" or a kind). */
  wht: string;
  /** PT / CV / BADAN_USAHA_ASING withhold as payers; a PERORANGAN (non-employer owner) usually does not. */
  entityKind: string;
};
export type Hint = { key: string; text: string; apply?: { code?: string; wht?: string; rate?: string }; applyLabel?: string };

const CAPEX = /\b(mesin|kendaraan|mobil|truk|motor|komputer|laptop|server|gedung|bangunan|renovasi|peralatan|alat berat|genset|forklift|ac\b|furnitur|mebel)/i;
const DOWN_PAYMENT = /\b(dp|uang muka|down ?payment|panjar|termin 1)\b/i;
const SERVICE = /jasa|konsultan|profesional|notaris|audit|akuntan|legal|pengacara|desain|teknik|maintenance|perawatan|kebersihan|keamanan|katering|catering/i;
const RENT = /\bsewa\b/i;
const VEHICLE_RENT = /kendaraan|mobil|alat|forklift|truk/i;
const CAPEX_FLOOR = 5_000_000n;

const isBadan = (kind: string) => kind !== "PERORANGAN";
const type = (group: string) => group.split(" · ")[0];

export function accountantHints(h: HintInput): Hint[] {
  const out: Hint[] = [];
  const a = h.account;
  if (!a) return out;
  const t = type(a.group);
  const outflow = h.amount < 0n;
  const size = outflow ? -h.amount : h.amount;
  const noWht = !h.wht || h.wht === "none";

  // A customer's down payment is not revenue yet (PSAK 115); PPN is still due when it is received.
  if (!outflow && t === "Pendapatan" && DOWN_PAYMENT.test(h.description)) {
    out.push({ key: "dp", text: "Uang muka belum menjadi pendapatan: catat ke 2160 Pendapatan Diterima di Muka sampai barang atau jasa diserahkan (PSAK 115). PPN tetap terutang saat uang muka diterima.", apply: { code: "2160" }, applyLabel: "Pakai 2160" });
  }
  // A machine, vehicle or building bought as an expense: usually a fixed asset to depreciate.
  // Renting a vehicle is not buying one.
  const capex = RENT.test(h.description) ? null : h.description.match(CAPEX);
  if (outflow && t === "Beban" && capex && size >= CAPEX_FLOOR) {
    out.push({ key: "capex", text: `Pembelian ${capex[1].toLowerCase()} biasanya aset tetap: catat ke 1210 Aset Tetap, lalu daftarkan penyusutannya di Aset Tetap.`, apply: { code: "1210" }, applyLabel: "Pakai 1210" });
  }
  // A company paying for services or rent is a withholding agent (PPh 23 / 4(2)); the bank amount is then the net.
  if (outflow && isBadan(h.entityKind) && t === "Beban" && noWht) {
    if (RENT.test(a.name) || RENT.test(h.description)) {
      out.push(VEHICLE_RENT.test(h.description)
        ? { key: "rent23", text: "Sewa kendaraan atau alat oleh badan usaha dipotong PPh 23 2%. Pilih potongan bila pembayaran ini sudah dipotong.", apply: { wht: "PPH_23", rate: "2" }, applyLabel: "Potong PPh 23 2%" }
        : { key: "rent42", text: "Sewa tanah atau bangunan oleh badan usaha dipotong PPh 4(2) final 10%. Pilih potongan bila pembayaran ini sudah dipotong.", apply: { wht: "PPH_4_2", rate: "10" }, applyLabel: "Potong PPh 4(2) 10%" });
    } else if (!CAPEX.test(h.description) && !/pokok/i.test(a.group) && (SERVICE.test(a.name) || SERVICE.test(h.description))) {
      // Goods (a machine, materials for cost of sales) are not services, whatever the supplier's name says.
      out.push({ key: "svc23", text: "Jasa yang dibayar badan usaha biasanya dipotong PPh 23 2% (PPh 21 bila penerimanya orang pribadi). Pilih potongan bila pembayaran ini sudah dipotong.", apply: { wht: "PPH_23", rate: "2" }, applyLabel: "Potong PPh 23 2%" });
    }
  }
  return out;
}

/** Review's bar for "yakin": an AI suggestion at 80 % or more with an account (accounting-rules 14: nothing lower is bulk-accepted). */
export const SURE_CONFIDENCE = 0.8;
export const isSureSuggestion = (l: { method: string; confidence: number; suggestedCode: string | null }) => l.method === "AI" && l.confidence >= SURE_CONFIDENCE && Boolean(l.suggestedCode);

/**
 * A line that may be accepted in bulk, unchanged (Review's *Terima N usulan AI yakin*, Kotak persetujuan's *Setujui N usulan yakin*): a
 * sure suggestion with no accountant hint open on its suggested account. A hinted line (capex, a down payment, missing withholding) needs a look.
 */
export function bulkAcceptable(l: { method: string; confidence: number; suggestedCode: string | null; description: string; amount: bigint; entityKind: string }, account: HintInput["account"]): boolean {
  return isSureSuggestion(l) && accountantHints({ description: l.description, amount: l.amount, account, wht: "none", entityKind: l.entityKind }).length === 0;
}
