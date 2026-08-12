import { cn } from "@/lib/format"

type Tone = "waiting" | "running" | "ready" | "failed" | "neutral"

const TONE_STYLES: Record<Tone, string> = {
  waiting: "bg-surface-raised text-muted border-border",
  running: "bg-accent/10 text-accent-soft border-accent/30",
  ready: "bg-success/10 text-success border-success/30",
  failed: "bg-danger/10 text-danger border-danger/30",
  neutral: "bg-surface-raised text-foreground border-border",
}

export function statusToTone(status: string): Tone {
  const s = status.toLowerCase()
  if (["succeeded", "ready", "install_ready", "complete"].includes(s)) return "ready"
  if (["failed", "error"].includes(s)) return "failed"
  if (["running", "packaging", "building", "active"].includes(s)) return "running"
  if (["waiting", "waiting_hap", "queued"].includes(s)) return "waiting"
  return "neutral"
}

interface StatusBadgeProps {
  children: React.ReactNode
  tone?: Tone
  pulse?: boolean
  className?: string
}

export function StatusBadge({ children, tone = "neutral", pulse, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        TONE_STYLES[tone],
        className,
      )}
    >
      {pulse && (
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            tone === "ready" ? "bg-success" : tone === "failed" ? "bg-danger" : "bg-accent",
            tone === "running" && "live-dot",
          )}
        />
      )}
      {children}
    </span>
  )
}
