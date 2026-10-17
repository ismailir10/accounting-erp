import { describe, expect, it } from "vitest";
import { assignmentProblem, daysLate, dueDate, holderProblem, humanStatus, pairProblem, previousPeriod, nextPeriod, reviewCounts, reviewProblem, tickProblem, todayWib, validDueDay, type Person } from "@/lib/checklist/rules";
import { AUTO_KINDS, prove, type ChecklistFacts } from "@/lib/checklist/proofs";
import { defaultLines } from "@/lib/checklist/view";
import type { Control } from "@/lib/controls";

// Checklist tutup buku (cycle 2026-10-17-checklist-tutup-buku): the pure rules.
const iso = (d: Date) => d.toISOString().slice(0, 10);
const person = (id: string, role: Person["role"], extra: Partial<Person> = {}): Person => ({ id, name: id, role, disabled: false, canOpen: true, ...extra });

describe("due date and overdue", () => {
  it("is the due day of the month after the period, December into January, capped at 28", () => {
    expect(iso(dueDate(2026, 8, 10))).toBe("2026-09-10");
    expect(iso(dueDate(2026, 12, 5))).toBe("2027-01-05");
    expect(iso(dueDate(2026, 1, 28))).toBe("2026-02-28");
    expect(iso(dueDate(2026, 1, 31))).toBe("2026-02-28");
    expect([0, 1, 28, 29, 2.5].map(validDueDay)).toEqual([false, true, true, false, false]);
  });

  it("reads today in WIB: 17:00 UTC is already the next day in Jakarta", () => {
    expect(iso(todayWib(new Date("2026-09-10T16:59:00Z")))).toBe("2026-09-10");
    expect(iso(todayWib(new Date("2026-09-10T17:00:00Z")))).toBe("2026-09-11");
  });

  it("counts days late from the day after the due date", () => {
    const due = dueDate(2026, 8, 10);
    expect(daysLate(due, todayWib(new Date("2026-09-10T05:00:00Z")))).toBe(0);
    expect(daysLate(due, todayWib(new Date("2026-09-13T05:00:00Z")))).toBe(3);
  });

  it("steps months across the year end", () => {
    expect([previousPeriod(202601), previousPeriod(202608), nextPeriod(202612), nextPeriod(202608)]).toEqual([202512, 202607, 202701, 202609]);
  });
});

describe("who may hold a task (Pelaksana, Pereviu)", () => {
  it("refuses a VIEWER, a disabled member and an unassigned AKUNTAN", () => {
    expect(holderProblem(person("v", "VIEWER"), "Pereviu")).toMatch(/Peninjau \(hanya melihat\), jadi tidak dapat menjadi Pereviu/);
    expect(holderProblem(person("d", "AKUNTAN", { disabled: true }), "Pelaksana")).toMatch(/dinonaktifkan/);
    expect(holderProblem(person("u", "AKUNTAN", { canOpen: false }), "Pelaksana")).toMatch(/tidak memegang klien ini/);
    expect(holderProblem(undefined, "Pelaksana")).toMatch(/tidak ditemukan/);
    expect(holderProblem(person("a", "AKUNTAN"), "Pelaksana")).toBeNull();
  });

  it("the Pereviu ranks equal or higher and is another person (OWNER > ADMIN > AKUNTAN)", () => {
    const [owner, admin, akuntan, akuntan2] = [person("o", "OWNER"), person("a", "ADMIN"), person("k", "AKUNTAN"), person("k2", "AKUNTAN")];
    expect(pairProblem(akuntan, akuntan2)).toBeNull(); // staff peer review
    expect(pairProblem(akuntan, admin)).toBeNull();
    expect(pairProblem(admin, owner)).toBeNull();
    expect(pairProblem(admin, admin)).toMatch(/orang lain/);
    expect(pairProblem(admin, akuntan)).toMatch(/lebih rendah dari Pelaksana \(Admin\)/);
    expect(pairProblem(owner, admin)).toMatch(/lebih rendah/);
    expect(pairProblem(akuntan, null)).toBeNull();
    expect(assignmentProblem(akuntan, person("v", "VIEWER"))).toMatch(/Peninjau/);
    expect(assignmentProblem(akuntan, undefined)).toMatch(/Pereviu tidak ditemukan/);
  });
});

describe("who may tick and review", () => {
  const task = { assigneeId: "k", reviewerId: "a", assigneeRole: "AKUNTAN" as const };
  it("Selesai: the Pelaksana or an admin covering, never another AKUNTAN", () => {
    expect(tickProblem({ id: "k", role: "AKUNTAN" }, task)).toBeNull();
    expect(tickProblem({ id: "x", role: "ADMIN" }, task)).toBeNull();
    expect(tickProblem({ id: "x", role: "OWNER" }, task)).toBeNull();
    expect(tickProblem({ id: "k2", role: "AKUNTAN" }, task)).toMatch(/Hanya Pelaksana tugas ini atau admin kantor/);
  });

  it("Direviu: the Pereviu or an admin ranked ≥ the Pelaksana; never whoever ticked; no Pereviu, no review", () => {
    expect(reviewProblem({ id: "a", role: "ADMIN" }, task, "k")).toBeNull();
    expect(reviewProblem({ id: "o", role: "OWNER" }, task, "k")).toBeNull();
    expect(reviewProblem({ id: "k2", role: "AKUNTAN" }, task, "k")).toMatch(/Hanya Pereviu tugas ini/);
    // an admin who ticked for the Pelaksana can't review their own tick, even as the Pereviu
    expect(reviewProblem({ id: "a", role: "ADMIN" }, task, "a")).toMatch(/tidak dapat mereviunya sendiri/);
    expect(reviewProblem({ id: "a2", role: "ADMIN" }, { ...task, assigneeRole: "OWNER" }, "k")).toMatch(/setara atau lebih tinggi/);
    expect(reviewProblem({ id: "a", role: "ADMIN" }, { ...task, reviewerId: null }, "k")).toMatch(/tidak memiliki Pereviu/);
  });
});

describe("statuses: Belum · Selesai · Direviu", () => {
  const t1 = new Date("2026-09-09T06:10:00Z"), t2 = new Date("2026-09-11T01:02:00Z");
  const done = { at: t1, byId: "k", by: "Rina" }, review = { at: t2, byId: "a", by: "Budi" };
  it("finished = Direviu with a Pereviu, Selesai without; waits on the Pelaksana, then the Pereviu", () => {
    expect(humanStatus(null, null, true)).toMatchObject({ status: "BELUM", finished: false, waitsOn: "Pelaksana" });
    expect(humanStatus(done, null, true)).toMatchObject({ status: "SELESAI", finished: false, waitsOn: "Pereviu" });
    expect(humanStatus(done, null, false)).toMatchObject({ status: "SELESAI", finished: true, waitsOn: null });
    expect(humanStatus(done, review, true)).toMatchObject({ status: "DIREVIU", finished: true, waitsOn: null });
  });
  it("a review counts only while Selesai and later than the tick", () => {
    expect(reviewCounts(done, review)).toBe(true);
    expect(reviewCounts({ ...done, at: new Date(+t2 + 1) }, review)).toBe(false); // retick after the review asks again
    expect(reviewCounts(null, review)).toBe(false);
    expect(humanStatus({ ...done, at: new Date(+t2 + 1) }, review, true)).toMatchObject({ status: "SELESAI", waitsOn: "Pereviu" });
  });
});

describe("Otomatis proofs, each true and false", () => {
  const c = (key: string, status: Control["status"], ack?: string): Control => ({ key, title: key, scope: "PT", status, detail: "", ack: ack ?? null });
  const base: ChecklistFacts = { controls: [], sumber: { rows: 2, gaps: 0 }, approvals: 0, opening: { needs: [], hasData: true }, lockedAt: null, sentAt: null };
  const p = (key: Parameters<typeof prove>[0], f: Partial<ChecklistFacts> = {}) => prove(key, { ...base, ...f }, "Agustus 2026");

  it("Sumber: no gap", () => {
    expect(p("sumber")).toEqual({ ok: true, text: "Semua rekening koran Agustus 2026 lengkap" });
    expect(p("sumber", { sumber: { rows: 2, gaps: 1 } })).toEqual({ ok: false, text: "Ada celah: 1 rekening Agustus 2026 belum lengkap" });
    expect(p("sumber", { sumber: { rows: 0, gaps: 0 } }).ok).toBe(false);
  });
  it("Saldo awal: no company still needs one", () => {
    expect(p("opening").ok).toBe(true);
    expect(p("opening", { opening: { needs: ["PT Uji"], hasData: true } })).toEqual({ ok: false, text: "Saldo awal PT Uji belum dicatat" });
    expect(p("opening", { opening: { needs: [], hasData: false } }).ok).toBe(false);
  });
  it("Kotak persetujuan empty", () => {
    expect(p("approvals")).toEqual({ ok: true, text: "Kotak persetujuan kosong" });
    expect(p("approvals", { approvals: 3 })).toEqual({ ok: false, text: "3 usulan menunggu di Kotak persetujuan" });
  });
  it("Piutang & utang and Pajak Masa: their controls PASS or noted", () => {
    expect(p("subledger", { controls: [c("ar:1", "PASS"), c("ap:1", "REVIEW", "wajar")] }).ok).toBe(true);
    expect(p("subledger", { controls: [c("subledger:1", "REVIEW")] })).toEqual({ ok: false, text: "1 rekonsiliasi piutang & utang perlu dicek" });
    expect(p("subledger", { controls: [c("masa:1", "REVIEW")] }).ok).toBe(true); // not its kind
    expect(p("tax", { controls: [c("masa:1", "PASS"), c("faktur:1", "REVIEW", "ok"), c("bupot:1", "PASS")] }).ok).toBe(true);
    expect(p("tax", { controls: [c("bupot:1", "FAIL", "noted")] }).ok).toBe(false); // a FAIL never clears
  });
  it("Kontrol: no FAIL, every REVIEW noted", () => {
    expect(p("controls", { controls: [c("tb:1", "PASS"), c("suspense", "REVIEW", "ok")] }).ok).toBe(true);
    expect(p("controls", { controls: [c("tb:1", "FAIL"), c("suspense", "REVIEW")] })).toEqual({ ok: false, text: "1 kontrol gagal, 1 kontrol perlu catatan" });
  });
  it("Tutup buku: the month locked; Laporan dikirim: says what Buku can prove (a download after the lock)", () => {
    const lockedAt = new Date("2026-09-14T03:00:00Z"), sentAt = new Date("2026-09-15T02:30:00Z");
    expect(p("lock").ok).toBe(false);
    expect(p("lock", { lockedAt })).toEqual({ ok: true, text: "Buku ditutup 14 Sep 2026 10.00" });
    expect(p("sent", { lockedAt })).toEqual({ ok: false, text: "Belum ada laporan diunduh setelah tutup buku" });
    expect(p("sent", { lockedAt, sentAt })).toEqual({ ok: true, text: "Laporan diunduh 15 Sep 2026 09.30 setelah tutup buku" });
    expect(p("sent").text).toBe("Menunggu tutup buku");
  });
  it("names every kind of the spec", () => {
    expect(AUTO_KINDS.map((k) => k.label)).toEqual(["Rekening koran dan data bulan ini lengkap", "Saldo awal dicatat", "Review transaksi dan usulan", "Rekonsiliasi piutang & utang", "Pajak Masa diperiksa", "Kontrol tutup buku dicek", "Tutup buku", "Laporan dikirim ke klien"]);
  });
});

describe("the default list", () => {
  const keys = (f: Parameters<typeof defaultLines>[0]) => defaultLines(f).map((l) => `${l.key}:${l.dueDay}`);
  it("adds Piutang & Utang only with its module, Pajak Masa only with a masa: control, Saldo awal only while needed", () => {
    expect(keys({ receivables: false, masa: false, opening: { needs: [], hasData: true } })).toEqual(["sumber:5", "approvals:8", "controls:10", "docs:10", "adjust:10", "review:12", "lock:15", "sent:15"]);
    expect(keys({ receivables: true, masa: true, opening: { needs: ["PT Uji"], hasData: true } })).toEqual(["sumber:5", "opening:10", "approvals:8", "subledger:10", "tax:10", "controls:10", "docs:10", "adjust:10", "review:12", "lock:15", "sent:15"]);
  });
  it("each line has its kind and reason", () => {
    const lines = defaultLines({ receivables: true, masa: false, opening: { needs: ["PT Uji"], hasData: true } });
    expect(lines.find((l) => l.key === "sumber")).toMatchObject({ kind: "AUTO", title: "Minta rekening koran dan data" });
    expect(lines.find((l) => l.key === "opening")?.reason).toBe("PT Uji belum punya saldo awal.");
    expect(lines.find((l) => l.key === "subledger")?.reason).toBe("Modul Piutang & Utang dipakai klien ini.");
    expect(lines.filter((l) => l.kind === "SIGNOFF").map((l) => l.title)).toEqual(["Bukti pendukung transaksi besar sudah diperiksa", "Jurnal penyesuaian (penyusutan, akrual) sudah dicatat", "Laporan keuangan sudah direview partner"]);
    expect(lines.every((l) => l.reason.length > 10)).toBe(true);
  });
});
