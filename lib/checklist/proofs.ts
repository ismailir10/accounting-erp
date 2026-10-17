import type { Control } from "@/lib/controls";
import { formatDateTime } from "@/lib/format";

/**
 * The Otomatis tasks (cycle 2026-10-17-checklist-tutup-buku): Buku ticks each from the books at read time and says how. Never stored and
 * never reviewed — the proof is the review — so one unticks itself when the books change in an open month. Every proof reuses a read the
 * firm board and Tutup Buku already make (completeness, Kotak count, controls, Saldo Awal progress, the period, the first export after
 * the lock); `prove` itself is pure.
 */
export const AUTO_KINDS = [
  { key: "sumber", label: "Rekening koran dan data bulan ini lengkap", title: "Minta rekening koran dan data", dueDay: 5, href: "/import", fix: "Unggah" },
  { key: "opening", label: "Saldo awal dicatat", title: "Saldo awal dicatat", dueDay: 10, href: "/opening", fix: "Saldo Awal" },
  { key: "approvals", label: "Review transaksi dan usulan", title: "Review transaksi dan usulan", dueDay: 8, href: "/approvals", fix: "Kotak persetujuan" },
  { key: "subledger", label: "Rekonsiliasi piutang & utang", title: "Rekonsiliasi piutang & utang", dueDay: 10, href: "/receivables", fix: "Piutang & Utang" },
  { key: "tax", label: "Pajak Masa diperiksa", title: "Pajak Masa diperiksa", dueDay: 10, href: "/tax/masa", fix: "Pajak Masa" },
  { key: "controls", label: "Kontrol tutup buku dicek", title: "Kontrol tutup buku dicek", dueDay: 10, href: "/close", fix: "Tutup Buku" },
  { key: "lock", label: "Tutup buku", title: "Tutup buku", dueDay: 15, href: "/close", fix: "Tutup Buku" },
  { key: "sent", label: "Laporan dikirim ke klien", title: "Laporan dikirim ke klien", dueDay: 15, href: "/reports", fix: "Laporan Keuangan" },
] as const;

export type AutoKey = (typeof AUTO_KINDS)[number]["key"];
export const isAutoKey = (k: string): k is AutoKey => AUTO_KINDS.some((a) => a.key === k);
export const autoKind = (k: AutoKey) => AUTO_KINDS.find((a) => a.key === k)!;
/** Done only after the lock, so the lock's warning never counts them. */
export const AFTER_LOCK: readonly AutoKey[] = ["lock", "sent"];

/** What the proofs read, per client-month. Each part is loaded only when an active task needs it (view.ts). */
export type ChecklistFacts = {
  controls: Control[];
  /** The board's *Sumber*: rows of the completeness grid for the month, and those with a missing or broken month. */
  sumber: { rows: number; gaps: number };
  /** Kotak persetujuan's total for the month (`approvalCounts`). */
  approvals: number;
  /** Companies whose Saldo Awal is still missing (setupProgress), and whether anything was imported yet. */
  opening: { needs: string[]; hasData: boolean };
  lockedAt: Date | null;
  /** The first report export for the month after the lock (the board's *Terkirim*). */
  sentAt: Date | null;
};

/** The facts each kind reads. */
export const NEEDS: Record<AutoKey, (keyof ChecklistFacts)[]> = {
  sumber: ["sumber"],
  opening: ["opening"],
  approvals: ["approvals"],
  subledger: ["controls"],
  tax: ["controls"],
  controls: ["controls"],
  lock: ["lockedAt"],
  sent: ["lockedAt", "sentAt"],
};

const SUBLEDGER = /^(ar|ap|subledger):/;
const TAX = /^(masa|faktur|bupot):/;
/** PASS, or a REVIEW with a note that still answers it; a FAIL never clears. */
const clear = (c: Control) => c.status === "PASS" || (c.status === "REVIEW" && Boolean(c.ack));

export type Proof = { ok: boolean; text: string };

/** The proof line of one Otomatis kind for the month (`periodLabel`, e.g. "Agustus 2026"). */
export function prove(key: AutoKey, f: ChecklistFacts, periodLabel: string): Proof {
  switch (key) {
    case "sumber":
      if (!f.sumber.rows) return { ok: false, text: "Belum ada rekening koran atau file buku untuk bulan ini" };
      return f.sumber.gaps ? { ok: false, text: `Ada celah: ${f.sumber.gaps} rekening ${periodLabel} belum lengkap` } : { ok: true, text: `Semua rekening koran ${periodLabel} lengkap` };
    case "opening":
      if (!f.opening.hasData) return { ok: false, text: "Belum ada data: saldo awal diisi setelah rekening koran diunggah" };
      return f.opening.needs.length ? { ok: false, text: `Saldo awal ${f.opening.needs.join(", ")} belum dicatat` } : { ok: true, text: "Saldo awal semua perusahaan sudah dicatat" };
    case "approvals":
      return f.approvals ? { ok: false, text: `${f.approvals} usulan menunggu di Kotak persetujuan` } : { ok: true, text: "Kotak persetujuan kosong" };
    case "subledger":
    case "tax": {
      const mine = f.controls.filter((c) => (key === "tax" ? TAX : SUBLEDGER).test(c.key));
      const what = key === "tax" ? "kontrol Pajak Masa" : "rekonsiliasi piutang & utang";
      const open = mine.filter((c) => !clear(c));
      if (!mine.length) return { ok: true, text: `Tidak ada ${what} bulan ini` };
      return open.length ? { ok: false, text: `${open.length} ${what} perlu dicek` } : { ok: true, text: `${mine.length} ${what} lolos atau diberi catatan` };
    }
    case "controls": {
      const fails = f.controls.filter((c) => c.status === "FAIL").length;
      const unacked = f.controls.filter((c) => c.status === "REVIEW" && !c.ack).length;
      if (!fails && !unacked) return { ok: true, text: "Semua kontrol lolos atau diberi catatan" };
      return { ok: false, text: [fails ? `${fails} kontrol gagal` : "", unacked ? `${unacked} kontrol perlu catatan` : ""].filter(Boolean).join(", ") };
    }
    case "lock":
      return f.lockedAt ? { ok: true, text: `Buku ditutup ${formatDateTime(f.lockedAt)}` } : { ok: false, text: "Buku belum ditutup" };
    case "sent":
      if (!f.lockedAt) return { ok: false, text: "Menunggu tutup buku" };
      return f.sentAt ? { ok: true, text: `Laporan diunduh ${formatDateTime(f.sentAt)} setelah tutup buku` } : { ok: false, text: "Belum ada laporan diunduh setelah tutup buku" };
  }
}
