import "dotenv/config";
import "../lib/local-database-only";
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createPrisma } from "../lib/db";
import { ensureLocalAdmin } from "../lib/auth/operator";
import { createSupabaseAdmin } from "../lib/supabase/admin";
import { createClient, createFirm } from "../lib/setup";
import { endOfDayJakarta } from "../lib/access/grant";

/**
 * Seed synthetic books and create the e2e member through the Supabase admin API (a real account with a
 * real password). The browser then logs in through the real form (e2e/global-setup.ts). No server bypass.
 */
async function setup() {
  const baseURL = process.env.BASE_URL ?? "http://localhost:3200";
  if (!["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname)) throw new Error("E2E setup only accepts disposable localhost environments.");
  execSync("npx tsx scripts/seed.ts", { stdio: "inherit", env: process.env });
  const db = createPrisma();
  try {
    const firm = await db.firm.findFirstOrThrow();
    const email = process.env.E2E_EMAIL ?? "accountant@buku.example";
    const password = process.env.E2E_PASSWORD ?? randomBytes(12).toString("base64url");
    await ensureLocalAdmin(db, createSupabaseAdmin().auth, { email, password, name: "Akuntan uji", firmId: firm.id });
    mkdirSync(".playwright", { recursive: true });
    writeFileSync(".playwright/credentials.json", JSON.stringify({ email, password }), { mode: 0o600 });

    // Two more real accounts for the access specs (e2e/qa-access.spec.ts): an AKUNTAN in the same firm, and an ADMIN of a second, empty firm.
    const auth = createSupabaseAdmin().auth;
    const akuntan = { email: "akuntan@buku.example", password: randomBytes(12).toString("base64url") };
    await ensureLocalAdmin(db, auth, { ...akuntan, name: "Akuntan uji", firmId: firm.id });
    // An AKUNTAN works on assigned clients (ADR 0017); like a CLI invitation, this one gets every demo client.
    const clients = await db.client.findMany({ where: { firmId: firm.id }, select: { id: true } });
    await db.firmMember.update({ where: { email: akuntan.email }, data: { role: "AKUNTAN", clientAccess: { deleteMany: {}, create: clients.map((c) => ({ clientId: c.id })) } } });
    const other = { email: "admin-lain@buku.example", password: randomBytes(12).toString("base64url") };
    const otherFirm = await db.firm.findFirst({ where: { name: "KAP Uji Lain" } }) ?? await db.$transaction((tx) => createFirm(tx, "KAP Uji Lain"));
    await ensureLocalAdmin(db, auth, { ...other, name: "Admin firma lain", firmId: otherFirm.id });
    // Trial accounts for e2e/trial-expiry.spec.ts (ADR 0017): one organisation whose trial ended yesterday, one ending in 3 days.
    const wibDay = (offset: number) => new Date(Date.now() + 7 * 3600_000 + offset * 86_400_000).toISOString().slice(0, 10);
    const trialFirm = async (name: string, endsOn: string) => (await db.firm.findFirst({ where: { name } })) ?? db.$transaction(async (tx) => {
      const f = await createFirm(tx, name, { grant: { kind: "TRIAL", startsAt: new Date(Date.now() - 20 * 86_400_000), endsAt: endOfDayJakarta(endsOn), note: "e2e" } });
      await createClient(tx, f.id, { name: `Klien ${name}`, industry: "jasa", entities: [{ name: `PT ${name}`, shortName: name, kind: "PT", banks: [{ bank: "BCA", number: "9999999999", label: "BCA Giro" }] }] });
      return f;
    });
    const ended = { email: "pemilik-berakhir@buku.example", password: randomBytes(12).toString("base64url") };
    await ensureLocalAdmin(db, auth, { ...ended, name: "Pemilik uji berakhir", firmId: (await trialFirm("Uji Berakhir", wibDay(-1))).id });
    const ending = { email: "pemilik-segera@buku.example", password: randomBytes(12).toString("base64url") };
    await ensureLocalAdmin(db, auth, { ...ending, name: "Pemilik uji segera", firmId: (await trialFirm("Uji Segera", wibDay(3))).id });
    // A company keeping its own books (e2e/company-org.spec.ts): one client, the company, with two entities.
    const companyName = "PT Uji Perusahaan";
    const companyFirm = (await db.firm.findFirst({ where: { name: companyName } })) ?? await db.$transaction(async (tx) => {
      const f = await createFirm(tx, companyName, { kind: "PERUSAHAAN" });
      await createClient(tx, f.id, { name: companyName, industry: "distribusi", entities: [
        { name: companyName, shortName: "Perusahaan", kind: "PT", banks: [{ bank: "MANDIRI", number: "8888888888", label: "Mandiri Giro" }] },
        { name: "PT Uji Logistik", shortName: "Logistik", kind: "PT", banks: [] },
      ] });
      return f;
    });
    const companyOwner = { email: "pemilik-perusahaan@buku.example", password: randomBytes(12).toString("base64url") };
    await ensureLocalAdmin(db, auth, { ...companyOwner, name: "Pemilik perusahaan uji", firmId: companyFirm.id });
    writeFileSync(".playwright/credentials-company.json", JSON.stringify(companyOwner), { mode: 0o600 });
    // A Buku admin who is no organisation's member (e2e/backoffice.spec.ts): a real local account with a known password.
    const ops = { email: "ops@buku.example", password: randomBytes(12).toString("base64url") };
    const created = await auth.admin.createUser({ email: ops.email, password: ops.password, email_confirm: true, user_metadata: { name: "Admin Buku uji" } });
    let opsId = created.data.user?.id;
    if (!opsId) {
      opsId = (await auth.admin.listUsers({ page: 1, perPage: 1000 })).data.users.find((u) => u.email === ops.email)?.id;
      if (!opsId) throw new Error("Akun admin Buku uji tidak bisa dibuat.");
      await auth.admin.updateUserById(opsId, { password: ops.password });
    }
    await db.platformAdmin.upsert({ where: { email: ops.email }, create: { userId: opsId, email: ops.email, name: "Admin Buku uji" }, update: { userId: opsId, disabled: false } });
    // Every run enrols two-step login afresh (e2e/support-session.spec.ts reads the new secret from the page).
    const factors = await auth.admin.mfa.listFactors({ userId: opsId });
    for (const factor of factors.data?.factors ?? []) await auth.admin.mfa.deleteFactor({ id: factor.id, userId: opsId });
    writeFileSync(".playwright/credentials-ops.json", JSON.stringify(ops), { mode: 0o600 });
    writeFileSync(".playwright/credentials-trial-ended.json", JSON.stringify(ended), { mode: 0o600 });
    writeFileSync(".playwright/credentials-trial-ending.json", JSON.stringify(ending), { mode: 0o600 });
    writeFileSync(".playwright/credentials-akuntan.json", JSON.stringify(akuntan), { mode: 0o600 });
    writeFileSync(".playwright/credentials-other-firm.json", JSON.stringify(other), { mode: 0o600 });
  } finally { await db.$disconnect(); }
}

setup().catch(error => { console.error(error); process.exitCode = 1; });
