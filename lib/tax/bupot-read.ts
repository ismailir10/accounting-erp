import { readSheets, cellText, cellDate } from "@/lib/ledger-import/read";
import type { RawCell, RawSheet } from "@/lib/ledger-import/types";
import { ParseError } from "@/lib/import/types";
import { centsToMinor, parseCents } from "@/lib/money";
import { kopKind } from "@/lib/tax/bppu-codes";

/**
 * A Coretax bukti potong (BPPU, Unifikasi) export (I5d): the slips the company made for what it withheld (*dibuat*: the recipient's
 * columns) or the slips its customers made for what they withheld from it (*diterima*: the withholder's columns). Pure, like the faktur
 * reader: the rows as written with `sheet!row`, which count, and the tax kind from the Kode Objek Pajak.
 */
export type BupotDirection = "DIBUAT" | "DITERIMA";
export type BupotKind = "PPH_23" | "PPH_4_2" | "PPH_22" | "PPH_26" | "LAINNYA";
export const BUPOT_KIND_LABEL: Record<BupotKind, string> = { PPH_23: "PPh 23", PPH_4_2: "PPh 4(2)", PPH_22: "PPh 22", PPH_26: "PPh 26", LAINNYA: "Lainnya" };
export type BupotRow = {
  number: string;
  date: Date;
  year: number;
  month: number;
  npwp: string | null;
  name: string;
  kop: string;
  kind: BupotKind;
  dpp: bigint;
  pph: bigint;
  status: string;
  counted: boolean;
  sourceRef: string;
};
export type BupotRead = { direction: BupotDirection; sheet: string; rows: BupotRow[]; notes: string[] };

type Col = "number" | "date" | "pph" | "dpp" | "kop" | "jenis" | "masa" | "year" | "status";
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function columnOf(h: string): Col | null {
  const t = norm(h);
  if (!t) return null;
  if (/tarif/.test(t)) return null;
  if (/^(no\.?|nomor|nomer)\b.*(bukti|bupot)|^nomor (bp|bppu)\b|^no\.? (bp|bppu)\b/.test(t)) return "number";
  if (/^(tanggal|tgl)\b/.test(t) && /bukti|potong|pemotongan|dokumen|bp\b/.test(t)) return "date";
  if (/kode objek|^kop\b|^kode pajak/.test(t)) return "kop";
  if (/^jenis (pajak|pph)/.test(t)) return "jenis";
  if (/^masa\b/.test(t)) return "masa";
  if (/^tahun\b/.test(t)) return "year";
  if (/^status\b/.test(t) && !/esign|e-sign|tanda tangan/.test(t)) return "status";
  if (/^(dpp|dasar pengenaan|penghasilan bruto|jumlah bruto|bruto)\b/.test(t)) return "dpp";
  if (/^(pph|pajak penghasilan|jumlah pph)\b/.test(t) && !/ditanggung pemerintah|\bdtp\b/.test(t)) return "pph";
  return null;
}

const MONTHS = ["januari", "februari", "maret", "april", "mei", "juni", "juli", "agustus", "september", "oktober", "november", "desember"];
function monthOf(c: RawCell | undefined): number | null {
  const t = norm(cellText(c));
  if (/^\d{1,2}$/.test(t)) return Number(t) >= 1 && Number(t) <= 12 ? Number(t) : null;
  const m = t.match(/^(\d{1,2})[-/ ]?(\d{4})$/);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return Number(m[1]);
  const i = MONTHS.findIndex((x) => t.startsWith(x.slice(0, 3)));
  return i >= 0 ? i + 1 : null;
}
const yearOf = (c: RawCell | undefined) => {
  const m = cellText(c).match(/(20\d{2})/);
  return m ? Number(m[1]) : null;
};

/** The kind: the Kode Objek Pajak's first group (24-104-01 → PPh 23), else the Jenis Pajak words. */
export function kindOf(kop: string, jenis: string): BupotKind {
  const k = kopKind(kop);
  if (k) return k;
  const j = norm(jenis);
  if (/4\s*\(?\s*2\s*\)?|final/.test(j)) return "PPH_4_2";
  if (/\b23\b/.test(j)) return "PPH_23";
  if (/\b22\b/.test(j)) return "PPH_22";
  if (/\b26\b/.test(j)) return "PPH_26";
  return "LAINNYA";
}

const NOT_COUNTED = /batal|cancel|diganti|replac|reject|ditolak|draft|konsep/i;

function findHeader(sheet: RawSheet) {
  for (let r = 0; r < Math.min(sheet.rows.length, 20); r++) {
    const cols = new Map<Col, number>();
    const party = { penerima: { npwp: -1, name: -1 }, pemotong: { npwp: -1, name: -1 } };
    (sheet.rows[r] ?? []).forEach((cell, i) => {
      const h = norm(cellText(cell));
      const c = columnOf(h);
      if (c && !cols.has(c)) cols.set(c, i);
      for (const who of ["penerima", "pemotong"] as const) {
        if (!h.includes(who)) continue;
        if (/^(npwp|nik|nitku)\b/.test(h) && party[who].npwp < 0) party[who].npwp = i;
        if (/^nama\b/.test(h) && party[who].name < 0) party[who].name = i;
      }
    });
    if (!cols.has("number") || !cols.has("pph")) continue;
    // A list of slips the company made names the recipient; its own NPWP (the withholder) may be a column too.
    const hasPenerima = party.penerima.npwp >= 0 || party.penerima.name >= 0;
    const hasPemotong = party.pemotong.npwp >= 0 || party.pemotong.name >= 0;
    const direction: BupotDirection | null = hasPenerima ? "DIBUAT" : hasPemotong ? "DITERIMA" : null;
    return { row: r, cols, direction, party: direction === "DITERIMA" ? party.pemotong : party.penerima };
  }
  return null;
}

function rupiah(c: RawCell | undefined): { v: bigint; rounded: boolean } | null {
  const t = cellText(c);
  if (!t) return { v: 0n, rounded: false };
  try {
    const cents = parseCents(typeof c === "number" ? c : t);
    return { v: centsToMinor(cents, "IDR"), rounded: cents % 100n !== 0n };
  } catch {
    return null;
  }
}

export function readBupotSheets(sheets: RawSheet[]): BupotRead {
  for (const sheet of sheets) {
    const h = findHeader(sheet);
    if (!h) continue;
    if (!h.direction) throw new ParseError("File bukti potong tidak menyebut penerima penghasilan atau pemotong. Unduh daftar bukti potong dari Coretax lalu unggah lagi.");
    if (!h.cols.has("date")) throw new ParseError("Kolom tanggal bukti potong tidak ditemukan. Unduh ulang daftarnya dari Coretax dengan kolom tanggal.");
    const at = (row: RawCell[], c: Col) => (h.cols.has(c) ? row[h.cols.get(c)!] : undefined);
    const rows: BupotRow[] = [];
    const notes: string[] = [];
    let rounded = 0;
    for (let r = h.row + 1; r < sheet.rows.length; r++) {
      const row = sheet.rows[r] ?? [];
      const number = cellText(at(row, "number")).replace(/^'/, "");
      if (!number || /^(total|jumlah)\b/i.test(number)) continue;
      const ref = `${sheet.name}!${r + 1}`;
      const date = cellDate(at(row, "date"));
      if (!date) throw new ParseError(`Baris ${ref}: tanggal bukti potong "${cellText(at(row, "date"))}" tidak terbaca.`);
      const pph = rupiah(at(row, "pph"));
      const dpp = rupiah(at(row, "dpp"));
      if (!pph || !dpp) throw new ParseError(`Baris ${ref}: DPP atau PPh bukan angka.`);
      if (pph.rounded || dpp.rounded) rounded++;
      const status = cellText(at(row, "status"));
      const kop = cellText(at(row, "kop"));
      rows.push({
        number,
        date,
        month: monthOf(at(row, "masa")) ?? date.getUTCMonth() + 1,
        year: yearOf(at(row, "year")) ?? yearOf(at(row, "masa")) ?? date.getUTCFullYear(),
        npwp: h.party.npwp >= 0 ? cellText(row[h.party.npwp]).replace(/^'/, "") || null : null,
        name: h.party.name >= 0 ? cellText(row[h.party.name]) : "",
        kop,
        kind: kindOf(kop, cellText(at(row, "jenis"))),
        dpp: dpp.v,
        pph: pph.v,
        status,
        counted: !NOT_COUNTED.test(status),
        sourceRef: ref,
      });
    }
    if (!rows.length) throw new ParseError("Daftar bukti potong kosong: tidak ada baris dengan nomor bukti potong.");
    const dup = rows.find((x, i) => rows.findIndex((y) => y.number === x.number) !== i);
    if (dup) throw new ParseError(`Nomor bukti potong ${dup.number} muncul lebih dari sekali (${dup.sourceRef}). Periksa file dari Coretax.`);
    if (rounded) notes.push(`${rounded} bukti potong memuat sen; dibulatkan ke Rupiah penuh.`);
    if (!h.cols.has("kop") && !h.cols.has("jenis")) notes.push("File tanpa kode objek pajak: jenis PPh tidak dibandingkan.");
    if (!h.cols.has("masa")) notes.push("File tanpa kolom masa pajak: masa diambil dari tanggal bukti potong.");
    return { direction: h.direction, sheet: sheet.name, rows, notes };
  }
  throw new ParseError("Ini bukan daftar bukti potong Coretax: kolom Nomor Bukti Potong dan PPh tidak ditemukan.");
}

export async function readBupot(fileName: string, data: Buffer): Promise<BupotRead> {
  return readBupotSheets(await readSheets(fileName, data));
}
