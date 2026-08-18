import { Timeline } from "@/components/detail/Timeline"
import { ExpoClaudeTraceGroups } from "@/components/detail/ExpoClaudeTraceGroups"
import { cn, formatDateTime } from "@/lib/format"
import type { RunProgress } from "@/lib/types"

function normalize(value: unknown): string {
  return String(value || "").trim().toLowerCase()
}

export function ExpoRunPanel({ data }: { data: RunProgress }) {
  const state = data.expo?.state
  const stateName = normalize(state?.state)
  const completed = stateName === "completed"
  const failed = stateName === "failed" || normalize(data.status) === "failed"
  const running = !completed && !failed
  const packageStatus = normalize(data.expo?.package?.status)
  const hapReady = packageStatus === "ready" && Boolean(data.artifacts.hap_download_path)
  const hapFailed = packageStatus === "failed"
  const statusLabel = failed
    ? "运行失败"
    : hapFailed
      ? "HAP 构建失败"
      : hapReady
        ? "bundle 与 HAP 已就绪"
        : data.expo?.package?.label || state?.detailLabel || state?.label || "正在启动"

  return (
    <div className="flex h-[clamp(360px,52vh,520px)] min-w-0 flex-col overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface/60">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-5 py-3.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent/15 text-accent-soft">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
            <path d="M5 5h14v14H5zM8 9h8M8 13h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <div>
          <p className="text-sm font-semibold text-foreground">Expo Runtime 状态</p>
          {state?.startedAt && (
            <p className="mt-0.5 text-[10px] text-subtle">启动于 {formatDateTime(state.startedAt)}</p>
          )}
        </div>
        <span
          className={cn(
            "ml-auto inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
            failed || hapFailed
              ? "border-danger/30 bg-danger/10 text-danger"
              : hapReady
                ? "border-success/30 bg-success/10 text-success"
                : "border-accent/30 bg-accent/10 text-accent-soft",
          )}
        >
          {running && <span className="live-dot h-1.5 w-1.5 rounded-full bg-accent" />}
          {statusLabel}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mb-4 flex justify-end px-1">
          <div className="max-w-[88%] rounded-2xl rounded-br-md border border-accent/30 bg-accent/10 px-3.5 py-2.5 text-accent-soft">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-accent/80">
              Expo Build Prompt
            </div>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{data.run.prompt}</p>
          </div>
        </div>

        <Timeline events={data.events || []} running={running} />

        <ExpoClaudeTraceGroups groups={data.expo?.trace_groups || []} />
      </div>
    </div>
  )
}
