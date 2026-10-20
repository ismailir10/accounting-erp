"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Lock, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SimpleSelect } from "@/components/app/simple-select";
import { Money } from "@/components/app/money";
import { archiveAccountAction, createAccountAction, removeAccountAction, updateAccountAction } from "@/app/actions";

type Option = { value: string; label: string };
export type AccountRow = {
  id: string;
  code: string;
  name: string;
  fsLine: string;
  fsLabel: string;
  side: "D" | "K";
  /** Balance on the normal side at the page's month; null for a mixed-currency group. */
  balance: string | null;
  lines: number;
  href: string;
  /** Why it can't be changed here (bank, system), or null. */
  locked: string | null;
  /** Why it can't be removed though it can be edited (a simple-guess account), or null. */
  keep: string | null;
  /** Report lines it may move to (same type and normal side). */
  targets: Option[];
  /** Arsip akun: hidden from pickers and refused by the ledger until reactivated. */
  archived: boolean;
};
export type AccountSection = { key: string; title: string; rows: AccountRow[] };

/**
 * Bagan akun: every account by statement and report line, with *Tambah akun* (one primary button) and *Ubah* per row (name, report line,
 * Hapus while no journal line uses it, else *Arsipkan*); archived accounts in their own section with *Aktifkan lagi*. The server re-checks
 * everything and its refusal is shown verbatim.
 */
export function ChartOfAccounts({ clientId, sections, lines, proposed, canWrite, hasLocked, currency }: { clientId: string; sections: AccountSection[]; lines: Option[]; proposed: Record<string, string>; canWrite: boolean; hasLocked: boolean; currency: string }) {
  const [editing, setEditing] = useState<AccountRow | null>(null);
  return (
    <div className="space-y-6">
      {canWrite && (
        <div className="flex justify-end">
          <AddAccount clientId={clientId} lines={lines} proposed={proposed} />
        </div>
      )}
      {sections.map((s) => (
        <Card key={s.key} data-testid={`coa-${s.key}`}>
          <CardHeader>
            <CardTitle>{s.title}</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20 pl-6">Kode</TableHead>
                  <TableHead>Akun</TableHead>
                  <TableHead className="hidden w-12 text-center md:table-cell">Saldo normal</TableHead>
                  <TableHead className="hidden text-right md:table-cell">Baris jurnal</TableHead>
                  <TableHead className="text-right">Saldo</TableHead>
                  {canWrite && <TableHead className="w-24 pr-6"><span className="sr-only">Ubah</span></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.rows.map((r, i) => (
                  <TableRow key={r.id} data-testid="coa-row">
                    <TableCell className="num pl-6 align-top text-muted-foreground">{r.code}</TableCell>
                    <TableCell className="align-top whitespace-normal">
                      <Link href={r.href} className="drill">{r.name}</Link>
                      {(i === 0 || s.rows[i - 1].fsLine !== r.fsLine) && <span className="block text-xs text-muted-foreground">{r.fsLabel}</span>}
                      {r.locked && (
                        <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                          <Lock className="size-3" aria-hidden /> {r.locked.split(":")[0]}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="hidden text-center align-top text-muted-foreground md:table-cell">{r.side}</TableCell>
                    <TableCell className="num hidden text-right align-top text-muted-foreground md:table-cell">{r.lines ? r.lines.toLocaleString("id-ID") : "–"}</TableCell>
                    <TableCell className="text-right align-top">{r.balance === null ? "" : <Money value={BigInt(r.balance)} currency={currency} />}</TableCell>
                    {canWrite && (
                      <TableCell className="pr-6 text-right align-top">
                        {r.archived ? (
                          <Reactivate clientId={clientId} account={r} />
                        ) : !r.locked && (
                          <Button variant="ghost" size="sm" onClick={() => setEditing(r)} aria-label={`Ubah ${r.code} ${r.name}`}>
                            Ubah
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
      {editing && <EditAccount key={editing.id} clientId={clientId} account={editing} hasLocked={hasLocked} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Reactivate({ clientId, account }: { clientId: string; account: AccountRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={busy}
      aria-label={`Aktifkan lagi ${account.code} ${account.name}`}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await archiveAccountAction(clientId, account.id, false);
          if (!r.ok) return void toast.error(r.error);
          toast.success(`Akun ${account.code} ${account.name} aktif lagi`);
          router.refresh();
        } finally {
          setBusy(false);
        }
      }}
    >
      Aktifkan lagi
    </Button>
  );
}

function AddAccount({ clientId, lines, proposed }: { clientId: string; lines: Option[]; proposed: Record<string, string> }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [fsLine, setFsLine] = useState("");
  const [code, setCode] = useState("");
  const [codeTouched, setCodeTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const reset = () => {
    setName("");
    setFsLine("");
    setCode("");
    setCodeTouched(false);
  };
  async function save() {
    setBusy(true);
    try {
      const r = await createAccountAction(clientId, { name, fsLine, code: code.trim() || undefined });
      if (!r.ok) return void toast.error(r.error);
      toast.success(`Akun ${r.code} ${name.trim()} ditambahkan`);
      setOpen(false);
      reset();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus /> Tambah akun
      </Button>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Tambah akun</DialogTitle>
            <DialogDescription>Jenis dan saldo normal akun mengikuti pos laporannya. Kode diusulkan dari rentang pos itu; boleh diganti.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <label className="grid gap-1 text-sm">
              <span>Nama akun</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="mis. Beban Sewa Kendaraan" maxLength={80} />
            </label>
            <div className="grid gap-1 text-sm">
              <span id="new-account-line">Pos laporan</span>
              <SimpleSelect
                label="Pos laporan"
                value={fsLine}
                placeholder="Pilih pos laporan"
                onChange={(v) => {
                  setFsLine(v);
                  if (!codeTouched) setCode(proposed[v] ?? "");
                }}
                options={lines}
              />
            </div>
            <label className="grid gap-1 text-sm">
              <span>Kode akun</span>
              <Input value={code} inputMode="numeric" onChange={(e) => { setCode(e.target.value); setCodeTouched(true); }} placeholder="Pilih pos laporan dulu" className="num w-40" />
            </label>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Batal</Button>
            <Button onClick={save} disabled={busy || !name.trim() || !fsLine}>{busy ? "Menyimpan…" : "Simpan akun"}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function EditAccount({ clientId, account, hasLocked, onClose }: { clientId: string; account: AccountRow; hasLocked: boolean; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(account.name);
  const [fsLine, setFsLine] = useState(account.fsLine);
  const [busy, setBusy] = useState(false);
  const moved = fsLine !== account.fsLine;
  const done = (message: string) => {
    toast.success(message);
    onClose();
    router.refresh();
  };
  async function save() {
    setBusy(true);
    try {
      const r = await updateAccountAction(clientId, account.id, { name, fsLine });
      if (!r.ok) return void toast.error(r.error);
      done(`Akun ${account.code} disimpan`);
    } finally {
      setBusy(false);
    }
  }
  async function archive() {
    setBusy(true);
    try {
      const r = await archiveAccountAction(clientId, account.id, true);
      if (!r.ok) return void toast.error(r.error);
      done(`Akun ${account.code} ${account.name} diarsipkan`);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    try {
      const r = await removeAccountAction(clientId, account.id);
      if (!r.ok) return void toast.error(r.error);
      done(`Akun ${account.code} ${account.name} dihapus`);
    } finally {
      setBusy(false);
    }
  }
  const targets = account.targets.some((t) => t.value === account.fsLine) ? account.targets : [{ value: account.fsLine, label: account.fsLabel }, ...account.targets];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ubah akun {account.code}</DialogTitle>
          <DialogDescription>Kode, jenis dan saldo normal tidak berubah, jadi angka yang sudah dicatat tetap sama artinya.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1 text-sm">
            <span>Nama akun</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </label>
          <div className="grid gap-1 text-sm">
            <span>Pos laporan</span>
            <SimpleSelect label="Pos laporan" value={fsLine} onChange={setFsLine} options={targets} />
            {moved && (
              <p className="text-xs text-muted-foreground">
                Laporan menampilkan akun ini di pos baru{hasLocked && account.lines > 0 ? ", juga untuk bulan yang sudah ditutup" : ""}. Total aset, liabilitas, ekuitas dan laba bersih tidak berubah.
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          {account.keep ? (
            <span className="max-w-xs text-xs text-muted-foreground">{account.keep}</span>
          ) : (
            <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {account.lines === 0 ? (
                <Button variant="ghost" className="text-fail" onClick={remove} disabled={busy}>Hapus akun</Button>
              ) : (
                `Dipakai ${account.lines.toLocaleString("id-ID")} baris jurnal, jadi tidak bisa dihapus.`
              )}
              <Button variant="ghost" size="sm" onClick={archive} disabled={busy}>Arsipkan</Button>
            </span>
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>Batal</Button>
            <Button onClick={save} disabled={busy || !name.trim() || (name.trim() === account.name && !moved)}>{busy ? "Menyimpan…" : "Simpan"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
