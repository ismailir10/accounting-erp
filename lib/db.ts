import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { databaseUrl } from "@/lib/db-url";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** The Supabase ↔ Vercel integration's pooled URL when present (it wins over a stale DATABASE_URL), else DATABASE_URL (lib/db-url.ts). */
export function createPrisma(url = databaseUrl(process.env)) {
  if (!url) throw new Error("DATABASE_URL belum diatur (lihat .env.example)");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

export const prisma = globalForPrisma.prisma ?? createPrisma();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export type Db = PrismaClient;
export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
