import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { addMember } from "../members";
import { postJournal } from "@/lib/ledger/post";
import { CLOSE_SIGNOFFS, lockPeriod, runControls, unlockPeriod, type Control } from "@/lib/controls";
import { createSchedule, postAllDue } from "@/lib/adjust/schedules";
import { recordEvent } from "@/lib/audit";
import { deleteClient } from "@/lib/clients/delete";
import { createFirm } from "@/lib/setup";
import { dateOnly } from "@/lib/format";
import { checklistMonth, checklistRollup, proposeChecklist, unfinishedBeforeLock } from "@/lib/checklist/view";
import { acceptDefault, addTask, markTask, removeTask, setSignoff, updateTask } from "@/lib/checklist/write";
import { ChecklistError } from "@/lib/checklist/rules";

/**
 * Checklist tutup buku (cycle 2026-10-17-checklist-tutup-buku), lib/checklist against Postgres: the template and the month view, the
 * Otomatis proofs, Pemeriksaan akhir = CloseSignoff, the permission rules (each allowed and refused), locked months, Riwayat, deletion.
 */
beforeEach(resetDb);

/** 11 Sep 2026 09.00 WIB: August's tasks due on tanggal 10 are a day late, those due on 12 and 15 are not. */
const NOW = new Date("2026-09-11T02:00:00Z");
type G = Awaited<ReturnType<typeof makeGroup>>;
type Member = Awaited<ReturnType<typeof addMember>>;
const as = (m: Member) => ({ id: m.id, role: m.role });
const AUG = (g: G) => ({ clientId: g.client.id, year: 2026, month: 8 });

async function team() {
  const g = await makeGroup();
  const owner = await addMember(g.firm.id, "OWNER", { name: "Pemilik" });
  const admin = await addMember(g.firm.id, "ADMIN", { name: "Budi" });
  const admin2 = await addMember(g.firm.id, "ADMIN", { name: "Dewi" });
  const rina = await addMember(g.firm.id, "AKUNTAN", { name: "Rina", clients: [g.client.id] });
  const sari = await addMember(g.firm.id, "AKUNTAN", { name: "Sari", clients: [g.client.id] });
  const viewer = await addMember(g.firm.id, "VIEWER", { name: "Vina", clients: [g.client.id] });
  const outsider = await addMember(g.firm.id, "AKUNTAN", { name: "Tono" });
  return { g, owner, admin, admin2, rina, sari, viewer, outsider };
}

const month = (g: G, m = 8, now = NOW) => checklistMonth(db, { clientId: g.client.id, year: 2026, month: m, now });
const row = async (g: G, title: string, m = 8, now = NOW) => (await month(g, m, now)).rows.find((r) => r.title === title)!;
const events = (g: G) => db.auditEvent.findMany({ where: { clientId: g.client.id, kind: "CHECKLIST" }, orderBy: { createdAt: "asc" } });
const refused = (p: Promise<unknown>, message: string | RegExp) => expect(p).rejects.toThrow(message instanceof RegExp ? message : new ChecklistError(message));

async function entry(g: G, m: number) {
  const id = async (code: string) => (await db.account.findFirstOrThrow({ where: { clientId: g.client.id, code } })).id;
  return db.$transaction(async (tx) => postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, m, 10), kind: "ADJUSTMENT", memo: `Uji ${m}`, lines: [{ accountId: await id("1120"), debit: 100_000_000n }, { accountId: await id("4100"), credit: 100_000_000n }] }));
}
/** Every Perlu dicek control noted and the sign-offs given (outside the checklist), then the lock: what Tutup Buku requires. */
async function lock(g: G, m = 8) {
  const period = await db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: m } }, create: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: m }, update: {} });
  for (const s of CLOSE_SIGNOFFS) await db.closeSignoff.upsert({ where: { periodId_key: { periodId: period.id, key: s.key } }, create: { periodId: period.id, key: s.key }, update: {} });
  for (const c of await runControls(db, g.client.id, 2026, m)) {
    if (c.status === "REVIEW") await db.controlAck.upsert({ where: { periodId_controlKey: { periodId: period.id, controlKey: c.key } }, create: { periodId: period.id, controlKey: c.key, note: "Wajar untuk uji" }, update: {} });
  }
  return lockPeriod(db, g.client.id, 2026, m, "uji");
}

describe("the default list and the template", () => {
  it("proposes from what the client uses: Piutang & Utang with its module, Pajak Masa with a masa: control, Saldo awal while needed", async () => {
    const { g } = await team();
    const keys = async (controls: Control[]) => (await proposeChecklist(db, g.client.id, 2026, 8, { controls })).map((l) => l.key);
    expect(await keys([])).toEqual(["sumber", "opening", "approvals", "controls", "docs", "adjust", "review", "lock", "sent"]);
    await db.client.update({ where: { id: g.client.id }, data: { modules: ["receivables"] } });
    const masa: Control = { key: `masa:${g.pt.entity.id}`, title: "Pajak masa", scope: "PT Uji", status: "PASS", detail: "" };
    expect(await keys([masa])).toEqual(["sumber", "opening", "approvals", "subledger", "tax", "controls", "docs", "adjust", "review", "lock", "sent"]);
  });

  it("an admin accepts it from the month on screen; the next month has the same tasks fresh; a month before has none", async () => {
    const { g, admin, rina } = await team();
    expect((await month(g)).hasTemplate).toBe(false);
    expect(await acceptDefault(db, as(admin), { ...AUG(g), assigneeId: rina.id, reviewerId: admin.id })).toBe(9);
    const aug = await month(g);
    expect(aug.hasTemplate).toBe(true);
    expect(aug.rows.map((r) => r.title)).toEqual(["Minta rekening koran dan data", "Saldo awal dicatat", "Review transaksi dan usulan", "Kontrol tutup buku dicek", ...CLOSE_SIGNOFFS.map((s) => s.label), "Tutup buku", "Laporan dikirim ke klien"]);
    // Otomatis tasks are never reviewed; the rest carry the accept dialog's one Pelaksana and Pereviu.
    expect(aug.rows.filter((r) => r.kind === "AUTO").every((r) => r.reviewer === null && r.assignee.name === "Rina")).toBe(true);
    expect(aug.rows.filter((r) => r.kind === "SIGNOFF").map((r) => `${r.assignee.name}/${r.reviewer?.name}/${r.dueDay}`)).toEqual(["Rina/Budi/10", "Rina/Budi/10", "Rina/Budi/12"]);

    await markTask(db, as(rina), { ...AUG(g), taskId: aug.rows.find((r) => r.key === "docs")!.id, step: "done", value: true });
    const sep = await month(g, 9);
    expect(sep.rows.map((r) => r.id)).toEqual(aug.rows.map((r) => r.id));
    expect(sep.rows.every((r) => r.kind === "AUTO" || r.status === "BELUM")).toBe(true);
    expect(sep.rows[0]).toMatchObject({ due: "2026-10-05", dueLabel: "5 Okt 2026" });
    const jul = await month(g, 7);
    expect(jul).toMatchObject({ hasTemplate: true, firstPeriod: 202608, rows: [] });
  });
});

describe("Otomatis tasks", () => {
  it("tick themselves when the proof holds, untick when it stops in an open month, and write nothing", async () => {
    const { g, admin, rina } = await team();
    await acceptDefault(db, as(admin), { ...AUG(g), assigneeId: rina.id, reviewerId: null });
    await entry(g, 8);
    const before = (await events(g)).length;

    // Kotak: an instalment due in August waits; posting it empties Kotak; a new schedule fills it again.
    await createSchedule(db, { clientId: g.client.id, entityId: g.pt.entity.id, kind: "DEPRECIATION", memo: "Penyusutan mesin", debitCode: "6180", creditCode: "1219", amount: "1.200.000", months: 12, startYear: 2026, startMonth: 8 });
    expect((await row(g, "Review transaksi dan usulan")).proof).toMatchObject({ ok: false, text: "1 usulan menunggu di Kotak persetujuan", fix: "Kotak persetujuan" });
    await postAllDue(db, { clientId: g.client.id, year: 2026, month: 8 });
    expect(await row(g, "Review transaksi dan usulan")).toMatchObject({ status: "SELESAI", finished: true, proof: { ok: true, text: "Kotak persetujuan kosong" } });
    await createSchedule(db, { clientId: g.client.id, entityId: g.pt.entity.id, kind: "AMORTIZATION", memo: "Sewa", debitCode: "6120", creditCode: "1170", amount: "120.000", months: 12, startYear: 2026, startMonth: 8 });
    expect(await row(g, "Review transaksi dan usulan")).toMatchObject({ status: "BELUM", finished: false });

    // Sumber: no statement uploaded; Saldo awal: none recorded; controls: Perlu dicek without a note.
    expect((await row(g, "Minta rekening koran dan data")).proof).toMatchObject({ ok: false, text: "Belum ada rekening koran atau file buku untuk bulan ini" });
    expect((await row(g, "Kontrol tutup buku dicek")).proof?.ok).toBe(false);
    expect(await row(g, "Tutup buku")).toMatchObject({ finished: false, proof: { text: "Buku belum ditutup" } });

    // The lock and the report out after it; reopening unticks *Tutup buku* again.
    await postAllDue(db, { clientId: g.client.id, year: 2026, month: 8 });
    await lock(g);
    expect((await row(g, "Kontrol tutup buku dicek")).proof?.ok).toBe(true);
    expect((await row(g, "Tutup buku")).proof).toMatchObject({ ok: true, text: expect.stringMatching(/^Buku ditutup /) });
    expect((await row(g, "Laporan dikirim ke klien")).proof?.text).toBe("Belum ada laporan diunduh setelah tutup buku");
    await recordEvent(db, { clientId: g.client.id, kind: "REPORT_EXPORT", subject: "period:2026-08", summary: "Laporan Agustus 2026 diunduh" });
    expect((await row(g, "Laporan dikirim ke klien")).proof?.text).toMatch(/^Laporan diunduh .* setelah tutup buku$/);
    await unlockPeriod(db, g.client.id, 2026, 8, as(admin), "Koreksi faktur");
    expect(await row(g, "Tutup buku")).toMatchObject({ finished: false, proof: { ok: false } });
    expect(await row(g, "Laporan dikirim ke klien")).toMatchObject({ finished: false, proof: { text: "Menunggu tutup buku" } });

    expect((await events(g)).length).toBe(before); // reading the checklist writes nothing
    await refused(markTask(db, as(admin), { ...AUG(g), taskId: (await row(g, "Tutup buku")).id, step: "done", value: true }), /Tugas otomatis dicentang oleh Buku/);
  });
});

describe("Pemeriksaan akhir = CloseSignoff", () => {
  it("a tick on either page is the same row; a reopened month returns them to Belum and the old review no longer counts", async () => {
    const { g, admin, rina } = await team();
    await acceptDefault(db, as(admin), { ...AUG(g), assigneeId: rina.id, reviewerId: admin.id });
    await entry(g, 8);
    const docs = (await month(g)).rows.find((r) => r.key === "docs")!;
    await markTask(db, as(rina), { ...AUG(g), taskId: docs.id, step: "done", value: true });
    const period = await db.period.findUniqueOrThrow({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 8 } }, include: { signoffs: true } });
    expect(period.signoffs.map((s) => [s.key, s.doneById])).toEqual([["docs", rina.id]]);
    // From Tutup Buku: the same writer, the same rules.
    await setSignoff(db, as(rina), { ...AUG(g), key: "docs", done: false });
    expect(await row(g, docs.title)).toMatchObject({ status: "BELUM" });
    await setSignoff(db, as(rina), { ...AUG(g), key: "adjust", done: true });
    expect(await row(g, CLOSE_SIGNOFFS[1].label)).toMatchObject({ status: "SELESAI", done: { by: "Rina" }, waitsOn: { role: "Pereviu", name: "Budi" } });
    await setSignoff(db, as(rina), { ...AUG(g), key: "docs", done: true });
    await markTask(db, as(admin), { ...AUG(g), taskId: docs.id, step: "review", value: true });
    expect(await row(g, docs.title)).toMatchObject({ status: "DIREVIU", finished: true, review: { by: "Budi" } });

    await setSignoff(db, as(rina), { ...AUG(g), key: "review", done: true });
    await lock(g);
    await refused(setSignoff(db, as(rina), { ...AUG(g), key: "docs", done: false }), "Periode sudah ditutup. Buka kembali dulu untuk mengubah.");
    await unlockPeriod(db, g.client.id, 2026, 8, as(admin), "Koreksi faktur");
    expect((await month(g)).rows.filter((r) => r.kind === "SIGNOFF").map((r) => r.status)).toEqual(["BELUM", "BELUM", "BELUM"]);
    await setSignoff(db, as(rina), { ...AUG(g), key: "docs", done: true });
    expect(await row(g, docs.title)).toMatchObject({ status: "SELESAI", finished: false, waitsOn: { name: "Budi" } });
  });

  it("without a checklist any writer ticks a sign-off as before, and it gains a trace in Riwayat", async () => {
    const { g, sari } = await team();
    await setSignoff(db, as(sari), { ...AUG(g), key: "review", done: true });
    await setSignoff(db, as(sari), { ...AUG(g), key: "review", done: false });
    expect((await events(g)).map((e) => [e.subject, e.summary, e.actorId])).toEqual([
      ["signoff:review", "Laporan keuangan sudah direview partner · Agustus 2026: Belum → Selesai", sari.id],
      ["signoff:review", "Laporan keuangan sudah direview partner · Agustus 2026: Selesai → Belum", sari.id],
    ]);
  });
});

describe("a Manual task: Belum → Selesai → Direviu, and who may do what", () => {
  it("allows the Pelaksana, the Pereviu and an eligible admin; refuses everyone else with a Bahasa message", async () => {
    const { g, owner, admin, admin2, rina, sari } = await team();
    await acceptDefault(db, as(admin), { ...AUG(g), assigneeId: rina.id, reviewerId: null });
    const task = await addTask(db, as(rina), { ...AUG(g), kind: "MANUAL", title: "Kirim draf ke klien", assigneeId: rina.id, reviewerId: admin.id, dueDay: 12 });
    const step = (who: Member, s: "done" | "review", value = true) => markTask(db, as(who), { ...AUG(g), taskId: task.id, step: s, value });

    await refused(step(rina, "review"), "Tandai tugas ini selesai dulu sebelum direviu.");
    await refused(step(sari, "done"), "Hanya Pelaksana tugas ini atau admin kantor yang dapat mengubah status selesainya.");
    await step(rina, "done");
    expect(await row(g, "Kirim draf ke klien")).toMatchObject({ status: "SELESAI", done: { by: "Rina" }, waitsOn: { role: "Pereviu", name: "Budi" } });
    await refused(step(rina, "review"), "Anda yang menandai tugas ini selesai, jadi tidak dapat mereviunya sendiri.");
    await refused(step(sari, "review"), /^Hanya Pereviu tugas ini/);
    await step(admin, "review");
    expect(await row(g, "Kirim draf ke klien")).toMatchObject({ status: "DIREVIU", finished: true, review: { by: "Budi" } });
    await refused(step(rina, "done", false), "Tugas ini sudah direviu. Batalkan reviunya dulu sebelum membatalkan selesai.");
    await step(admin, "review", false);
    await step(rina, "done", false);
    expect(await row(g, "Kirim draf ke klien")).toMatchObject({ status: "BELUM", done: null, review: null });
    expect(await db.checklistMark.count({ where: { taskId: task.id } })).toBe(0); // marks stay sparse

    // An admin covers the tick; the Pereviu (another admin) reviews; an admin who ticked can't review even as Pereviu.
    await step(admin2, "done");
    await refused(step(admin2, "review"), /tidak dapat mereviunya sendiri/);
    await step(admin, "review");
    await step(admin, "review", false);
    await step(admin2, "done", false);
    await step(admin, "done");
    await refused(step(admin, "review"), /tidak dapat mereviunya sendiri/);
    await step(owner, "review"); // an OWNER ranks above the AKUNTAN Pelaksana
    expect(await row(g, "Kirim draf ke klien")).toMatchObject({ status: "DIREVIU", review: { by: "Pemilik" } });
  });

  it("an admin not ranked at least the Pelaksana can't review; without a Pereviu there is no review step", async () => {
    const { g, owner, admin, admin2, rina } = await team();
    await acceptDefault(db, as(admin), { ...AUG(g), assigneeId: rina.id, reviewerId: null });
    const ownersTask = await addTask(db, as(admin), { ...AUG(g), kind: "MANUAL", title: "Tanda tangan surat representasi", assigneeId: owner.id, reviewerId: null, dueDay: 15 });
    await markTask(db, as(owner), { ...AUG(g), taskId: ownersTask.id, step: "done", value: true });
    await refused(markTask(db, as(admin), { ...AUG(g), taskId: ownersTask.id, step: "review", value: true }), "Tugas ini tidak memiliki Pereviu, jadi tidak perlu direviu.");
    expect(await row(g, "Tanda tangan surat representasi")).toMatchObject({ status: "SELESAI", finished: true });
    const adminTask = await addTask(db, as(admin), { ...AUG(g), kind: "MANUAL", title: "Reviu jurnal", assigneeId: admin.id, reviewerId: owner.id, dueDay: 15 });
    await updateTask(db, as(owner), { ...AUG(g), taskId: ownersTask.id, title: "Tanda tangan surat representasi", assigneeId: owner.id, reviewerId: null, dueDay: 15 });
    await markTask(db, as(admin), { ...AUG(g), taskId: adminTask.id, step: "done", value: true });
    // Dewi is an ADMIN, the Pelaksana an ADMIN: equal rank, so she may review in Budi's place; an OWNER task is out of her reach.
    await markTask(db, as(admin2), { ...AUG(g), taskId: adminTask.id, step: "review", value: true });
    const ownerReviewed = await addTask(db, as(owner), { ...AUG(g), kind: "MANUAL", title: "Tutup tahun buku", assigneeId: owner.id, reviewerId: null, dueDay: 15 });
    await updateTask(db, as(owner), { ...AUG(g), taskId: ownerReviewed.id, title: "Tutup tahun buku", assigneeId: owner.id, reviewerId: (await addMember(g.firm.id, "OWNER", { name: "Pemilik 2" })).id, dueDay: 15 });
    await markTask(db, as(owner), { ...AUG(g), taskId: ownerReviewed.id, step: "done", value: true });
    await refused(markTask(db, as(admin2), { ...AUG(g), taskId: ownerReviewed.id, step: "review", value: true }), /^Hanya Pereviu tugas ini, atau admin kantor yang berperan setara atau lebih tinggi/);
  });

  it("checks the people again on every tick: a disabled or unassigned Pelaksana waits for an admin to reassign", async () => {
    const { g, admin, rina, sari } = await team();
    await acceptDefault(db, as(admin), { ...AUG(g), assigneeId: rina.id, reviewerId: sari.id });
    const docs = (await month(g)).rows.find((r) => r.key === "docs")!;
    await db.firmMember.update({ where: { id: rina.id }, data: { disabled: true } });
    expect((await row(g, docs.title)).problem).toBe("Pelaksana Rina tidak lagi memegang klien ini. Admin perlu mengganti Pelaksana.");
    await refused(markTask(db, as(admin), { ...AUG(g), taskId: docs.id, step: "done", value: true }), "Pelaksana Rina tidak lagi memegang klien ini. Admin perlu mengganti Pelaksana.");
    await updateTask(db, as(admin), { ...AUG(g), taskId: docs.id, title: docs.title, assigneeId: sari.id, reviewerId: admin.id, dueDay: 10 });
    await markTask(db, as(sari), { ...AUG(g), taskId: docs.id, step: "done", value: true });
    // The Pereviu unassigned from the client: the review waits for a new one.
    const adjust = (await month(g)).rows.find((r) => r.key === "adjust")!;
    await db.firmMember.update({ where: { id: rina.id }, data: { disabled: false } });
    await markTask(db, as(rina), { ...AUG(g), taskId: adjust.id, step: "done", value: true });
    await db.clientAccess.deleteMany({ where: { memberId: sari.id } });
    await refused(markTask(db, as(sari), { ...AUG(g), taskId: adjust.id, step: "review", value: true }), "Pereviu Sari tidak lagi memegang klien ini. Admin perlu mengganti Pereviu.");
  });
});

describe("assigning: who may hold a task", () => {
  it("refuses a VIEWER, an unassigned AKUNTAN, a disabled member, a Pereviu ranked below the Pelaksana, and the same person", async () => {
    const { g, admin, rina, sari, viewer, outsider } = await team();
    const accept = (assigneeId: string, reviewerId: string | null) => acceptDefault(db, as(admin), { ...AUG(g), assigneeId, reviewerId });
    await refused(accept(rina.id, viewer.id), "Vina berperan Peninjau (hanya melihat), jadi tidak dapat menjadi Pereviu.");
    await refused(accept(viewer.id, null), "Vina berperan Peninjau (hanya melihat), jadi tidak dapat menjadi Pelaksana.");
    await refused(accept(outsider.id, null), "Tono tidak memegang klien ini, jadi tidak dapat menjadi Pelaksana. Tugaskan kliennya dulu di Pengaturan → Tim.");
    await db.firmMember.update({ where: { id: sari.id }, data: { disabled: true } });
    await refused(accept(rina.id, sari.id), "Sari sudah dinonaktifkan, jadi tidak dapat menjadi Pereviu.");
    await refused(accept(admin.id, rina.id), "Rina berperan Akuntan, lebih rendah dari Pelaksana (Admin). Pereviu harus berperan setara atau lebih tinggi.");
    await refused(accept(rina.id, rina.id), "Pereviu harus orang lain, bukan Pelaksana tugas ini.");
    expect(await db.checklistTask.count()).toBe(0);
    await accept(rina.id, admin.id); // allowed: AKUNTAN → ADMIN
    const task = await addTask(db, as(admin), { ...AUG(g), kind: "MANUAL", title: "Peer review", assigneeId: rina.id, reviewerId: (await db.firmMember.update({ where: { id: sari.id }, data: { disabled: false } })).id, dueDay: 9 });
    expect(task.reviewerId).toBe(sari.id); // AKUNTAN → AKUNTAN (staff peer review)
    await refused(updateTask(db, as(admin), { ...AUG(g), taskId: task.id, title: "Peer review", assigneeId: rina.id, reviewerId: viewer.id, dueDay: 9 }), /Peninjau/);
  });

  it("an AKUNTAN adds a Manual task for themselves only; setting up the checklist is admin work (checklist.manage)", async () => {
    const { g, admin, rina, sari } = await team();
    await refused(acceptDefault(db, as(rina), { ...AUG(g), assigneeId: rina.id, reviewerId: null }), "Hanya admin kantor yang dapat mengatur checklist.");
    await refused(addTask(db, as(rina), { ...AUG(g), kind: "MANUAL", title: "Tugas saya", assigneeId: rina.id, reviewerId: null, dueDay: 5 }), "Checklist klien ini belum diatur. Admin kantor memakai daftar usulan Buku dulu.");
    await acceptDefault(db, as(admin), { ...AUG(g), assigneeId: rina.id, reviewerId: null });
    await refused(addTask(db, as(rina), { ...AUG(g), kind: "MANUAL", title: "Untuk Sari", assigneeId: sari.id, reviewerId: null, dueDay: 5 }), /dikerjakan oleh Anda sendiri sebagai Pelaksana/);
    const own = await addTask(db, as(rina), { ...AUG(g), kind: "MANUAL", title: "Tugas saya", assigneeId: rina.id, reviewerId: sari.id, dueDay: 5 });
    await refused(addTask(db, as(rina), { ...AUG(g), kind: "AUTO", key: "tax", assigneeId: rina.id, reviewerId: null, dueDay: 10 }), "Hanya admin kantor yang dapat mengatur checklist.");
    await refused(updateTask(db, as(rina), { ...AUG(g), taskId: own.id, title: "Ganti", assigneeId: rina.id, reviewerId: null, dueDay: 5 }), "Hanya admin kantor yang dapat mengatur checklist.");
    await refused(removeTask(db, as(rina), { ...AUG(g), taskId: own.id }), "Hanya admin kantor yang dapat mengatur checklist.");
    await refused(addTask(db, as(admin), { ...AUG(g), kind: "MANUAL", title: "  ", assigneeId: rina.id, reviewerId: null, dueDay: 5 }), "Tulis nama tugasnya.");
    await refused(addTask(db, as(admin), { ...AUG(g), kind: "MANUAL", title: "Tanggal 29", assigneeId: rina.id, reviewerId: null, dueDay: 29 }), "Tanggal tenggat harus 1–28 (di bulan setelah periode).");
    // An Otomatis kind not in the list can be added by an admin, once.
    const tax = await addTask(db, as(admin), { ...AUG(g), kind: "AUTO", key: "tax", assigneeId: rina.id, reviewerId: admin.id, dueDay: 10 });
    expect(tax).toMatchObject({ title: "Pajak Masa diperiksa", reviewerId: null });
    await refused(addTask(db, as(admin), { ...AUG(g), kind: "AUTO", key: "tax", assigneeId: rina.id, reviewerId: null, dueDay: 10 }), "Tugas otomatis ini sudah ada di checklist bulan ini.");
  });
});

describe("locked months", () => {
  it("Manual ticks and every review still work; Pemeriksaan akhir are frozen; template edits are refused", async () => {
    const { g, admin, rina } = await team();
    await acceptDefault(db, as(admin), { ...AUG(g), assigneeId: rina.id, reviewerId: admin.id });
    const pack = await addTask(db, as(admin), { ...AUG(g), kind: "MANUAL", title: "Unggah ke Coretax", assigneeId: rina.id, reviewerId: admin.id, dueDay: 20 });
    await entry(g, 8);
    await lock(g);
    const docs = (await month(g)).rows.find((r) => r.key === "docs")!;
    await markTask(db, as(rina), { ...AUG(g), taskId: pack.id, step: "done", value: true });
    await markTask(db, as(admin), { ...AUG(g), taskId: pack.id, step: "review", value: true });
    await markTask(db, as(admin), { ...AUG(g), taskId: docs.id, step: "review", value: true }); // a review is not a book write
    expect(await row(g, "Unggah ke Coretax")).toMatchObject({ status: "DIREVIU" });
    await refused(markTask(db, as(rina), { ...AUG(g), taskId: docs.id, step: "done", value: false }), "Periode sudah ditutup. Buka kembali dulu untuk mengubah.");
    const closed = "Buku Agustus 2026 sudah ditutup. Ubah checklist dari bulan yang masih terbuka.";
    await refused(addTask(db, as(admin), { ...AUG(g), kind: "MANUAL", title: "Baru", assigneeId: rina.id, reviewerId: null, dueDay: 5 }), closed);
    await refused(updateTask(db, as(admin), { ...AUG(g), taskId: pack.id, title: "Ganti", assigneeId: rina.id, reviewerId: null, dueDay: 5 }), closed);
    await refused(removeTask(db, as(admin), { ...AUG(g), taskId: pack.id }), closed);
  });
});

describe("the lock warns, it does not block (accounting-rules 23 unchanged)", () => {
  it("counts the unfinished tasks less Tutup buku and Laporan dikirim, and the lock still succeeds when controls and sign-offs allow", async () => {
    const { g, admin, rina } = await team();
    await acceptDefault(db, as(admin), { ...AUG(g), assigneeId: rina.id, reviewerId: admin.id });
    await addTask(db, as(admin), { ...AUG(g), kind: "MANUAL", title: "Kirim paket ke klien", assigneeId: rina.id, reviewerId: admin.id, dueDay: 20 });
    await entry(g, 8);
    const before = await month(g);
    const open = before.rows.filter((r) => !r.finished).length;
    expect(unfinishedBeforeLock(before.rows)).toBe(open - 2);
    expect(unfinishedBeforeLock(before.rows)).toBeGreaterThan(0);
    // The sign-offs are given outside the checklist's review (no review yet), the controls noted: the lock goes through.
    expect((await lock(g)).status).toBe("LOCKED");
    const after = await month(g);
    expect(after.rows.filter((r) => r.kind === "SIGNOFF").map((r) => r.status)).toEqual(["SELESAI", "SELESAI", "SELESAI"]);
    expect(after.rows.find((r) => r.title === "Kirim paket ke klien")).toMatchObject({ status: "BELUM", finished: false });
  });
});

describe("remove = end, not erase", () => {
  it("ends a task before the month on screen (earlier months keep it with their marks); deletes one that never applied before", async () => {
    const { g, admin, rina } = await team();
    await acceptDefault(db, as(admin), { ...AUG(g), assigneeId: rina.id, reviewerId: null });
    const task = await addTask(db, as(admin), { ...AUG(g), kind: "MANUAL", title: "Kirim invoice jasa", assigneeId: rina.id, reviewerId: null, dueDay: 3 });
    await markTask(db, as(rina), { ...AUG(g), taskId: task.id, step: "done", value: true });
    await markTask(db, as(rina), { clientId: g.client.id, year: 2026, month: 9, taskId: task.id, step: "done", value: true });
    await removeTask(db, as(admin), { clientId: g.client.id, year: 2026, month: 9, taskId: task.id });
    expect(await row(g, "Kirim invoice jasa")).toMatchObject({ status: "SELESAI" });
    expect((await month(g, 9)).rows.some((r) => r.id === task.id)).toBe(false);
    expect(await db.checklistMark.count({ where: { taskId: task.id } })).toBe(1);
    expect(await db.checklistTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ endPeriod: 202608 });
    await refused(markTask(db, as(rina), { clientId: g.client.id, year: 2026, month: 9, taskId: task.id, step: "done", value: true }), "Tugas ini tidak berlaku untuk September 2026.");

    const fresh = await addTask(db, as(admin), { clientId: g.client.id, year: 2026, month: 9, kind: "MANUAL", title: "Baru di September", assigneeId: rina.id, reviewerId: null, dueDay: 3 });
    await markTask(db, as(rina), { clientId: g.client.id, year: 2026, month: 9, taskId: fresh.id, step: "done", value: true });
    await removeTask(db, as(admin), { clientId: g.client.id, year: 2026, month: 9, taskId: fresh.id });
    expect([await db.checklistTask.count({ where: { id: fresh.id } }), await db.checklistMark.count({ where: { taskId: fresh.id } })]).toEqual([0, 0]);
    expect((await events(g)).filter((e) => e.subject === `checklist:${fresh.id}`).map((e) => e.summary).at(-1)).toBe("Tugas dihapus: Baru di September (belum pernah berlaku sebelum September 2026)");
  });
});

describe("Lewat tenggat, in WIB", () => {
  it("a task past its due day and not finished is late and names who it waits on; the roll-up counts every month since the template began", async () => {
    const { g, admin, rina } = await team();
    await acceptDefault(db, as(admin), { clientId: g.client.id, year: 2026, month: 7, assigneeId: rina.id, reviewerId: admin.id });
    const manual = await addTask(db, as(admin), { clientId: g.client.id, year: 2026, month: 7, kind: "MANUAL", title: "Minta faktur pajak", assigneeId: rina.id, reviewerId: admin.id, dueDay: 10 });
    // 10 Sep 23.00 WIB: August's tanggal 10 is today, not late yet; 11 Sep 00.30 WIB it is a day late.
    expect(await row(g, "Minta faktur pajak", 8, new Date("2026-09-10T16:00:00Z"))).toMatchObject({ overdue: false, daysLate: 0, due: "2026-09-10" });
    expect(await row(g, "Minta faktur pajak", 8, new Date("2026-09-10T17:30:00Z"))).toMatchObject({ overdue: true, daysLate: 1, waitsOn: { role: "Pelaksana", name: "Rina" } });
    await markTask(db, as(rina), { ...AUG(g), taskId: manual.id, step: "done", value: true });
    expect(await row(g, "Minta faktur pajak")).toMatchObject({ overdue: true, waitsOn: { role: "Pereviu", name: "Budi" } });
    await markTask(db, as(admin), { ...AUG(g), taskId: manual.id, step: "review", value: true });
    expect(await row(g, "Minta faktur pajak")).toMatchObject({ overdue: false, finished: true });

    const aug = await month(g);
    const up = await checklistRollup(db, { ...AUG(g), now: NOW });
    // July (open, everything due in August) is the earliest month with a late task; August's tanggal-10 tasks are late too.
    const jul = await month(g, 7);
    expect(up).toMatchObject({ hasTemplate: true, total: aug.counts.total, finished: aug.counts.finished, earliest: { year: 2026, month: 7 } });
    expect(up.overdue).toBe(jul.counts.overdue + aug.counts.overdue);
    expect(up.waitsOn).toEqual(["Rina"]);
    // Before the template began, and without one, there is nothing to count.
    expect(await checklistRollup(db, { clientId: g.client.id, year: 2026, month: 6, now: NOW })).toMatchObject({ hasTemplate: true, total: 0, overdue: 0, earliest: null });
  });
});

describe("Riwayat perubahan: one CHECKLIST event per write, with before → after", () => {
  it("records accepting, adding, every template change, every tick, untick, review and undo, and removing", async () => {
    const { g, admin, rina, sari } = await team();
    await acceptDefault(db, as(admin), { ...AUG(g), assigneeId: rina.id, reviewerId: admin.id });
    const task = await addTask(db, as(admin), { ...AUG(g), kind: "MANUAL", title: "Draf CALK", assigneeId: rina.id, reviewerId: admin.id, dueDay: 10 });
    await updateTask(db, as(admin), { ...AUG(g), taskId: task.id, title: "Draf CALK final", assigneeId: sari.id, reviewerId: admin.id, dueDay: 12 });
    await updateTask(db, as(admin), { ...AUG(g), taskId: task.id, title: "Draf CALK final", assigneeId: sari.id, reviewerId: admin.id, dueDay: 12 }); // no change, no event
    await markTask(db, as(sari), { ...AUG(g), taskId: task.id, step: "done", value: true });
    await markTask(db, as(admin), { ...AUG(g), taskId: task.id, step: "review", value: true });
    await markTask(db, as(admin), { ...AUG(g), taskId: task.id, step: "review", value: false });
    await markTask(db, as(sari), { ...AUG(g), taskId: task.id, step: "done", value: false });
    await removeTask(db, as(admin), { ...AUG(g), taskId: task.id });
    const log = await events(g);
    expect(log.map((e) => [e.summary, e.actorId])).toEqual([
      ["Checklist dipakai mulai Agustus 2026: 9 tugas · Pelaksana Rina · Pereviu Budi", admin.id],
      ["Tugas ditambahkan mulai Agustus 2026: Draf CALK · Pelaksana Rina · Pereviu Budi · tanggal 10", admin.id],
      ["Draf CALK: Nama \"Draf CALK\" → \"Draf CALK final\"; Pelaksana Rina → Sari; Tenggat tanggal 10 → 12", admin.id],
      ["Draf CALK final · Agustus 2026: Belum → Selesai", sari.id],
      ["Draf CALK final · Agustus 2026: Selesai → Direviu", admin.id],
      ["Draf CALK final · Agustus 2026: Direviu → Selesai", admin.id],
      ["Draf CALK final · Agustus 2026: Selesai → Belum", sari.id],
      ["Tugas dihapus: Draf CALK final (belum pernah berlaku sebelum Agustus 2026)", admin.id],
    ]);
    expect(log[2]).toMatchObject({ before: { title: "Draf CALK", assignee: "Rina", reviewer: "Budi", dueDay: 10 }, after: { title: "Draf CALK final", assignee: "Sari", reviewer: "Budi", dueDay: 12 } });
    expect(log[3]).toMatchObject({ before: { status: "Belum" }, after: { status: "Selesai" } });
    expect(new Set(log.map((e) => e.kind))).toEqual(new Set(["CHECKLIST"]));
    // The checklist reads the books and writes no journal: no number on a report moves.
    expect([await db.journalEntry.count(), await db.journalLine.count()]).toEqual([0, 0]);
  });
});

describe("tenancy and deletion", () => {
  it("another client's (or organisation's) task reads as not found", async () => {
    const { g, admin, rina } = await team();
    await acceptDefault(db, as(admin), { ...AUG(g), assigneeId: rina.id, reviewerId: null });
    const foreign = await makeGroup();
    const boss = await addMember(foreign.firm.id, "OWNER", { name: "Bos lain" });
    await acceptDefault(db, as(boss), { clientId: foreign.client.id, year: 2026, month: 8, assigneeId: boss.id, reviewerId: null });
    const theirs = (await checklistMonth(db, { clientId: foreign.client.id, year: 2026, month: 8, now: NOW })).rows.find((r) => r.key === "docs")!;
    await refused(markTask(db, as(admin), { ...AUG(g), taskId: theirs.id, step: "done", value: true }), "Tugas tidak ditemukan.");
    await refused(updateTask(db, as(admin), { ...AUG(g), taskId: theirs.id, title: "x", assigneeId: rina.id, reviewerId: null, dueDay: 5 }), "Tugas tidak ditemukan.");
    await refused(removeTask(db, as(admin), { ...AUG(g), taskId: theirs.id }), "Tugas tidak ditemukan.");
    // A member of another organisation can't be assigned here.
    await refused(addTask(db, as(admin), { ...AUG(g), kind: "MANUAL", title: "x", assigneeId: boss.id, reviewerId: null, dueDay: 5 }), "Pelaksana tidak ditemukan di tim kantor ini.");
    expect(await db.checklistMark.count({ where: { taskId: theirs.id } })).toBe(0);
  });

  it("deleting a client removes its template and marks, and nothing of another client (accounting-rules 25)", async () => {
    const { g, admin, rina } = await team();
    await acceptDefault(db, as(admin), { ...AUG(g), assigneeId: rina.id, reviewerId: admin.id });
    const docs = (await month(g)).rows.find((r) => r.key === "docs")!;
    await markTask(db, as(rina), { ...AUG(g), taskId: docs.id, step: "done", value: true });
    await markTask(db, as(admin), { ...AUG(g), taskId: docs.id, step: "review", value: true });
    const other = await db.$transaction((tx) => createFirm(tx, "KAP Lain"));
    const keep = await makeGroup();
    const boss = await addMember(keep.firm.id, "OWNER", { name: "Bos" });
    await acceptDefault(db, as(boss), { clientId: keep.client.id, year: 2026, month: 8, assigneeId: boss.id, reviewerId: null });
    expect(other.id).toBeTruthy();
    await deleteClient(db, { firmId: g.firm.id, clientId: g.client.id, confirmName: "Grup Uji" });
    expect(await db.checklistTask.count({ where: { clientId: g.client.id } })).toBe(0);
    expect(await db.checklistMark.count({ where: { taskId: docs.id } })).toBe(0);
    expect(await db.checklistTask.count({ where: { clientId: keep.client.id } })).toBe(9);
  });
});
