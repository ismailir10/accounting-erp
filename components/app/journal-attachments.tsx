"use client";

import { useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { addAttachmentsAction, removeAttachmentAction } from "@/app/actions";

export type AttachmentView = { id: string; fileName: string; size: number };

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB`);

/**
 * A journal's lampiran (lib/ledger/attachments.ts): each file downloads; a writer adds files (PDF, JPG, PNG up to 5 MB) and removes one
 * while the month is open — the server refuses a closed month with the reason, shown as a toast.
 */
export function JournalAttachments({ clientId, entryId, files, canWrite, label }: { clientId: string; entryId: string; files: AttachmentView[]; canWrite: boolean; label: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  if (!files.length && !canWrite) return null;
  const upload = (list: FileList | null) => {
    if (!list?.length) return;
    const form = new FormData();
    form.set("clientId", clientId);
    form.set("entryId", entryId);
    for (const f of Array.from(list)) form.append("files", f);
    start(async () => {
      const r = await addAttachmentsAction(form);
      if (input.current) input.current.value = "";
      if (!r.ok) return void toast.error(r.error);
      toast.success(r.added === 1 ? "Lampiran ditambahkan" : `${r.added} lampiran ditambahkan`);
      router.refresh();
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-testid="journal-attachments">
      {files.map((f) => (
        <span key={f.id} className="inline-flex items-center gap-1">
          <Paperclip className="size-3 text-muted-foreground" aria-hidden />
          <a href={`/clients/${clientId}/journals/lampiran/${f.id}`} download className="drill" data-testid="attachment-link">{f.fileName}</a>
          <span className="text-muted-foreground">{kb(f.size)}</span>
          {canWrite && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Hapus lampiran ${f.fileName}`}
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await removeAttachmentAction(clientId, f.id);
                  if (!r.ok) return void toast.error(r.error);
                  toast.success("Lampiran dihapus");
                  router.refresh();
                })
              }
            >
              <X />
            </Button>
          )}
        </span>
      ))}
      {canWrite && (
        <>
          <input ref={input} type="file" multiple accept="application/pdf,image/jpeg,image/png" className="sr-only" aria-label={`Lampiran untuk ${label}`} onChange={(e) => upload(e.target.files)} />
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" disabled={pending} onClick={() => input.current?.click()}>
            <Paperclip /> {pending ? "Mengunggah…" : "Lampirkan bukti"}
          </Button>
        </>
      )}
    </div>
  );
}
