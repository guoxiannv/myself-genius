import { formatTime } from "@/lib/format"
import type { TimelineEvent } from "@/lib/types"

export function Timeline({ events, running }: { events: TimelineEvent[]; running: boolean }) {
  if (!events.length) {
    return (
      <div className="px-5 py-8 text-center">
        <div className="mx-auto mb-3 h-8 w-8 animate-pulse rounded-full bg-accent/15" />
        <p className="text-sm text-muted">后端已启动，等待出现首个状态…</p>
      </div>
    )
  }

  return (
    <ol className="relative px-5 py-4">
      <span className="absolute bottom-6 left-[1.65rem] top-6 w-px bg-border" aria-hidden="true" />
      {events.map((event, i) => {
        const isLatest = i === events.length - 1
        return (
          <li key={`${event.timestamp}-${i}`} className="relative flex gap-4 pb-5 last:pb-0">
            <span
              className={[
                "relative z-10 mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full ring-4 ring-surface",
                isLatest && running ? "bg-accent live-dot" : "bg-border-strong",
              ].join(" ")}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-surface-raised px-1.5 py-0.5 text-[11px] font-medium text-muted">
                  {event.kind || "event"}
                </span>
                <time className="text-[11px] text-subtle">{formatTime(event.timestamp)}</time>
              </div>
              <p className="mt-1 text-sm leading-relaxed text-foreground">{event.summary}</p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
