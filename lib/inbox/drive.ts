import type { DriveFile } from "@/lib/evidence/drive";
import { DRIVE_FOLDER_MIME, DRIVE_SHORTCUT_MIME, driveDownloadable } from "@/lib/evidence/drive";
import { backup, ignored } from "@/lib/evidence/jobs";
import { InboxError } from "./plan";

/**
 * A Google Drive folder pasted on the Unggah page (cycle 2026-10-10-unggah-inbox): the files to check, subfolders included. Lists only —
 * the page then asks the server to fetch and check each file (one request per file). Drive access is injected so tests never call Google.
 */

/** The firm's read-only Drive calls (lib/evidence/drive.ts with the firm's token bound). */
export type DriveReader = {
  get(id: string, resourceKey?: string): Promise<DriveFile>;
  list(id: string, pageToken?: string, resourceKey?: string): Promise<{ files: DriveFile[]; nextPageToken?: string }>;
};
export type DriveListedFile = { id: string; name: string; path: string; size: number | null; resourceKey?: string };

export const DRIVE_MAX_FILES = 200;
export const DRIVE_MAX_DEPTH = 20;
/** Folders read at most (empty subfolders cost a request each). */
const DRIVE_MAX_FOLDERS = 200;
export const DRIVE_TOO_MANY = `Folder berisi lebih dari ${DRIVE_MAX_FILES} file; unggah per subfolder.`;
const TOO_DEEP = `Folder lebih dari ${DRIVE_MAX_DEPTH} tingkat; unggah per subfolder.`;
const TOO_WIDE = `Folder berisi lebih dari ${DRIVE_MAX_FOLDERS} subfolder; unggah per subfolder.`;

/**
 * Every file under the folder that Buku can read, oldest-first ordering left to the plan: system / code files and backup copies are
 * skipped (Dokumen's filters), so are formats Drive can't hand over (images, other Google files) and shortcuts (they point outside
 * the pasted folder; Dokumen asks before following one). Subfolders are followed to `DRIVE_MAX_DEPTH`; more than `DRIVE_MAX_FILES`
 * files refuses the folder rather than checking part of it.
 */
export async function listDriveFolder(drive: DriveReader, root: { id: string; resourceKey?: string }): Promise<DriveListedFile[]> {
  const folder = await drive.get(root.id, root.resourceKey);
  if (folder.mimeType !== DRIVE_FOLDER_MIME) throw new InboxError("Tautan harus menuju folder Google Drive.");
  const queue = [{ id: folder.id, resourceKey: root.resourceKey ?? folder.resourceKey, path: folder.name, depth: 0 }];
  const visited = new Set([folder.id]);
  const files: DriveListedFile[] = [];
  while (queue.length) {
    const at = queue.shift()!;
    let pageToken: string | undefined;
    do {
      const page = await drive.list(at.id, pageToken, at.resourceKey);
      for (const file of page.files) {
        if (ignored.test(file.name) || backup.test(file.name) || file.mimeType === DRIVE_SHORTCUT_MIME) continue;
        const path = `${at.path}/${file.name}`;
        if (file.mimeType === DRIVE_FOLDER_MIME) {
          if (visited.has(file.id)) continue;
          if (at.depth + 1 > DRIVE_MAX_DEPTH) throw new InboxError(TOO_DEEP);
          if (visited.size >= DRIVE_MAX_FOLDERS) throw new InboxError(TOO_WIDE);
          visited.add(file.id);
          queue.push({ id: file.id, resourceKey: file.resourceKey, path, depth: at.depth + 1 });
          continue;
        }
        if (!driveDownloadable(file)) continue;
        if (files.length >= DRIVE_MAX_FILES) throw new InboxError(DRIVE_TOO_MANY);
        const size = file.size && /^\d+$/.test(file.size) ? Number(file.size) : null;
        files.push({ id: file.id, name: file.name, path, size, ...(file.resourceKey ? { resourceKey: file.resourceKey } : {}) });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * One listed file, fetched again by id with the firm's token: its name and type come from Drive, never from the browser. Folders,
 * shortcuts and formats Buku can't read are refused.
 */
export async function fetchDriveFile(drive: DriveReader & { download(file: DriveFile): Promise<{ name: string; data: Buffer }> }, id: string, resourceKey?: string) {
  const file = await drive.get(id, resourceKey);
  if (file.mimeType === DRIVE_FOLDER_MIME || file.mimeType === DRIVE_SHORTCUT_MIME) throw new InboxError("Pilih file, bukan folder atau pintasan.");
  // download refuses the formats Buku can't read (DriveError UNSUPPORTED).
  return drive.download(file);
}
