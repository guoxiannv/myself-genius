import { useMemo, useState } from "react"
import { cn, formatTime } from "@/lib/format"
import type { ExpoClaudeTraceEvent, ExpoClaudeTraceGroup } from "@/lib/types"

type TraceBlock =
  | { id: string; kind: "assistant"; event: ExpoClaudeTraceEvent }
  | { id: string; kind: "actions"; events: ExpoClaudeTraceEvent[] }

function normalize(value: unknown): string {
  return String(value || "").trim().toLowerCase()
}

function groupStatus(group: ExpoClaudeTraceGroup) {
  const status = normalize(group.status)
  if (status === "failed") {
    return { label: "失败", dot: "bg-danger", text: "text-danger" }
  }
  if (status === "running") {
    return { label: "进行中", dot: "bg-accent", text: "text-muted" }
  }
  return { label: "已完成", dot: "bg-success", text: "text-subtle" }
}

function eventBadge(event: ExpoClaudeTraceEvent): string {
  if (event.kind === "action") return event.tool_name || "Action"
  if (event.kind === "session") return "Session"
  if (event.kind === "result") return "Result"
  return event.kind || "Event"
}

function buildTraceBlocks(group: ExpoClaudeTraceGroup): TraceBlock[] {
  const blocks: TraceBlock[] = []
  let pendingActions: ExpoClaudeTraceEvent[] = []

  const flushActions = () => {
    if (!pendingActions.length) return
    blocks.push({
      id: `${group.id}-actions-${blocks.length}`,
      kind: "actions",
      events: pendingActions,
    })
    pendingActions = []
  }

  group.events.forEach((event) => {
    if (event.kind === "assistant") {
      flushActions()
      blocks.push({ id: `${group.id}-assistant-${event.id}`, kind: "assistant", event })
      return
    }
    pendingActions.push(event)
  })
  flushActions()
  return blocks
}

function actionLabel(event: ExpoClaudeTraceEvent): string {
  const badge = eventBadge(event)
  const target = String(event.target || "").trim()
  if (target) return `${badge} · ${target}`
  return event.summary || badge
}

function assistantPreview(value: string): string {
  const compact = value
    .trim()
    .replace(/\*\*/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
  if (compact.length <= 280) return compact
  return `${compact.slice(0, 277).trimEnd()}…`
}

function lastActionBlockIndex(blocks: TraceBlock[]): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index].kind === "actions") return index
  }
  return -1
}

export function ExpoClaudeTraceGroups({
  groups,
  compact = false,
}: {
  groups: ExpoClaudeTraceGroup[]
  compact?: boolean
}) {
  const [expandedActions, setExpandedActions] = useState<Set<string>>(() => new Set())

  const groupedBlocks = useMemo(
    () => groups.map((group) => ({ group, blocks: buildTraceBlocks(group) })),
    [groups],
  )

  if (!groups.length) return null

  const toggleActions = (id: string) => {
    setExpandedActions((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <section className={cn(compact ? "mx-3 my-1" : "mx-2 mb-5")}>
      {!compact && (
        <div className="mb-4 flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-raised text-accent-soft">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">
              <path d="M12 3.5l1.55 4.28L18 9.33l-4.45 1.56L12 15.17l-1.55-4.28L6 9.33l4.45-1.55L12 3.5z" fill="currentColor" />
              <path d="M18.2 14.5l.78 2.14 2.12.78-2.12.78-.78 2.13-.77-2.13-2.13-.78 2.13-.78.77-2.14z" fill="currentColor" opacity=".7" />
            </svg>
          </span>
          <p className="text-xs text-muted">Agent 执行过程</p>
          <span className="text-[10px] text-subtle">{groups.length} 个会话</span>
        </div>
      )}

      <div className={cn(compact ? "space-y-4" : "space-y-6")}>
        {groupedBlocks.map(({ group, blocks }) => {
          const status = groupStatus(group)
          const running = normalize(group.status) === "running"
          const lastActionIndex = lastActionBlockIndex(blocks)

          return (
            <div key={group.id}>
              <div className="mb-3 flex items-center gap-2 text-[11px]">
                <span className={cn("h-1.5 w-1.5 rounded-full", status.dot, running && "live-dot")} />
                <span className="text-muted">{group.label}</span>
                <span className={status.text}>{status.label}</span>
                <span className="ml-auto text-[10px] text-subtle">
                  {group.action_count} 个操作 · {group.message_count} 条消息
                </span>
              </div>

              <div className="space-y-3 border-l border-border/80 pl-4">
                {blocks.length ? (
                  blocks.map((block, index) => {
                    if (block.kind === "assistant") {
                      return <AssistantMessage key={block.id} event={block.event} />
                    }
                    return (
                      <ActionDisclosure
                        key={block.id}
                        id={block.id}
                        events={block.events}
                        active={running && index === lastActionIndex}
                        open={expandedActions.has(block.id)}
                        onToggle={() => toggleActions(block.id)}
                      />
                    )
                  })
                ) : (
                  <ThinkingState />
                )}
              </div>

              {group.truncated && (
                <p className="mt-2 pl-4 text-[10px] text-subtle">仅显示最近 {group.events.length} 条记录</p>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function AssistantMessage({ event }: { event: ExpoClaudeTraceEvent }) {
  return (
    <article className="max-w-[94%] py-1">
      <p className="whitespace-pre-wrap break-words text-[13px] leading-6 text-foreground">
        {assistantPreview(event.summary)}
      </p>
      <time className="mt-1 block text-[9px] tabular-nums text-subtle">{formatTime(event.timestamp)}</time>
    </article>
  )
}

function ActionDisclosure({
  id,
  events,
  active,
  open,
  onToggle,
}: {
  id: string
  events: ExpoClaudeTraceEvent[]
  active: boolean
  open: boolean
  onToggle: () => void
}) {
  const latest = events[events.length - 1]
  const panelId = `${id}-details`
  const failed = events.some((event) => event.kind === "result" && normalize(event.status) === "failed")

  return (
    <div className="max-w-[96%]">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className="group flex w-full items-center gap-2 rounded-lg py-1.5 pr-1 text-left text-xs text-subtle transition-colors hover:text-muted"
      >
        <ActionStateIcon active={active} failed={failed} />
        <span className={cn("min-w-0 flex-1 truncate", active && "trace-action-wave")}>
          {active ? "正在执行" : failed ? "操作失败" : "已执行"}
          <span className={cn("ml-1.5", active ? "text-inherit" : "text-muted")}>{actionLabel(latest)}</span>
        </span>
        {events.length > 1 && <span className="shrink-0 text-[10px] text-subtle">{events.length} 步</span>}
        <svg
          viewBox="0 0 24 24"
          width="13"
          height="13"
          fill="none"
          aria-hidden="true"
          className={cn("shrink-0 transition-transform group-hover:text-foreground", open && "rotate-180")}
        >
          <path d="M7 10l5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <ol id={panelId} className="mt-1 overflow-hidden rounded-xl border border-border/80 bg-surface/35 px-3">
          {events.map((event) => (
            <ActionDetail key={event.id} event={event} />
          ))}
        </ol>
      )}
    </div>
  )
}

function ActionStateIcon({ active, failed }: { active: boolean; failed: boolean }) {
  if (active) {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-label="进行中">
        <svg viewBox="0 0 20 20" width="14" height="14" fill="none" aria-hidden="true" className="animate-spin text-subtle">
          <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="2" opacity=".25" />
          <path d="M10 3a7 7 0 0 1 6.55 4.55" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
    )
  }

  return (
    <span
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
        failed ? "bg-danger/10 text-danger" : "bg-surface-raised text-subtle",
      )}
      aria-label={failed ? "失败" : "已完成"}
    >
      {failed ? (
        <svg viewBox="0 0 16 16" width="9" height="9" fill="none" aria-hidden="true">
          <path d="M5 5l6 6M11 5l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="9" height="9" fill="none" aria-hidden="true">
          <path d="M4 8.2l2.4 2.3L12 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  )
}

function ActionDetail({ event }: { event: ExpoClaudeTraceEvent }) {
  const failed = event.kind === "result" && normalize(event.status) === "failed"
  return (
    <li className="flex items-start gap-2.5 border-b border-border/60 py-2.5 last:border-b-0">
      <span
        className={cn(
          "mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] leading-4 uppercase tracking-wide",
          failed ? "bg-danger/10 text-danger" : "bg-surface-raised text-subtle",
        )}
      >
        {eventBadge(event)}
      </span>
      <p className={cn("min-w-0 flex-1 break-words text-xs leading-5", failed ? "text-danger" : "text-muted")}>
        {event.summary}
      </p>
      <time className="shrink-0 pt-0.5 text-[10px] leading-4 tabular-nums text-subtle">{formatTime(event.timestamp)}</time>
    </li>
  )
}

function ThinkingState() {
  return (
    <div className="flex items-center gap-2 py-1.5 text-[11px] text-subtle">
      <ActionStateIcon active failed={false} />
      <span>Genius 正在思考</span>
      <span className="flex items-center gap-0.5" aria-hidden="true">
        <span className="generation-dot h-1 w-1 rounded-full bg-subtle" />
        <span className="generation-dot h-1 w-1 rounded-full bg-subtle" />
        <span className="generation-dot h-1 w-1 rounded-full bg-subtle" />
      </span>
    </div>
  )
}
