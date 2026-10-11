/** Read-only Google transport. Tokens remain server-side; callers persist them encrypted. */
export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  version?: string;
  md5Checksum?: string;
  webViewLink?: string;
  resourceKey?: string;
  shortcutDetails?: { targetId: string; targetMimeType: string; targetResourceKey?: string };
};

export type GoogleTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope?: string;
};

export class DriveError extends Error {
  constructor(message: string, public readonly code: string, public readonly status?: number) {
    super(message);
    this.name = "DriveError";
  }
}

export const DRIVE_FILE_LIMIT = 10 * 1024 * 1024;
export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
export const DRIVE_SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const FIELDS = "id,name,mimeType,size,modifiedTime,version,md5Checksum,webViewLink,resourceKey,shortcutDetails(targetId,targetMimeType,targetResourceKey)";
const ID = /^[A-Za-z0-9_-]{1,200}$/;

function checkedId(id: string) {
  if (!ID.test(id)) throw new DriveError("ID Google Drive tidak valid.", "INVALID_ID");
  return id;
}

export function parseDriveFolderUrl(value: string): { id: string; resourceKey?: string } {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new DriveError("Tempel tautan folder Google Drive yang valid.", "INVALID_URL"); }
  const match = url.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]+)\/?$/);
  if (url.protocol !== "https:" || url.hostname !== "drive.google.com" || url.port || url.username || url.password || !match) {
    throw new DriveError("Gunakan tautan folder https://drive.google.com/drive/folders/…", "INVALID_URL");
  }
  const resourceKey = url.searchParams.get("resourcekey") ?? undefined;
  return { id: checkedId(match[1]), ...(resourceKey ? { resourceKey: checkedId(resourceKey) } : {}) };
}

function oauthConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) throw new DriveError("Koneksi Google belum dikonfigurasi oleh admin.", "NOT_CONFIGURED");
  let url: URL;
  try { url = new URL(redirectUri); } catch { throw new DriveError("Alamat callback Google tidak valid.", "NOT_CONFIGURED"); }
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!local && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || url.pathname !== "/api/google/callback") {
    throw new DriveError("Callback Google harus memakai HTTPS dan jalur /api/google/callback (HTTP hanya untuk localhost).", "NOT_CONFIGURED");
  }
  return { clientId, clientSecret, redirectUri };
}

export function oauthConfigured(): boolean {
  try { oauthConfig(); return true; } catch { return false; }
}

export function oauthAuthorizationUrl(state: string): string {
  const config = oauthConfig();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(state)) throw new DriveError("Status koneksi Google tidak valid.", "INVALID_STATE");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", scope: DRIVE_SCOPE, access_type: "offline", prompt: "consent", state }).toString();
  return url.toString();
}

async function request(url: string | URL, init: RequestInit = {}): Promise<Response> {
  try {
    // Redirects never forward a credential to a URL supplied by a document or response.
    return await fetch(url, { ...init, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new DriveError("Google Drive tidak merespons. Coba kembali tanpa mengulang file yang sudah selesai.", "NETWORK");
  }
}

async function boundedBytes(response: Response, limit: number): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && BigInt(declared) > BigInt(limit)) {
    await response.body?.cancel();
    throw new DriveError("File melebihi batas 10 MiB. Pecah file atau unggah versi yang lebih kecil.", "TOO_LARGE");
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new DriveError("File melebihi batas 10 MiB. Pecah file atau unggah versi yang lebih kecil.", "TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof DriveError) throw error;
    throw new DriveError("Unduhan Google Drive terputus. Coba kembali.", "NETWORK");
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

async function checkedResponse(response: Response): Promise<Response> {
  if (response.ok) return response;
  // Read only bounded error data; never expose provider messages (which may contain secrets).
  let code = "";
  try {
    const json = JSON.parse((await boundedBytes(response, 64 * 1024)).toString("utf8"));
    code = typeof json.error === "string" ? json.error : json.error?.errors?.[0]?.reason ?? "";
  } catch { /* Status alone still gives a safe actionable error. */ }
  // Wrong client ID/secret or redirect URI is operator configuration, not revoked consent.
  if (["invalid_client", "unauthorized_client", "redirect_uri_mismatch"].includes(code)) throw new DriveError("Konfigurasi Google di server tidak cocok (client ID, secret, atau alamat callback). Hubungi pengelola Buku.", "CONFIG", response.status);
  if (response.status === 401 || code === "invalid_grant") throw new DriveError("Izin Google kedaluwarsa atau dicabut. Hubungkan kembali Google Drive.", "RECONNECT", response.status);
  if (response.status === 429 || ["rateLimitExceeded", "userRateLimitExceeded"].includes(code)) throw new DriveError("Batas permintaan Google tercapai. Tunggu lalu lanjutkan pemindaian.", "RATE_LIMIT", response.status);
  if (code === "exportSizeLimitExceeded") throw new DriveError("Ekspor Google melebihi batas 10 MiB. Pecah dokumen lalu coba kembali.", "TOO_LARGE", response.status);
  if (response.status === 403) throw new DriveError("Akses file ditolak. Periksa izin berbagi dan akun Google yang terhubung.", "FORBIDDEN", response.status);
  if (response.status === 404) throw new DriveError("File tidak ditemukan atau tidak lagi dapat diakses. Periksa tautan dan izin berbagi.", "NOT_FOUND", response.status);
  throw new DriveError("Permintaan Google gagal. Periksa koneksi lalu coba kembali.", "GOOGLE_ERROR", response.status);
}

async function jsonResponse(response: Response): Promise<unknown> {
  await checkedResponse(response);
  try { return JSON.parse((await boundedBytes(response, DRIVE_FILE_LIMIT)).toString("utf8")); }
  catch (error) {
    if (error instanceof DriveError) throw error;
    throw new DriveError("Respons Google tidak valid. Coba kembali.", "INVALID_RESPONSE");
  }
}

async function tokenRequest(body: Record<string, string>): Promise<GoogleTokens> {
  const config = oauthConfig();
  const payload = await jsonResponse(await request("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...body }),
  }));
  if (!payload || typeof payload !== "object") throw new DriveError("Respons token Google tidak valid. Hubungkan kembali.", "INVALID_RESPONSE");
  const result = payload as Record<string, unknown>;
  if (typeof result.access_token !== "string" || !result.access_token || typeof result.expires_in !== "number" || result.expires_in <= 0 || !Number.isFinite(result.expires_in)) throw new DriveError("Respons token Google tidak valid. Hubungkan kembali.", "INVALID_RESPONSE");
  if (typeof result.scope === "string" && !result.scope.split(" ").includes(DRIVE_SCOPE)) throw new DriveError("Izin membaca Google Drive belum diberikan. Hubungkan kembali dan centang akses Google Drive.", "SCOPE");
  return { accessToken: result.access_token, expiresIn: result.expires_in, ...(typeof result.refresh_token === "string" ? { refreshToken: result.refresh_token } : {}), ...(typeof result.scope === "string" ? { scope: result.scope } : {}) };
}

export async function exchangeCode(code: string): Promise<GoogleTokens> {
  return tokenRequest({ code, redirect_uri: oauthConfig().redirectUri, grant_type: "authorization_code" });
}

export async function refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
  return tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
}

export async function revokeToken(token: string): Promise<void> {
  await checkedResponse(await request("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) }));
}

function driveHeaders(token: string, id: string, resourceKey?: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...(resourceKey ? { "X-Goog-Drive-Resource-Keys": `${checkedId(id)}/${checkedId(resourceKey)}` } : {}) };
}

function parseFile(value: unknown): DriveFile {
  if (!value || typeof value !== "object") throw new DriveError("Metadata file Google tidak valid.", "INVALID_RESPONSE");
  const file = value as Record<string, unknown>;
  if (typeof file.id !== "string" || !ID.test(file.id) || typeof file.name !== "string" || typeof file.mimeType !== "string") throw new DriveError("Metadata file Google tidak valid.", "INVALID_RESPONSE");
  const result: DriveFile = { id: file.id, name: file.name, mimeType: file.mimeType };
  for (const key of ["size", "modifiedTime", "version", "md5Checksum", "webViewLink", "resourceKey"] as const) {
    if (typeof file[key] === "string") result[key] = file[key];
  }
  if (file.shortcutDetails && typeof file.shortcutDetails === "object") {
    const detail = file.shortcutDetails as Record<string, unknown>;
    if (typeof detail.targetId === "string" && ID.test(detail.targetId) && typeof detail.targetMimeType === "string") {
      result.shortcutDetails = { targetId: detail.targetId, targetMimeType: detail.targetMimeType, ...(typeof detail.targetResourceKey === "string" ? { targetResourceKey: detail.targetResourceKey } : {}) };
    }
  }
  return result;
}

export async function getDriveFile(accessToken: string, id: string, resourceKey?: string): Promise<DriveFile> {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${checkedId(id)}`);
  url.search = new URLSearchParams({ fields: FIELDS, supportsAllDrives: "true" }).toString();
  return parseFile(await jsonResponse(await request(url, { headers: driveHeaders(accessToken, id, resourceKey) })));
}

export async function listDriveChildren(accessToken: string, id: string, pageToken?: string, resourceKey?: string): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.search = new URLSearchParams({ q: `'${checkedId(id)}' in parents and trashed = false`, fields: `nextPageToken,incompleteSearch,files(${FIELDS})`, pageSize: "100", spaces: "drive", supportsAllDrives: "true", includeItemsFromAllDrives: "true", ...(pageToken ? { pageToken } : {}) }).toString();
  const result = await jsonResponse(await request(url, { headers: driveHeaders(accessToken, id, resourceKey) })) as Record<string, unknown>;
  if (!result || !Array.isArray(result.files)) throw new DriveError("Daftar file Google tidak valid. Coba kembali.", "INVALID_RESPONSE");
  if (result.incompleteSearch === true) throw new DriveError("Google belum mengembalikan seluruh file. Pemindaian belum lengkap; coba kembali.", "INCOMPLETE_SEARCH");
  return { files: result.files.map(parseFile), ...(typeof result.nextPageToken === "string" ? { nextPageToken: result.nextPageToken } : {}) };
}

const GOOGLE_EXPORTS = ["application/vnd.google-apps.document", "application/vnd.google-apps.spreadsheet"];
/** Whether `downloadDriveFile` can fetch this file: a Google Doc / Sheet (exported) or a PDF, XLSX, XLS, CSV, TXT or Markdown file. */
export function driveDownloadable(file: Pick<DriveFile, "name" | "mimeType">): boolean {
  if (GOOGLE_EXPORTS.includes(file.mimeType)) return true;
  return !file.mimeType.startsWith("application/vnd.google-apps.") && /\.(pdf|xlsx|xls|csv|txt|md|markdown)$/i.test(file.name);
}

export async function downloadDriveFile(accessToken: string, file: DriveFile): Promise<{ name: string; data: Buffer }> {
  const id = checkedId(file.id);
  if (file.size && /^\d+$/.test(file.size) && BigInt(file.size) > BigInt(DRIVE_FILE_LIMIT)) throw new DriveError("File melebihi batas 10 MiB. Pecah file atau unggah versi yang lebih kecil.", "TOO_LARGE");
  let name = file.name;
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${id}`);
  if (file.mimeType === "application/vnd.google-apps.document" || file.mimeType === "application/vnd.google-apps.spreadsheet") {
    const sheet = file.mimeType.endsWith("spreadsheet");
    url.pathname += "/export";
    url.searchParams.set("mimeType", sheet ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/plain");
    const extension = sheet ? ".xlsx" : ".txt";
    if (!name.toLowerCase().endsWith(extension)) name += extension;
  } else {
    if (!driveDownloadable(file)) throw new DriveError("Format belum didukung. Unggah PDF berteks, XLSX, XLS, CSV, TXT, atau Markdown; ekspor dokumen lain ke salah satu format tersebut.", "UNSUPPORTED");
    url.search = new URLSearchParams({ alt: "media", supportsAllDrives: "true" }).toString();
  }
  const response = await checkedResponse(await request(url, { headers: driveHeaders(accessToken, id, file.resourceKey) }));
  return { name, data: await boundedBytes(response, DRIVE_FILE_LIMIT) };
}
