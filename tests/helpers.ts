import "@/lib/local-database-only";
import { createPrisma } from "@/lib/db";
import { createClient, createFirm } from "@/lib/setup";

export const db = createPrisma();

export async function resetDb() {
  const tables = await db.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`,
  );
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(",")} CASCADE`);
}

/** Two-entity group: PT (BCA + Mandiri) and owner (BRI). */
export async function makeGroup() {
  return db.$transaction(async (tx) => {
    const firm = await createFirm(tx, "KJA Uji");
    const { client, entities } = await createClient(tx, firm.id, {
      name: "Grup Uji",
      industry: "agritech",
      entities: [
        { name: "PT Uji Sejahtera", shortName: "PT Uji", kind: "PT", banks: [{ bank: "BCA", number: "1111111111", label: "BCA Giro" }, { bank: "MANDIRI", number: "2222222222", label: "Mandiri Giro" }] },
        { name: "Andi Wijaya", shortName: "Andi", kind: "PERORANGAN", banks: [{ bank: "BRI", number: "3333333333", label: "BRI Tabungan" }] },
      ],
      rules: [{ pattern: "PAKAN", direction: "OUT", accountCode: "5100", taxTag: "PPN_MASUKAN", priority: 50 }],
    });
    return { firm, client, pt: entities[0], owner: entities[1] };
  });
}
