"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { Link2 } from "lucide-react";
import { createUploadLinkAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ShareMessageActions } from "@/components/app/share-message";

/**
 * Permintaan data ke klien (I1a): the message built from the completeness grid, ready to copy or open in WhatsApp. Nothing is sent by
 * Buku; the accountant picks the contact. Editable before copying, so the firm's own tone stays.
 */
export function DataRequestCard({ message, items, clientId, canLink = false }: { message: string; items: number; clientId?: string; canLink?: boolean }) {
  const router = useRouter();
  const [text, setText] = useState(message);
  const [linking, setLinking] = useState(false);
  const [linked, setLinked] = useState(false);
  // One message the client can answer (I1d): the upload link goes into the request itself, before the sign-off.
  const addLink = async () => {
    if (!clientId) return;
    setLinking(true);
    const r = await createUploadLinkAction(clientId, 14);
    setLinking(false);
    if (!r.ok) return toast.error(r.error);
    const block = `File bisa langsung diunggah di tautan ini, tanpa perlu akun (berlaku sampai ${r.expires}):\n${r.url}`;
    const at = text.lastIndexOf("\nTerima kasih");
    setText(at >= 0 ? `${text.slice(0, at)}\n${block}\n${text.slice(at)}` : `${text}\n\n${block}`);
    setLinked(true);
    toast.success("Tautan unggah ditambahkan ke pesan");
    router.refresh();
  };
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <Card data-testid="data-request">
      <CardHeader>
        <CardTitle>Minta data yang kurang ke klien</CardTitle>
        <CardDescription>
          {items} hal masih kurang. Pesan ini dibuat dari tabel kelengkapan; ubah bila perlu, lalu kirim ke kontak klien.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(14, text.split("\n").length + 1)} className="font-mono text-xs" aria-label="Pesan permintaan data" />
        <ShareMessageActions text={text} textarea={ref}>
          {canLink && clientId && !linked && (
            <Button variant="ghost" disabled={linking} onClick={addLink}>
              <Link2 /> Sisipkan tautan unggah
            </Button>
          )}
        </ShareMessageActions>
      </CardContent>
    </Card>
  );
}
