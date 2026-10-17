import { CircleCheck, CircleAlert, CircleX } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ControlStatus } from "@/lib/controls";

const MAP: Record<ControlStatus, { label: string; icon: typeof CircleCheck; text: string; fill: string }> = {
  PASS: { label: "Lolos", icon: CircleCheck, text: "text-pass", fill: "" },
  REVIEW: { label: "Perlu dicek", icon: CircleAlert, text: "text-review", fill: "" },
  FAIL: { label: "Gagal", icon: CircleX, text: "text-fail", fill: "bg-fail-subtle px-2" },
};

/** Status always carries icon + label — never colour alone. Only a failure gets a fill: it blocks, the rest just reads. */
export function StatusPill({ status, label, className, iconOnly = false }: { status: ControlStatus; label?: string; className?: string; iconOnly?: boolean }) {
  const s = MAP[status];
  const Icon = s.icon;
  // `iconOnly`: inside a list whose header already says the state, the shape carries it and the word is for screen readers.
  if (iconOnly) return <Icon className={cn("size-4 shrink-0", s.text, className)} role="img" aria-label={label ?? s.label} />;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full py-0.5 font-sans text-xs font-medium", s.text, s.fill, className)}>
      <Icon className="size-3.5" aria-hidden />
      {label ?? s.label}
    </span>
  );
}

export function MethodBadge({ method }: { method: string }) {
  const labels: Record<string, [string, string]> = {
    TRANSFER: ["Transfer", "bg-secondary text-secondary-foreground"],
    RULE: ["Aturan", "bg-secondary text-secondary-foreground"],
    MEMORY: ["Diingat", "bg-secondary text-secondary-foreground"],
    AI: ["AI", "bg-primary-subtle text-primary"],
    HEURISTIC: ["Tebakan", "bg-review-subtle text-review"],
    MANUAL: ["Manual", "bg-muted text-muted-foreground"],
    // Kotak persetujuan: where a proposal that isn't a bank classification comes from
    SCHEDULE: ["Jadwal", "bg-secondary text-secondary-foreground"],
    CORETAX: ["Coretax", "bg-secondary text-secondary-foreground"],
    SUSPENSE: ["Koreksi 1999", "bg-secondary text-secondary-foreground"],
    // Account mapping (ledger import)
    PRIOR: ["Sebelumnya", "bg-secondary text-secondary-foreground"],
    NAME: ["Nama sama", "bg-secondary text-secondary-foreground"],
    KEYWORD: ["Aturan", "bg-secondary text-secondary-foreground"],
    NEW: ["Akun baru", "bg-muted text-muted-foreground"],
  };
  const [label, cls] = labels[method] ?? [method, "bg-muted"];
  return <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium", cls)}>{label}</span>;
}
