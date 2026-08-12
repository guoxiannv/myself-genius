import { Timeline } from "@/components/detail/Timeline"
import { ExpoClaudeTraceGroups } from "@/components/detail/ExpoClaudeTraceGroups"
import { ExpoServeControl } from "@/components/detail/ExpoServeControl"
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
  const packageWaiting = normalize(data.expo?.package?.status) === "not_implemented"
  const statusLabel = packageWaiting
    ? "等待打包实现"
    : failed
      ? "运行失败"
      : state?.detailLabel || state?.label || "正在启动"

  return (
    <div className="flex h-[clamp(460px,calc(100vh-190px),680px)] min-w-0 flex-col overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface/60">
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
            failed
              ? "border-danger/30 bg-danger/10 text-danger"
              : packageWaiting
                ? "border-warning/30 bg-warning/10 text-warning"
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

        <ExpoServeControl runId={data.run.run_id} value={data.expo?.serve} />

        <ExpoClaudeTraceGroups groups={data.expo?.trace_groups || []} />

        {packageWaiting && (
          <div className="mx-5 mb-4 rounded-xl border border-warning/25 bg-warning/5 px-3.5 py-3 text-xs leading-relaxed text-warning">
            Expo 代码生成、验证与启动已经结束。打包、签名和发布流程暂为空实现，当前进度停留在 80%。
          </div>
        )}
      </div>
    </div>
  )
}
