"use client";

import type { ReactNode, RefObject } from "react";
import { toast } from "sonner";
import { Copy, Send } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";

/**
 * *Salin pesan* and *Kirim lewat WhatsApp* for a message the accountant edited (Minta data, Pengingat tagihan). Buku sends nothing: the
 * `wa.me` link carries no number, so the sender picks the chat. When the clipboard is blocked the message is selected in its textarea
 * instead. Extra actions (outline or ghost, never primary) follow in the same row.
 */
export function ShareMessageActions({ text, textarea, children }: { text: string; textarea: RefObject<HTMLTextAreaElement | null>; children?: ReactNode }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Pesan tersalin");
    } catch {
      textarea.current?.select();
      toast.message("Pesan sudah dipilih: tekan Ctrl+C untuk menyalin");
    }
  };
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={copy}>
        <Copy /> Salin pesan
      </Button>
      <a className={buttonVariants({ variant: "outline" })} href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener noreferrer">
        <Send /> Kirim lewat WhatsApp
      </a>
      {children}
    </div>
  );
}
