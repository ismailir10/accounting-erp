import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { postJournal } from "@/lib/ledger/post";
import { accountUsage, createAccount, moveTargets, proposedCode, protection, removeAccount, updateAccount } from "@/lib/coa/manage";
import { incomeStatement } from "@/lib/reports/ledger";
import { periodBounds, dateOnly } from "@/lib/format";

const account = (clientId: string, code: string) => db.account.findUniqueOrThrow({ where: { clientId_code: { clientId, code } } });

describe("chart of accounts (Bagan akun)", () => {
  beforeEach(resetDb);

  it("adds an account under a report line with the proposed code, or a typed one; bumps the chart version; records Riwayat", async () => {
    const g = await makeGroup();
    const before = (await db.client.findUniqueOrThrow({ where: { id: g.client.id } })).coaVersion;
    expect(await proposedCode(db, g.client.id, "BEBAN_UMUM_ADM")).toBe("6191");
    const a = await createAccount(db, { clientId: g.client.id, fsLine: "BEBAN_UMUM_ADM", name: "  Beban Sewa  Kendaraan " });
    expect([a.code, a.name, a.type, a.normalBalance, a.fsLine]).toEqual(["6191", "Beban Sewa Kendaraan", "BEBAN", "DEBIT", "BEBAN_UMUM_ADM"]);
    const b = await createAccount(db, { clientId: g.client.id, fsLine: "PENDAPATAN_USAHA", name: "Pendapatan Jasa Medis", code: "4150" });
    expect([b.code, b.type, b.normalBalance]).toEqual(["4150", "PENDAPATAN", "CREDIT"]);
    expect((await db.client.findUniqueOrThrow({ where: { id: g.client.id } })).coaVersion).toBe(before + 2);
    const events = await db.auditEvent.findMany({ where: { clientId: g.client.id, kind: "ACCOUNT" }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.summary)).toEqual(["Akun 6191 Beban Sewa Kendaraan ditambahkan di Beban umum & administrasi", "Akun 4150 Pendapatan Jasa Medis ditambahkan di Pendapatan usaha"]);
  });

  it("refuses a taken, reserved or malformed code, a duplicate name, and a report line it can't create under", async () => {
    const g = await makeGroup();
    const create = (code: string | undefined, name = "Akun Baru", fsLine = "BEBAN_UMUM_ADM") => createAccount(db, { clientId: g.client.id, fsLine, name, code });
    await expect(create("6100")).rejects.toThrow("Kode 6100 sudah dipakai: Beban Gaji & Tunjangan.");
    await expect(create("2205")).rejects.toThrow("Kode 2205 dicadangkan");
    await expect(create("1105")).rejects.toThrow("dicadangkan");
    await expect(create("61a")).rejects.toThrow("3 sampai 10 digit");
    await expect(create(undefined, "beban sewa")).rejects.toThrow("sudah ada");
    await expect(create(undefined, "Akun", "SUSPENSE")).rejects.toThrow("Pilih pos laporan");
    await expect(create(undefined, "x")).rejects.toThrow("Isi nama akun");
  });

  it("renames and moves within the same type and side; the line moves on the Laba Rugi, net profit stays", async () => {
    const g = await makeGroup();
    const scope = { clientId: g.client.id, entityIds: [g.pt.entity.id] };
    const [cash, rent] = [await account(g.client.id, "1110"), await account(g.client.id, "6190")];
    await db.$transaction((tx) => postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, 9, 5), kind: "ADJUSTMENT", memo: "uji", lines: [{ accountId: rent.id, debit: 7_000_000n }, { accountId: cash.id, credit: 7_000_000n }] }));
    const sep = periodBounds(2026, 9);
    const before = await incomeStatement(db, scope, sep.start, sep.end);

    expect(moveTargets(rent)).toEqual(["HPP", "BEBAN_PENJUALAN", "BEBAN_UMUM_ADM", "BEBAN_LAIN", "BEBAN_PAJAK"]);
    await updateAccount(db, { clientId: g.client.id, accountId: rent.id, name: "Beban Operasional Toko", fsLine: "BEBAN_PENJUALAN" });
    const after = await incomeStatement(db, scope, sep.start, sep.end);
    expect(after.totals.netProfit).toBe(before.totals.netProfit);
    const line = (s: typeof after, key: string) => [...s.revenue, ...s.cogs, ...s.opex, ...s.other, ...s.tax].find((i) => i.fsLine === key);
    expect(line(after, "BEBAN_PENJUALAN")?.accounts).toEqual([{ code: "6190", name: "Beban Operasional Toko", amount: 7_000_000n }]);
    expect(line(after, "BEBAN_UMUM_ADM")?.accounts.some((a) => a.code === "6190") ?? false).toBe(false);

    await expect(updateAccount(db, { clientId: g.client.id, accountId: rent.id, name: "Beban Operasional Toko", fsLine: "PENDAPATAN_USAHA" })).rejects.toThrow("jenis dan saldo normal yang sama");
    const e = await db.auditEvent.findFirstOrThrow({ where: { clientId: g.client.id, kind: "ACCOUNT" } });
    expect(e.summary).toBe("Akun 6190: nama “Beban Umum Lain-lain” → “Beban Operasional Toko”, pos Beban umum & administrasi → Beban penjualan");
  });

  it("protects bank and system accounts", async () => {
    const g = await makeGroup();
    const bank = await account(g.client.id, "1101");
    for (const code of ["1999", "1199", "1190", "3200", "1150", "2140", "1180", "8200", "7190"]) expect(protection(await account(g.client.id, code)), code).toMatch(/^Akun sistem/);
    expect(protection(bank)).toMatch(/^Akun bank/);
    expect(protection(await account(g.client.id, "4100"))).toBeNull();
    await expect(updateAccount(db, { clientId: g.client.id, accountId: (await account(g.client.id, "1999")).id, name: "Lain", fsLine: "SUSPENSE" })).rejects.toThrow("Akun sistem");
    await expect(removeAccount(db, { clientId: g.client.id, accountId: bank.id })).rejects.toThrow("Akun bank");
  });

  it("removes an unused account; refuses a used one naming what uses it; another client's account is not found", async () => {
    const g = await makeGroup();
    const fresh = await createAccount(db, { clientId: g.client.id, fsLine: "BEBAN_UMUM_ADM", name: "Beban Sewa Kendaraan" });
    await removeAccount(db, { clientId: g.client.id, accountId: fresh.id });
    expect(await db.account.count({ where: { clientId: g.client.id, code: "6191" } })).toBe(0);

    // 5100 is the target of the group's PAKAN rule.
    const feed = await account(g.client.id, "5100");
    expect(await accountUsage(db, g.client.id, feed.id)).toEqual(["1 aturan klasifikasi"]);
    const cash = await account(g.client.id, "1110");
    await db.$transaction((tx) => postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, 9, 5), kind: "ADJUSTMENT", memo: "uji", lines: [{ accountId: feed.id, debit: 1_000n }, { accountId: cash.id, credit: 1_000n }] }));
    await expect(removeAccount(db, { clientId: g.client.id, accountId: feed.id })).rejects.toThrow("Akun 5100 Pembelian Bahan & Barang Dagang masih dipakai: 1 baris jurnal, 1 aturan klasifikasi.");

    // A simple-guess account stays even when unused.
    await expect(removeAccount(db, { clientId: g.client.id, accountId: (await account(g.client.id, "4910")).id })).rejects.toThrow("tebakan bawaan");

    const other = await makeGroup();
    const foreign = await account(other.client.id, "6190");
    await expect(removeAccount(db, { clientId: g.client.id, accountId: foreign.id })).rejects.toThrow("Akun tidak ditemukan.");
  });
});
