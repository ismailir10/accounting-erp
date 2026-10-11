import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { dataMonths, pickWorkingMonth } from "@/lib/periods";
import { postOpening } from "@/lib/opening";
import { postJournal } from "@/lib/ledger/post";
import { dateOnly } from "@/lib/format";

describe("dataMonths", () => {
  beforeEach(resetDb);

  it("a client whose only books are an opening/Neraca month opens on that month, not on today", async () => {
    const g = await makeGroup();
    await postOpening(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2024, 12, 31), lines: [{ accountCode: "1101", debit: "1.000.000", credit: "" }] });
    const months = await dataMonths([g.client.id]);
    expect(months).toEqual([{ year: 2024, month: 12 }]);
    expect(pickWorkingMonth(months, new Date(Date.UTC(2026, 9, 8)))).toEqual({ year: 2024, month: 12 });
  });

  it("keeps the opening month out of the picker once the client has real activity", async () => {
    const g = await makeGroup();
    await postOpening(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 3, 31), lines: [{ accountCode: "1101", debit: "1.000.000", credit: "" }] });
    const acc = async (code: string) => (await db.account.findFirstOrThrow({ where: { clientId: g.client.id, code } })).id;
    await db.$transaction(async (tx) =>
      postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, 4, 10), kind: "ADJUSTMENT", memo: "Beban", lines: [{ accountId: await acc("6100"), debit: 5n }, { accountId: await acc("2150"), credit: 5n }] }),
    );
    expect(await dataMonths([g.client.id])).toEqual([{ year: 2026, month: 4 }]);
  });

  it("is empty for a client with no entries at all", async () => {
    const g = await makeGroup();
    expect(await dataMonths([g.client.id])).toEqual([]);
  });
});
