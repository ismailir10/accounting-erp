import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { createDimension, listDimensions, removeDimension, renameDimension, setDimensionArchived, dimensionOptions } from "@/lib/dimensions";
import { postJournal } from "@/lib/ledger/post";
import { deleteClient } from "@/lib/clients/delete";
import { listEvents } from "@/lib/audit";
import { dateOnly } from "@/lib/format";
import { addMember } from "../members";
import { postAdjustment } from "@/lib/ledger/adjustment";
import { reverseEntry } from "@/lib/ledger/reverse";
import { approveJournal, submitAdjustment, submitReversal } from "@/lib/approvals/journals";
import { saveApprovals } from "@/lib/settings/approvals";
import { createRecurring } from "@/lib/adjust/recurring";
import { postRecurring } from "@/lib/adjust/recurring-post";
import { approvalQueue } from "@/lib/approvals/queue";

/** Departemen & Proyek (cycle 2026-10-21-departemen-proyek): a client's labels on a journal line; never a balance. */
describe("departemen & proyek", () => {
  beforeEach(resetDb);

  type G = Awaited<ReturnType<typeof makeGroup>>;
  const acc = (g: G, code: string) => db.account.findFirstOrThrow({ where: { clientId: g.client.id, code } });
  const post = async (g: G, tags: { departmentId?: string | null; projectId?: string | null }, month = 8) => {
    const [exp, cash] = [await acc(g, "6120"), await acc(g, "1110")];
    return db.$transaction((tx) =>
      postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, month, 5), kind: "ADJUSTMENT", memo: "Sewa outlet", lines: [{ accountId: exp.id, debit: 2_000_000n, ...tags }, { accountId: cash.id, credit: 2_000_000n }] }),
    );
  };

  it("sets up, tags a line, archives, refuses an archived one on a new line and keeps history", async () => {
    const g = await makeGroup();
    const a = await createDimension(db, { clientId: g.client.id, kind: "DEPARTEMEN", code: " outlet-a ", name: "Outlet  Kemang" });
    expect([a.code, a.name]).toEqual(["OUTLET-A", "Outlet Kemang"]);
    const p = await createDimension(db, { clientId: g.client.id, kind: "PROYEK", code: "PRJ-01", name: "Gedung Bekasi" });
    await expect(createDimension(db, { clientId: g.client.id, kind: "DEPARTEMEN", code: "OUTLET-A", name: "Lain" })).rejects.toThrow("Kode OUTLET-A sudah dipakai departemen lain.");
    // The same code may be a project and a department.
    await createDimension(db, { clientId: g.client.id, kind: "PROYEK", code: "OUTLET-A", name: "Renovasi Outlet A" });
    await expect(createDimension(db, { clientId: g.client.id, kind: "DEPARTEMEN", code: "a b c d e f g h i j k l m", name: "x y" })).rejects.toThrow("Kode 1–12");
    await expect(createDimension(db, { clientId: g.client.id, kind: "CABANG", code: "X", name: "Cabang" })).rejects.toThrow("Pilih departemen atau proyek.");

    const e = await post(g, { departmentId: a.id, projectId: p.id });
    const line = await db.journalLine.findFirstOrThrow({ where: { entryId: e.id, debit: { gt: 0n } } });
    expect([line.departmentId, line.projectId]).toEqual([a.id, p.id]);
    // Wrong kind is refused.
    await expect(post(g, { departmentId: p.id })).rejects.toThrow("Departemen tidak termasuk klien ini.");

    await renameDimension(db, { clientId: g.client.id, id: a.id, name: "Outlet Kemang Raya" });
    await setDimensionArchived(db, { clientId: g.client.id, id: a.id, archived: true });
    expect((await dimensionOptions(db, g.client.id)).departments).toEqual([]);
    await expect(post(g, { departmentId: a.id })).rejects.toThrow("Departemen OUTLET-A Outlet Kemang Raya sudah diarsipkan.");
    const listed = await listDimensions(db, g.client.id);
    expect(listed.find((d) => d.id === a.id)).toMatchObject({ archived: true, lines: 1 });
    await expect(removeDimension(db, { clientId: g.client.id, id: a.id })).rejects.toThrow("sudah dipakai");

    await setDimensionArchived(db, { clientId: g.client.id, id: a.id, archived: false });
    await post(g, { departmentId: a.id });
    expect((await listEvents(db, g.client.id, { kind: "DIMENSION" })).map((x) => x.summary)).toEqual(
      expect.arrayContaining([
        "Departemen OUTLET-A Outlet Kemang ditambahkan",
        "Departemen OUTLET-A Outlet Kemang diubah menjadi Outlet Kemang Raya",
        "Departemen OUTLET-A Outlet Kemang Raya diarsipkan",
        "Departemen OUTLET-A Outlet Kemang Raya diaktifkan lagi",
      ]),
    );
  });

  it("refuses another client's dimension, removes an unused one and a waiting template's one stays", async () => {
    const g = await makeGroup();
    const other = await makeGroup();
    const theirs = await createDimension(db, { clientId: other.client.id, kind: "DEPARTEMEN", code: "HQ", name: "Kantor pusat" });
    await expect(post(g, { departmentId: theirs.id })).rejects.toThrow("Departemen tidak termasuk klien ini.");
    await expect(renameDimension(db, { clientId: g.client.id, id: theirs.id, name: "Diambil" })).rejects.toThrow("tidak ditemukan");

    const unused = await createDimension(db, { clientId: g.client.id, kind: "PROYEK", code: "P2", name: "Proyek kedua" });
    await removeDimension(db, { clientId: g.client.id, id: unused.id });
    expect(await db.dimension.count({ where: { clientId: g.client.id } })).toBe(0);

    const kept = await createDimension(db, { clientId: g.client.id, kind: "PROYEK", code: "P3", name: "Proyek ketiga" });
    await db.recurringJournal.create({
      data: { firmId: g.firm.id, clientId: g.client.id, entityId: g.pt.entity.id, memo: "Sewa", day: 1, startYear: 2026, startMonth: 8, lines: [{ accountCode: "6120", debit: "1", credit: "", projectId: kept.id }] },
    });
    await expect(removeDimension(db, { clientId: g.client.id, id: kept.id })).rejects.toThrow("sudah dipakai");
  });

  it("deleting the client removes its dimensions with the lines that carry them", async () => {
    const g = await makeGroup();
    const a = await createDimension(db, { clientId: g.client.id, kind: "DEPARTEMEN", code: "A", name: "Outlet A" });
    await post(g, { departmentId: a.id });
    await deleteClient(db, { firmId: g.firm.id, clientId: g.client.id, confirmName: "Grup Uji" });
    expect(await db.dimension.count()).toBe(0);
  });

  describe("on Jurnal Penyesuaian", () => {
    type Tags = { departmentId: string | null; projectId: string | null };
    const tagsOf = async (entryId: string) =>
      (await db.journalLine.findMany({ where: { entryId }, include: { account: true }, orderBy: [{ debit: "desc" }, { credit: "desc" }] })).map((l): [string, Tags] => [l.account.code, { departmentId: l.departmentId, projectId: l.projectId }]);
    const setup = async () => {
      const g = await makeGroup();
      const a = await createDimension(db, { clientId: g.client.id, kind: "DEPARTEMEN", code: "OUTLET-A", name: "Outlet A" });
      const p = await createDimension(db, { clientId: g.client.id, kind: "PROYEK", code: "PRJ-01", name: "Proyek satu" });
      const lines = [
        { accountCode: "6120", debit: "15.000.000", credit: "", departmentId: a.id, projectId: p.id },
        { accountCode: "6190", debit: "2.500.000", credit: "", departmentId: a.id },
        { accountCode: "2150", debit: "", credit: "17.500.000" },
      ];
      return { g, a, p, lines, input: { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 7, 31), memo: "Akrual sewa outlet", lines } };
    };

    it("keeps each line's tags, mirrors them on Balik otomatis and on Balik jurnal (even once archived)", async () => {
      const { g, a, p, input } = await setup();
      const e = await postAdjustment(db, { ...input, reverseNextMonth: true });
      const want: [string, Tags][] = [["6120", { departmentId: a.id, projectId: p.id }], ["6190", { departmentId: a.id, projectId: null }], ["2150", { departmentId: null, projectId: null }]];
      expect(await tagsOf(e.id)).toEqual(want);
      const rev = await db.journalEntry.findUniqueOrThrow({ where: { reversesId: e.id } });
      expect((await tagsOf(rev.id)).map(([c, t]) => [c, t]).sort()).toEqual([...want].sort());

      const plain = await postAdjustment(db, { ...input, date: dateOnly(2026, 8, 31) });
      await setDimensionArchived(db, { clientId: g.client.id, id: a.id, archived: true });
      await expect(postAdjustment(db, { ...input, date: dateOnly(2026, 8, 31) })).rejects.toThrow("sudah diarsipkan");
      const r = await reverseEntry(db, { clientId: g.client.id, entryId: plain.id, date: dateOnly(2026, 9, 1) });
      expect((await tagsOf(r.id)).find(([c]) => c === "6120")?.[1]).toEqual({ departmentId: a.id, projectId: p.id });
    });

    it("a request waiting for a second approver stores the tags, shows them, and posts them on approval; a reversal request too", async () => {
      const { g, a, p, input } = await setup();
      const maker = await addMember(g.firm.id, "AKUNTAN", { name: "Andi", clients: [g.client.id] });
      const checker = await addMember(g.firm.id, "AKUNTAN", { name: "Budi", clients: [g.client.id] });
      await saveApprovals(db, { firmId: g.firm.id, settings: { manual: true, manualAbove: "", aiDraft: false, aiDraftAbove: "", reopen: false } });
      const o = await submitAdjustment(db, { ...input, maker: { id: maker.id, role: "AKUNTAN" } });
      expect(o.posted).toBe(false);
      const q = await approvalQueue(db, { clientId: g.client.id, year: 2026, month: 7 });
      const card = q.second.find((j) => j.type === "journal" && j.memo === "Akrual sewa outlet");
      expect(card?.type === "journal" && card.lines.map((l) => l.tags)).toEqual(["OUTLET-A · PRJ-01", "OUTLET-A", null]);
      const e = await approveJournal(db, { clientId: g.client.id, approvalId: o.posted ? "" : o.approvalId, approver: { id: checker.id, role: "AKUNTAN" } });
      expect((await tagsOf(e.id)).find(([c]) => c === "6120")?.[1]).toEqual({ departmentId: a.id, projectId: p.id });

      const r = await submitReversal(db, { clientId: g.client.id, entryId: e.id, date: dateOnly(2026, 8, 5), maker: { id: maker.id, role: "AKUNTAN" } });
      const re = await approveJournal(db, { clientId: g.client.id, approvalId: r.posted ? "" : r.approvalId, approver: { id: checker.id, role: "AKUNTAN" } });
      const t = await tagsOf(re.id);
      expect(t.find(([c]) => c === "6120")?.[1]).toEqual({ departmentId: a.id, projectId: p.id });
    });

    it("Jurnal berulang repeats the tags", async () => {
      const { g, a, p, input } = await setup();
      const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
      const july = await postAdjustment(db, { ...input, actorId: me.id });
      const t = await createRecurring(db, { clientId: g.client.id, entryId: july.id, actorId: me.id });
      await expect(removeDimension(db, { clientId: g.client.id, id: p.id })).rejects.toThrow("sudah dipakai");
      const o = await postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 8, maker: { id: me.id, role: "AKUNTAN" } });
      expect((await tagsOf(o.posted ? o.entryId : "")).find(([c]) => c === "6120")?.[1]).toEqual({ departmentId: a.id, projectId: p.id });
    });
  });
});
