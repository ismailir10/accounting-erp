"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { clearInboxKeyringAction } from "@/app/inbox-actions";

/** Admin-only (ADR 0018): how many PDF passwords the client's keyring holds, and a way to forget them. Never shows a password. */
export function PdfKeyringCard({ clientId, count }: { clientId: string; count: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function clear() {
    setBusy(true);
    const r = await clearInboxKeyringAction(clientId);
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success("Kata sandi PDF klien ini dihapus");
    router.refresh();
  }
  return (
    <Card data-testid="pdf-keyring">
      <CardHeader>
        <CardTitle>Kata sandi PDF</CardTitle>
        <CardDescription>
          {count > 0
            ? `${count} kata sandi tersimpan untuk klien ini. Dipakai untuk membuka rekening koran terkunci saat diunggah.`
            : "Belum ada kata sandi tersimpan."}
        </CardDescription>
        {count > 0 && (
          <CardAction>
            <AlertDialog>
              <AlertDialogTrigger render={<Button variant="outline" size="sm" disabled={busy} />}>Hapus semua</AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Hapus {count} kata sandi PDF?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Rekening koran terkunci berikutnya akan meminta kata sandinya lagi saat diunggah. Buku dan file yang sudah diunggah tidak berubah.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Batal</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={clear}>Hapus semua</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </CardAction>
        )}
      </CardHeader>
    </Card>
  );
}
