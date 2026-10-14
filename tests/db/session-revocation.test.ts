import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { addMember } from "../members";
import { createIntake, hash, json } from "@/lib/evidence/store";
import type { EvidenceUnit } from "@/lib/evidence/types";

// Keep the verified identity unchanged across requests. Membership, grants, client
// assignments, guards, pages and download handlers all use the real test database.
const auth = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", () => ({ authConfigured: () => true }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: auth.userId } } }) },
  }),
}));

import { getClientForMember } from "@/lib/tenant";
import { getWorkspaceSession } from "@/lib/auth/session";
import { loadEvidenceAction } from "@/app/evidence-actions";
import { askWorkspaceAction } from "@/app/workspace-actions";
import IntakePage from "@/app/(app)/documents/[intakeId]/page";
import SourcePage from "@/app/(app)/documents/source/[versionId]/page";
import { GET as statements } from "@/app/(app)/clients/[id]/reports/export/route";
import { GET as pdf } from "@/app/(app)/clients/[id]/reports/export/pdf/route";
import { GET as management } from "@/app/(app)/clients/[id]/reports/export/management/route";
import { GET as credit } from "@/app/(app)/clients/[id]/reports/export/credit/route";
import { GET as tax } from "@/app/(app)/clients/[id]/tax/export/route";
import { GET as masa } from "@/app/(app)/clients/[id]/tax/masa/export/route";
import { GET as review } from "@/app/(app)/clients/[id]/review/export/route";

const downloads = [
  ["reports/export", statements], ["reports/export/pdf", pdf],
  ["reports/export/management", management], ["reports/export/credit", credit],
  ["tax/export", tax], ["tax/masa/export", masa], ["review/export", review],
] as const;

async function openSession(role: "ADMIN" | "AKUNTAN" = "AKUNTAN") {
  const g = await makeGroup();
  const member = await addMember(g.firm.id, role, { clients: role === "AKUNTAN" ? [g.client.id] : [] });
  auth.userId = member.userId;
  const intake = await createIntake(db, g.firm.id, g.client.id);
  const text = "Sumber sintetis pencabutan akses";
  const unit: EvidenceUnit = {
    key: "text", label: "Sumber uji", kind: "CONTEXT", role: "CONTEXT",
    entity: null, periodStart: null, periodEnd: null, currency: "IDR", scale: "1",
    passages: [{ locator: "baris 1", text }], figures: [], facts: [], issues: [],
  };
  const document = await db.evidenceDocument.create({ data: {
    firmId: g.firm.id, intakeId: intake.id, sourceKey: "synthetic", name: "synthetic.txt",
    path: "synthetic.txt", mimeType: "text/plain", status: "READY",
  } });
  const version = await db.evidenceVersion.create({ data: {
    firmId: g.firm.id, documentId: document.id, hash: hash(text), name: document.name,
    size: Buffer.byteLength(text), data: Buffer.from(text), extracted: true, units: json([unit]),
  } });
  await db.evidenceDocument.update({ where: { id: document.id }, data: { currentVersionId: version.id } });
  await db.evidenceFact.create({ data: {
    firmId: g.firm.id, intakeId: intake.id, versionId: version.id, unitKey: unit.key,
    locator: "baris 1", key: "companyName", value: g.pt.entity.name,
  } });
  const question = { question: "Profil perusahaan", scope: `client:${g.client.id}`, period: "2026-08" };
  const answer = await askWorkspaceAction(question);
  expect(answer.ok).toBe(true);
  if (!answer.ok) throw new Error(answer.error);
  const citation = answer.answer.citations.find(c => c.href.startsWith(`/documents/source/${version.id}?`));
  expect(citation).toBeDefined();
  const citationUrl = new URL(citation!.href, "http://localhost");
  const source = () => SourcePage({
    params: Promise.resolve({ versionId: version.id }),
    searchParams: Promise.resolve(Object.fromEntries(citationUrl.searchParams)),
  });
  const documents = () => IntakePage({ params: Promise.resolve({ intakeId: intake.id }) });
  const download = (path: string, handler: typeof statements) => handler(
    new Request(`http://localhost/clients/${g.client.id}/${path}?entity=${g.pt.entity.id}&period=2026-08`),
    { params: Promise.resolve({ id: g.client.id }) },
  );
  const opened = { ...g, member, intake, version, question, citation: citation!.href, source, documents, download };
  expect((await getClientForMember(g.client.id)).id).toBe(g.client.id);
  await expect(documents()).resolves.toBeDefined();
  await expect(source()).resolves.toBeDefined();
  expect((await loadEvidenceAction(intake.id)).ok).toBe(true);
  await expectDownloads(opened);
  return opened;
}

type OpenedSession = Awaited<ReturnType<typeof openSession>>;

async function expectDownloads(session: Pick<OpenedSession, "download">) {
  for (const [path, handler] of downloads) {
    const response = await session.download(path, handler);
    expect(response.status, path).toBe(200);
    expect(response.headers.get("Content-Disposition"), path).toContain("attachment;");
    expect(response.headers.get("Cache-Control"), path).toBe("no-store");
    expect((await response.arrayBuffer()).byteLength, path).toBeGreaterThan(0);
  }
}

async function expectDenied(session: OpenedSession, reason: "SIGNED_OUT" | "CLOSED" | "CLIENT", answerError?: string) {
  expect(auth.userId).toBe(session.member.userId);
  const redirect = reason === "SIGNED_OUT" ? "/login" : "/akses-ditutup";
  const pageError = reason === "CLIENT" ? "NEXT_HTTP_ERROR_FALLBACK;404" : `NEXT_REDIRECT;replace;${redirect};307;`;
  await expect(session.documents()).rejects.toMatchObject({ digest: pageError });
  // Reuse the exact version and locator returned by the answer before revocation.
  await expect(session.source()).rejects.toMatchObject({ digest: pageError });
  const error = {
    SIGNED_OUT: "Masuk terlebih dahulu.",
    CLOSED: "Akses ruang kerja ini ditutup. Hubungi Buku.",
    CLIENT: "Klien tidak ditemukan",
  }[reason];
  expect(await loadEvidenceAction(session.intake.id)).toEqual({ ok: false, error });
  expect(await askWorkspaceAction(session.question)).toEqual({
    ok: false, error: answerError ?? (reason === "CLIENT" ? "Cakupan tidak ditemukan dalam kantor Anda." : error),
  });
  const exportsBefore = await db.auditEvent.count({ where: { kind: "REPORT_EXPORT" } });
  for (const [path, handler] of downloads) {
    if (reason === "CLIENT") {
      const response = await session.download(path, handler);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("Content-Disposition"), path).toBeNull();
      expect(await response.text(), path).toBe("Klien tidak ditemukan");
    } else {
      await expect(session.download(path, handler)).rejects.toMatchObject({ digest: pageError });
    }
  }
  expect(await db.auditEvent.count({ where: { kind: "REPORT_EXPORT" } })).toBe(exportsBefore);
  expect(await db.evidenceVersion.count({ where: { id: session.version.id } })).toBe(1);
}

beforeEach(async () => {
  await resetDb();
  auth.userId = "";
  vi.stubEnv("EVIDENCE_ENABLED", "true");
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("External calls are forbidden in this test"));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("subsequent requests from an already-authorized session", () => {
  it("denies downloads, documents and saved citations after the member is disabled", async () => {
    const session = await openSession();
    await db.firmMember.update({ where: { id: session.member.id }, data: { disabled: true } });
    expect(await getWorkspaceSession()).toBeNull();
    await expectDenied(session, "SIGNED_OUT");
  });

  it("denies downloads, documents and saved citations after all tenant grants are revoked", async () => {
    const session = await openSession();
    await db.accessGrant.updateMany({ where: { firmId: session.firm.id }, data: { revokedAt: new Date() } });
    expect((await getWorkspaceSession())?.access.state).toBe("NONE");
    await expectDenied(session, "CLOSED");
  });

  it("denies downloads, documents and saved citations after the tenant is suspended", async () => {
    const session = await openSession();
    await db.firm.update({ where: { id: session.firm.id }, data: { suspendedAt: new Date() } });
    await expectDenied(session, "CLOSED");
  });

  it("denies downloads, documents and saved citations after the client's assignment is removed", async () => {
    const session = await openSession();
    await db.clientAccess.deleteMany({ where: { memberId: session.member.id, clientId: session.client.id } });
    await expectDenied(session, "CLIENT");
  });

  it("loses the admin's implicit client access when demoted without an assignment", async () => {
    const session = await openSession("ADMIN");
    await db.firmMember.update({ where: { id: session.member.id }, data: { role: "VIEWER" } });
    await expectDenied(session, "CLIENT", "Peran Peninjau hanya dapat melihat dan mengunduh laporan.");
  });

  it("keeps assigned viewer reads/downloads but denies new answers after a role downgrade", async () => {
    const session = await openSession();
    await db.firmMember.update({ where: { id: session.member.id }, data: { role: "VIEWER" } });
    await expectDownloads(session);
    await expect(session.documents()).resolves.toBeDefined();
    await expect(session.source()).resolves.toBeDefined();
    expect((await loadEvidenceAction(session.intake.id)).ok).toBe(true);
    expect(await askWorkspaceAction(session.question)).toEqual({
      ok: false, error: "Peran Peninjau hanya dapat melihat dan mengunduh laporan.",
    });
  });

  it("keeps expired-grant reads/downloads but denies new answers (READ_ONLY is not revocation)", async () => {
    const session = await openSession();
    await db.accessGrant.updateMany({ where: { firmId: session.firm.id }, data: {
      kind: "TRIAL", startsAt: new Date("2026-01-01T00:00:00Z"), endsAt: new Date("2026-01-02T00:00:00Z"),
    } });
    expect((await getWorkspaceSession())?.access.state).toBe("READ_ONLY");
    await expectDownloads(session);
    await expect(session.documents()).resolves.toBeDefined();
    await expect(session.source()).resolves.toBeDefined();
    expect((await loadEvidenceAction(session.intake.id)).ok).toBe(true);
    expect(await askWorkspaceAction(session.question)).toMatchObject({
      ok: false, error: expect.stringContaining("Masa uji coba berakhir"),
    });
  });
});
