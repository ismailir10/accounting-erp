import { readSheets, cellText, cellDate } from "@/lib/ledger-import/read";
import type { RawCell, RawSheet } from "@/lib/ledger-import/types";
import { ParseError } from "@/lib/import/types";
import { centsToMinor, parseCents } from "@/lib/money";

/**
 * A Coretax faktur export (I5c): *Daftar Faktur Keluaran* (the buyer's NPWP/name columns) or *Daftar Faktur Masukan* (the seller's), as
 * XLSX/XLS/CSV. Pure: the rows as written with their `sheet!row`, whether each counts toward the SPT Masa PPN, and notes. Nothing here
 * decides what the books should say.
 */
export type FakturDirection = "KELUARAN" | "MASUKAN";
export type FakturRow = {
  number: string;
  date: Date;
  year: number;
  month: number;
  npwp: string | null;
  name: string;
  dpp: bigint;
  ppn: bigint;
  status: string;
  /** Counted toward the masa: not cancelled, replaced, rejected or a draft; for masukan, credited (or no status column). */
  counted: boolean;
  /** Masukan approved but not (yet) credited by the buyer. */
  uncredited: boolean;
  sourceRef: string;
};
export type FakturRead = { direction: FakturDirection; sheet: string; rows: FakturRow[]; notes: string[] };

type Col = "number" | "date" | "dpp" | "ppn" | "masa" | "year" | "status" | "npwp" | "name";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
/** Which column a header names. Order matters: "DPP Nilai Lain" is not the DPP, "Tanggal Faktur" before a generic "Faktur". */
function columnOf(h: string): Col | "dppOther" | "ppnbm" | null {
  const t = norm(h);
  if (!t) return null;
  if (/ppnbm/.test(t)) return "ppnbm";
  if (/nilai lain/.test(t)) return "dppOther";
  if (/^(no\.?|nomor|nomer)\b.*faktur|^nomor fp\b|^no\.? fp\b|^faktur pajak$/.test(t)) return "number";
  if (/^tanggal\b|^tgl\b/.test(t) && /faktur|fp|dokumen/.test(t)) return "date";
  if (/^masa\b/.test(t)) return "masa";
  if (/^tahun\b/.test(t)) return "year";
  if (/^status\b/.test(t) && !/esign|e-sign|tanda tangan/.test(t)) return "status";
  if (/^(npwp|nik)\b/.test(t) && /pembeli|penjual/.test(t)) return "npwp";
  if (/^nama\b/.test(t) && /pembeli|penjual/.test(t)) return "name";
  if (/^(harga jual|dpp)\b|penggantian|dasar pengenaan/.test(t)) return "dpp";
  if (/^ppn\b|^pajak pertambahan nilai\b/.test(t)) return "ppn";
  return null;
}

const MONTHS = ["januari", "februari", "maret", "april", "mei", "juni", "juli", "agustus", "september", "oktober", "november", "desember"];
const MONTHS_EN = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function monthOf(c: RawCell | undefined): number | null {
  const t = norm(cellText(c));
  if (/^\d{1,2}$/.test(t)) return Number(t) >= 1 && Number(t) <= 12 ? Number(t) : null;
  const m = t.match(/^(\d{1,2})[-/ ]?(\d{4})$/); // "08-2026", "082026"
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return Number(m[1]);
  const i = MONTHS.findIndex((x) => t.startsWith(x.slice(0, 3)));
  if (i >= 0) return i + 1;
  const j = MONTHS_EN.findIndex((x) => t.startsWith(x.slice(0, 3)));
  return j >= 0 ? j + 1 : null;
}
function yearOf(c: RawCell | undefined): number | null {
  const m = cellText(c).match(/(20\d{2})/);
  return m ? Number(m[1]) : null;
}

// A faktur replaced by a faktur pengganti is shown by Coretax as AMENDED; only the pengganti counts (PER-03/PJ/2022).
const NOT_COUNTED = /batal|cancel|diganti|replac|amend|reject|ditolak|draft|konsep|tidak valid/i;
const CREDITED = /dikreditkan|credited/i;
const UNCREDITED = /tidak dikreditkan|belum dikreditkan|uncredited|not credited/i;

/** The header row: the first row (of the first 20) naming a number, a date, a DPP and a PPN column. */
function findHeader(sheet: RawSheet): { row: number; cols: Map<Col, number>; direction: FakturDirection | null } | null {
  for (let r = 0; r < Math.min(sheet.rows.length, 20); r++) {
    const cols = new Map<Col, number>();
    let direction: FakturDirection | null = null;
    (sheet.rows[r] ?? []).forEach((cell, i) => {
      const h = cellText(cell);
      const c = columnOf(h);
      if (c && c !== "dppOther" && c !== "ppnbm" && !cols.has(c)) cols.set(c, i);
      // Only the counterparty's NPWP / name column says whose list this is: a keluaran export also has "Dilaporkan oleh Penjual".
      if (c === "npwp" || c === "name") {
        if (/pembeli/i.test(h)) direction ??= "KELUARAN";
        else if (/penjual/i.test(h)) direction ??= "MASUKAN";
      }
    });
    if (cols.has("number") && cols.has("dpp") && cols.has("ppn")) return { row: r, cols, direction };
  }
  return null;
}

/** Whole Rupiah from a cell, rounding sen half up; `rounded` says sen were present. */
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

export function readFakturSheets(sheets: RawSheet[]): FakturRead {
  for (const sheet of sheets) {
    const h = findHeader(sheet);
    if (!h) continue;
    if (!h.direction) throw new ParseError("File faktur tidak menyebut pembeli atau penjual. Unduh Daftar Faktur Keluaran atau Masukan dari Coretax lalu unggah lagi.");
    if (!h.cols.has("date")) throw new ParseError("Kolom Tanggal Faktur tidak ditemukan. Unduh ulang daftar faktur dari Coretax dengan kolom tanggal.");
    const at = (row: RawCell[], c: Col) => (h.cols.has(c) ? row[h.cols.get(c)!] : undefined);
    const rows: FakturRow[] = [];
    const notes: string[] = [];
    let rounded = 0;
    for (let r = h.row + 1; r < sheet.rows.length; r++) {
      const row = sheet.rows[r] ?? [];
      const number = cellText(at(row, "number")).replace(/^'/, "");
      if (!number) continue;
      if (/^(total|jumlah)\b/i.test(number)) continue;
      const ref = `${sheet.name}!${r + 1}`;
      const date = cellDate(at(row, "date"));
      if (!date) throw new ParseError(`Baris ${ref}: tanggal faktur "${cellText(at(row, "date"))}" tidak terbaca.`);
      const dpp = rupiah(at(row, "dpp"));
      const ppn = rupiah(at(row, "ppn"));
      if (!dpp || !ppn) throw new ParseError(`Baris ${ref}: DPP atau PPN bukan angka.`);
      if (dpp.rounded || ppn.rounded) rounded++;
      const month = monthOf(at(row, "masa")) ?? date.getUTCMonth() + 1;
      const year = yearOf(at(row, "year")) ?? yearOf(at(row, "masa")) ?? date.getUTCFullYear();
      const status = cellText(at(row, "status"));
      const credited = !h.cols.has("status") || (CREDITED.test(status) && !UNCREDITED.test(status));
      const counted = !NOT_COUNTED.test(status) && (h.direction === "KELUARAN" || credited);
      rows.push({
        number,
        date,
        year,
        month,
        npwp: cellText(at(row, "npwp")).replace(/^'/, "") || null,
        name: cellText(at(row, "name")),
        dpp: dpp.v,
        ppn: ppn.v,
        status,
        counted,
        uncredited: h.direction === "MASUKAN" && !NOT_COUNTED.test(status) && !credited,
        sourceRef: ref,
      });
    }
    if (!rows.length) throw new ParseError("Daftar faktur kosong: tidak ada baris dengan nomor faktur.");
    const dup = rows.find((x, i) => rows.findIndex((y) => y.number === x.number) !== i);
    if (dup) throw new ParseError(`Nomor faktur ${dup.number} muncul lebih dari sekali (${dup.sourceRef}). Periksa file dari Coretax.`);
    if (rounded) notes.push(`${rounded} faktur memuat sen; dibulatkan ke Rupiah penuh per faktur.`);
    if (!h.cols.has("status")) notes.push("File tanpa kolom status: semua faktur dihitung.");
    if (!h.cols.has("masa")) notes.push("File tanpa kolom masa pajak: masa diambil dari tanggal faktur.");
    return { direction: h.direction, sheet: sheet.name, rows, notes };
  }
  throw new ParseError("Ini bukan daftar faktur Coretax: kolom Nomor Faktur, DPP dan PPN tidak ditemukan.");
}

export async function readFaktur(fileName: string, data: Buffer): Promise<FakturRead> {
  return readFakturSheets(await readSheets(fileName, data));
}
