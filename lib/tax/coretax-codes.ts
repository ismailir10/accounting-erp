/**
 * Codes and identity formats of DJP's faktur keluaran import (template *Sample Faktur PK Template v.1.6.1*, sheet REF-General and
 * Keterangan). Pure, so the forms and the file builder share them. Cycle docs/cycles/2026-10-17-coretax-files.md.
 */

/** *Barang/Jasa*: A barang, B jasa. */
export const ITEM_KINDS = ["A", "B"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const ITEM_KIND_LABEL: Record<ItemKind, string> = { A: "Barang", B: "Jasa" };
export const isItemKind = (s: string | null | undefined): s is ItemKind => s === "A" || s === "B";

/** *Kode Barang/Jasa* when none of DJP's codes fits; the item name then carries the detail. */
export const DEFAULT_ITEM_CODE = "000000";
export const ITEM_CODE = /^\d{6}$/;

/** *Nama Satuan Ukur* (REF-General, v1.6.1). */
export const UNITS: { code: string; label: string }[] = [
  ["UM.0001", "Metrik Ton"], ["UM.0002", "Wet Ton"], ["UM.0003", "Kilogram"], ["UM.0004", "Gram"], ["UM.0005", "Karat"],
  ["UM.0006", "Kiloliter"], ["UM.0007", "Liter"], ["UM.0008", "Barrel"], ["UM.0009", "MMBTU"], ["UM.0010", "Ampere"],
  ["UM.0011", "Sentimeter Kubik"], ["UM.0012", "Meter Persegi"], ["UM.0013", "Meter"], ["UM.0014", "Inci"], ["UM.0015", "Sentimeter"],
  ["UM.0016", "Yard"], ["UM.0017", "Lusin"], ["UM.0018", "Unit"], ["UM.0019", "Set"], ["UM.0020", "Lembar"],
  ["UM.0021", "Piece"], ["UM.0022", "Boks"], ["UM.0023", "Tahun"], ["UM.0024", "Bulan"], ["UM.0025", "Minggu"],
  ["UM.0026", "Hari"], ["UM.0027", "Jam"], ["UM.0028", "Menit"], ["UM.0029", "Persen"], ["UM.0030", "Kegiatan"],
  ["UM.0031", "Laporan"], ["UM.0032", "Bahan"], ["UM.0033", "Lainnya"], ["UM.0034", "Meter Kubik"], ["UM.0035", "Sentimeter Persegi"],
  ["UM.0036", "Drum"], ["UM.0037", "Karton"], ["UM.0038", "Kwh"], ["UM.0039", "Roll"],
].map(([code, label]) => ({ code, label }));
export const isUnit = (s: string | null | undefined) => !!s && UNITS.some((u) => u.code === s);
export const unitLabel = (code: string | null | undefined) => UNITS.find((u) => u.code === code)?.label ?? null;

/** A 15- or 16-digit NPWP (dots, dashes and spaces allowed) as Coretax's 16 digits: the 15-digit form gains a leading 0. Else null. */
export function npwp16(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s || !/^[\d.\-\s]+$/.test(s)) return null;
  const d = s.replace(/\D/g, "");
  return d.length === 16 ? d : d.length === 15 ? `0${d}` : null;
}

/** Digits only, when the text holds nothing but digits and separators; else null (a letter is a typing error, not a separator). */
export function digitsOnly(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!/^[\d.\-\s]*$/.test(s)) return null;
  return s.replace(/\D/g, "");
}

/** NITKU: 22 digits, the NPWP16 + a 6-digit place-of-business code; the head office is `000000`. */
export const NITKU = /^\d{22}$/;
export const headOfficeNitku = (npwp: string) => `${npwp}000000`;

/**
 * A typed NITKU against its holder's NPWP16 (`tin`): 22 digits starting with it. Empty, or the head office's NPWP16 + 000000, reads as
 * null (the file then writes the head office), so the default keeps following the NPWP.
 */
export function readNitku(raw: string | null | undefined, tin: string | null, holder: "pembeli" | "perusahaan"): { ok: true; nitku: string | null } | { ok: false; error: string } {
  const d = digitsOnly(raw);
  if (d === null || (d && !NITKU.test(d))) return { ok: false, error: "NITKU berisi 22 angka: 16 angka NPWP dan 6 angka kode tempat usaha (pusat 000000)." };
  if (!d) return { ok: true, nitku: null };
  if (!tin) return { ok: false, error: `NITKU hanya untuk ${holder} ber-NPWP. Isi NPWP-nya dulu.` };
  if (!d.startsWith(tin)) return { ok: false, error: `NITKU diawali 16 angka NPWP ${holder} (${tin}).` };
  return { ok: true, nitku: d === headOfficeNitku(tin) ? null : d };
}

export const NIK = /^\d{16}$/;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
