"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SimpleSelect } from "@/components/app/simple-select";
import { dimensionAction } from "@/app/actions";

type Kind = "DEPARTEMEN" | "PROYEK";
export type DimensionRow = { id: string; kind: Kind; code: string; name: string; archived: boolean; lines: number };

const LABEL: Record<Kind, string> = { DEPARTEMEN: "Departemen", PROYEK: "Proyek" };

/**
 * Pengaturan klien → Departemen & Proyek: the labels a journal line or a bank line may carry for the Laba Rugi per departemen / proyek.
 * An archived one leaves the pickers and stays in the reports; one already used can't be removed.
 */
export function DimensionsCard({ clientId, rows, canEdit }: { clientId: string; rows: DimensionRow[]; canEdit: boolean }) {
  const router = useRouter();
  const [adding, setAdding] = useState<Kind | null>(null);
  const [renaming, setRenaming] = useState<DimensionRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function run(id: string, input: Parameters<typeof dimensionAction>[1], message: string) {
    setBusy(id);
    try {
      const r = await dimensionAction(clientId, input);
      if (!r.ok) return void toast.error(r.error);
      toast.success(message);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card data-testid="dimensions-card">
      <CardHeader>
        <CardTitle>Departemen & proyek</CardTitle>
        <CardDescription>
          Label untuk baris jurnal dan transaksi bank, agar Laba Rugi bisa dilihat per departemen (mis. outlet, divisi) atau per proyek. Tidak
          mengubah saldo akun.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 px-0">
        {(["DEPARTEMEN", "PROYEK"] as const).map((kind) => {
          const list = rows.filter((r) => r.kind === kind);
          return (
            <section key={kind} aria-label={LABEL[kind]} className="space-y-2">
              <div className="flex items-center justify-between px-6">
                <h3 className="text-sm font-medium">{LABEL[kind]}</h3>
                {canEdit && (
                  <Button variant="outline" size="sm" onClick={() => setAdding(kind)}>
                    <Plus /> Tambah {LABEL[kind].toLowerCase()}
                  </Button>
                )}
              </div>
              {list.length === 0 ? (
                <p className="px-6 text-sm text-muted-foreground">Belum ada {LABEL[kind].toLowerCase()}.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-32 pl-6">Kode</TableHead>
                      <TableHead>Nama</TableHead>
                      <TableHead className="hidden text-right md:table-cell">Baris jurnal</TableHead>
                      {canEdit && <TableHead className="pr-6"><span className="sr-only">Tindakan</span></TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {list.map((d) => (
                      <TableRow key={d.id} data-testid="dimension-row" className={d.archived ? "text-muted-foreground" : undefined}>
                        <TableCell className="num pl-6">{d.code}</TableCell>
                        <TableCell className="whitespace-normal">
                          {d.name}
                          {d.archived && <span className="ml-2 text-xs">· Diarsipkan</span>}
                        </TableCell>
                        <TableCell className="num hidden text-right text-muted-foreground md:table-cell">{d.lines ? d.lines.toLocaleString("id-ID") : "–"}</TableCell>
                        {canEdit && (
                          <TableCell className="pr-6 text-right">
                            <div className="flex justify-end gap-1">
                              {!d.archived && (
                                <Button variant="ghost" size="sm" disabled={busy === d.id} onClick={() => setRenaming(d)} aria-label={`Ubah nama ${d.code}`}>
                                  Ubah nama
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy === d.id}
                                aria-label={`${d.archived ? "Aktifkan lagi" : "Arsipkan"} ${d.code}`}
                                onClick={() => run(d.id, { op: "archive", id: d.id, archived: !d.archived }, `${LABEL[kind]} ${d.code} ${d.archived ? "aktif lagi" : "diarsipkan"}`)}
                              >
                                {d.archived ? "Aktifkan lagi" : "Arsipkan"}
                              </Button>
                              {d.lines === 0 && (
                                <Button variant="ghost" size="sm" disabled={busy === d.id} aria-label={`Hapus ${d.code}`} onClick={() => run(d.id, { op: "remove", id: d.id }, `${LABEL[kind]} ${d.code} dihapus`)}>
                                  Hapus
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>
          );
        })}
      </CardContent>
      {adding && <AddDimension clientId={clientId} kind={adding} onClose={() => setAdding(null)} />}
      {renaming && <RenameDimension key={renaming.id} clientId={clientId} row={renaming} onClose={() => setRenaming(null)} />}
    </Card>
  );
}

function AddDimension({ clientId, kind: initial, onClose }: { clientId: string; kind: Kind; onClose: () => void }) {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>(initial);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const r = await dimensionAction(clientId, { op: "create", kind, code, name });
      if (!r.ok) return void toast.error(r.error);
      toast.success(`${LABEL[kind]} ${code.trim().toUpperCase()} ditambahkan`);
      onClose();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tambah {LABEL[kind].toLowerCase()}</DialogTitle>
          <DialogDescription>Kode singkat dipakai di laporan dan Buku Besar; nama boleh diubah nanti.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1 text-sm">
            <span>Jenis</span>
            <SimpleSelect label="Jenis" value={kind} onChange={(v) => setKind(v as Kind)} options={[{ value: "DEPARTEMEN", label: "Departemen" }, { value: "PROYEK", label: "Proyek" }]} />
          </div>
          <label className="grid gap-1 text-sm">
            <span>Kode</span>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder={kind === "PROYEK" ? "mis. PRJ-01" : "mis. OUTLET-A"} maxLength={12} className="w-48 uppercase" />
          </label>
          <label className="grid gap-1 text-sm">
            <span>Nama</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "PROYEK" ? "mis. Gedung Kantor Bekasi" : "mis. Outlet Kemang"} maxLength={60} />
          </label>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Batal</Button>
          <Button onClick={save} disabled={busy || !code.trim() || !name.trim()}>{busy ? "Menyimpan…" : "Simpan"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RenameDimension({ clientId, row, onClose }: { clientId: string; row: DimensionRow; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(row.name);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const r = await dimensionAction(clientId, { op: "rename", id: row.id, name });
      if (!r.ok) return void toast.error(r.error);
      toast.success(`${LABEL[row.kind]} ${row.code} disimpan`);
      onClose();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ubah nama {row.code}</DialogTitle>
          <DialogDescription>Kodenya tetap, agar baris jurnal dan laporan lama tetap menunjuk ke {LABEL[row.kind].toLowerCase()} yang sama.</DialogDescription>
        </DialogHeader>
        <label className="grid gap-1 text-sm">
          <span>Nama</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Batal</Button>
          <Button onClick={save} disabled={busy || !name.trim()}>{busy ? "Menyimpan…" : "Simpan"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
