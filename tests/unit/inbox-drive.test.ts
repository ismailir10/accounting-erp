import { describe, expect, it } from "vitest";
import type { DriveFile } from "@/lib/evidence/drive";
import { DRIVE_FOLDER_MIME, DRIVE_SHORTCUT_MIME } from "@/lib/evidence/drive";
import { DRIVE_TOO_MANY, fetchDriveFile, listDriveFolder, type DriveReader } from "@/lib/inbox/drive";

/** A fake Drive: folder id → children (paged by `pageSize`), so no test calls Google. */
function fakeDrive(tree: Record<string, DriveFile[]>, roots: Record<string, DriveFile>, pageSize = 100) {
  const calls: string[] = [];
  const reader: DriveReader = {
    async get(id) {
      const file = roots[id] ?? Object.values(tree).flat().find((f) => f.id === id);
      if (!file) throw new Error(`no ${id}`);
      return file;
    },
    async list(id, pageToken) {
      calls.push(`${id}:${pageToken ?? 0}`);
      const all = tree[id] ?? [];
      const start = Number(pageToken ?? 0);
      const next = start + pageSize;
      return { files: all.slice(start, next), ...(next < all.length ? { nextPageToken: String(next) } : {}) };
    },
  };
  return { reader, calls };
}
const folder = (id: string, name: string): DriveFile => ({ id, name, mimeType: DRIVE_FOLDER_MIME });
const file = (id: string, name: string, mimeType = "application/pdf", size = "1000"): DriveFile => ({ id, name, mimeType, size });

describe("Unggah: a pasted Drive folder", () => {
  it("lists readable files of the folder and its subfolders, skipping system, backup, shortcut and unsupported files", async () => {
    const { reader } = fakeDrive(
      {
        root: [
          folder("rk", "REKENING KORAN"),
          file("gl", "Buku Besar 2026.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "2048"),
          { id: "sheet", name: "Neraca", mimeType: "application/vnd.google-apps.spreadsheet" },
          file("photo", "struk.jpg", "image/jpeg"),
          file("slides", "Presentasi", "application/vnd.google-apps.presentation"),
          file("bak", "bca jan backup.pdf"),
          file("ds", ".DS_Store", "application/octet-stream"),
          { id: "sc", name: "pintasan.pdf", mimeType: DRIVE_SHORTCUT_MIME, shortcutDetails: { targetId: "elsewhere", targetMimeType: "application/pdf" } },
          folder("nm", "node_modules"),
        ],
        rk: [folder("bca", "BCA"), folder("tmp", "tmp")],
        bca: [file("jan", "bca-jan.pdf"), file("feb", "bca-feb.csv", "text/csv")],
        tmp: [file("x", "x.pdf")],
        nm: [file("y", "y.pdf")],
      },
      { root: folder("root", "Klien A") },
    );
    const files = await listDriveFolder(reader, { id: "root" });
    expect(files).toEqual([
      { id: "gl", name: "Buku Besar 2026.xlsx", path: "Klien A/Buku Besar 2026.xlsx", size: 2048 },
      { id: "sheet", name: "Neraca", path: "Klien A/Neraca", size: null },
      { id: "feb", name: "bca-feb.csv", path: "Klien A/REKENING KORAN/BCA/bca-feb.csv", size: 1000 },
      { id: "jan", name: "bca-jan.pdf", path: "Klien A/REKENING KORAN/BCA/bca-jan.pdf", size: 1000 },
    ]);
  });

  it("follows every page of a folder", async () => {
    const many = Array.from({ length: 7 }, (_, i) => file(`f${i}`, `mutasi-${i}.pdf`));
    const { reader, calls } = fakeDrive({ root: many }, { root: folder("root", "Klien") }, 3);
    expect(await listDriveFolder(reader, { id: "root" })).toHaveLength(7);
    expect(calls).toEqual(["root:0", "root:3", "root:6"]);
  });

  it("refuses a folder with more than 200 readable files, and a link that isn't a folder", async () => {
    const many = Array.from({ length: 201 }, (_, i) => file(`f${i}`, `mutasi-${i}.pdf`));
    const { reader } = fakeDrive({ root: many }, { root: folder("root", "Klien"), one: file("one", "a.pdf") });
    await expect(listDriveFolder(reader, { id: "root" })).rejects.toThrow(DRIVE_TOO_MANY);
    await expect(listDriveFolder(reader, { id: "one" })).rejects.toThrow("Tautan harus menuju folder Google Drive.");
  });

  it("stops at 20 levels of subfolders", async () => {
    const tree: Record<string, DriveFile[]> = {};
    for (let i = 0; i < 21; i++) tree[`d${i}`] = [folder(`d${i + 1}`, `L${i + 1}`)];
    const { reader } = fakeDrive(tree, { d0: folder("d0", "Akar") });
    await expect(listDriveFolder(reader, { id: "d0" })).rejects.toThrow("Folder lebih dari 20 tingkat; unggah per subfolder.");
  });

  it("fetches a file by id with Drive's own name and type, and refuses folders and shortcuts", async () => {
    const { reader } = fakeDrive({ root: [file("jan", "bca-jan.pdf"), folder("sub", "Sub")] }, { root: folder("root", "Klien") });
    const downloaded: string[] = [];
    const drive = { ...reader, download: async (f: DriveFile) => (downloaded.push(f.name), { name: f.name, data: Buffer.from("x") }) };
    expect((await fetchDriveFile(drive, "jan")).name).toBe("bca-jan.pdf");
    await expect(fetchDriveFile(drive, "sub")).rejects.toThrow("Pilih file, bukan folder atau pintasan.");
    expect(downloaded).toEqual(["bca-jan.pdf"]);
  });
});
