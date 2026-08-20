import { useEffect, useRef, useState } from "react"
import { api } from "@/lib/api"
import { cn } from "@/lib/format"
import type {
  FollowUpCommand,
  FollowUpState,
  FollowUpTraceEvent,
  TimelineEvent,
} from "@/lib/types"

interface FollowUpPanelProps {
  runId: string | undefined
  initialPrompt: string
  initialPromptAt?: string
  events: TimelineEvent[]
  initialBuildReady: boolean
  buildRunning: boolean
  followUp: FollowUpState | undefined
  trace?: FollowUpTraceEvent[]
  className?: string
  /** 演示模式：不实际请求后端 Agent。 */
  mock?: boolean
}

interface ConversationRecord {
  id: string
  prompt: string
  outcome: "completed" | "interrupted" | "failed"
  createdAt?: string
  completedAt?: string
}

function conversationOutcome(status: string): ConversationRecord["outcome"] | null {
  if (status === "completed" || status === "interrupted" || status === "failed") return status
  return null
}

const mockFollowUp: FollowUpState = {
  status: "idle",
  queue_length: 0,
  queue: [],
  active_command: null,
  interrupt_command: null,
}

function requestId() {
  return globalThis.crypto?.randomUUID?.() || `follow-up-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/**
 * Runtime follow-up-control 的 UI。
 *
 * 队列、FIFO 调度、中断确认都由后端控制；本组件只提交命令并渲染
 * follow_up 状态镜像，绝不直接写状态文件或向 tmux 发送按键。
 */
export function FollowUpPanel({
  runId,
  initialPrompt,
  initialPromptAt,
  events,
  initialBuildReady,
  buildRunning,
  followUp,
  trace = [],
  className,
  mock,
}: FollowUpPanelProps) {
  const [message, setMessage] = useState("")
  const [promptByRequestId, setPromptByRequestId] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<FollowUpState | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [interrupting, setInterrupting] = useState(false)
  const [editingCommandId, setEditingCommandId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState("")
  const [queueActionId, setQueueActionId] = useState<string | null>(null)
  const mockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previousActiveRef = useRef<FollowUpCommand | null>(null)
  const conversationRef = useRef<HTMLDivElement | null>(null)
  const stickToLatestRef = useRef(true)
  const [history, setHistory] = useState<ConversationRecord[]>([])
  const [showLatestButton, setShowLatestButton] = useState(false)

  useEffect(() => {
    if (followUp) setSnapshot(null)
  }, [followUp?.updated_at, followUp?.status])

  // 控制器的公开队列不返回正文；只缓存本浏览器提交过的 prompt，刷新当前标签页后仍可展示。
  useEffect(() => {
    if (!runId || typeof window === "undefined") return
    try {
      const saved = window.sessionStorage.getItem(`harmony-follow-up-prompts:${runId}`)
      setPromptByRequestId(saved ? JSON.parse(saved) as Record<string, string> : {})
    } catch {
      setPromptByRequestId({})
    }
  }, [runId])

  useEffect(() => {
    if (!runId || typeof window === "undefined") return
    try {
      const saved = window.sessionStorage.getItem(`harmony-follow-up-history:${runId}`)
      setHistory(saved ? JSON.parse(saved) as ConversationRecord[] : [])
    } catch {
      setHistory([])
    }
  }, [runId])

  useEffect(() => {
    if (!runId || typeof window === "undefined") return
    try {
      window.sessionStorage.setItem(`harmony-follow-up-history:${runId}`, JSON.stringify(history.slice(-12)))
    } catch {
      // 会话记录无法持久化时，不影响续跑控制本身。
    }
  }, [history, runId])

  useEffect(() => {
    const remoteHistory = followUp?.history || []
    if (!remoteHistory.length) return
    setHistory((items) => {
      const localById = new Map(items.map((item) => [item.id, item]))
      for (const command of remoteHistory) {
        const outcome = conversationOutcome(command.status)
        // cancelled 代表用户主动从待处理队列删除，不应作为一轮已执行对话展示。
        if (!outcome) {
          localById.delete(command.id)
          continue
        }
        if (!command.text) continue
        localById.set(command.id, {
          id: command.id,
          prompt: command.text,
          outcome,
          createdAt: command.created_at,
          completedAt: command.completed_at || command.interrupted_at || undefined,
        })
      }
      return [...localById.values()].slice(-12)
    })
  }, [followUp?.history, followUp?.updated_at])

  useEffect(() => {
    if (!runId || typeof window === "undefined") return
    try {
      window.sessionStorage.setItem(`harmony-follow-up-prompts:${runId}`, JSON.stringify(promptByRequestId))
    } catch {
      // 存储不可用时仍可正常提交，只是不跨刷新保留正文。
    }
  }, [promptByRequestId, runId])

  useEffect(() => () => {
    if (mockTimerRef.current) clearTimeout(mockTimerRef.current)
  }, [])

  // 本地模拟按与真实控制器一致的 FIFO 方式完成当前命令并派发下一条。
  useEffect(() => {
    if (!mock || snapshot?.status !== "running" || !snapshot.active_command) return
    const timer = setTimeout(() => {
      setSnapshot((current) => {
        const queued = current?.queue || []
        const [next, ...remaining] = queued
        if (!next) return mockFollowUp
        return {
          ...current,
          status: "running",
          active_command: { ...next, status: "running" },
          active_command_id: next.id,
          queue: remaining,
          queue_length: remaining.length,
        }
      })
    }, 2600)
    return () => clearTimeout(timer)
  }, [mock, snapshot?.active_command?.id, snapshot?.status])

  const state = mock ? snapshot || mockFollowUp : snapshot || followUp
  const status = state?.status || "unavailable"
  const active = state?.active_command
  const queue = state?.queue || []
  const controllerReady = status === "idle" || status === "running"
  const isReady = initialBuildReady && controllerReady
  const isBusy = status === "running" || status === "interrupting"
  const canInterrupt = status === "running" && active?.type === "message"
  const showStopState = canInterrupt || status === "interrupting"
  const displayStatus = initialBuildReady ? status : buildRunning ? "building" : "preparing"
  const latestEvent = events[events.length - 1]
  const latestTrace = trace[trace.length - 1]
  const conversationVersion = [
    latestEvent?.timestamp,
    latestEvent?.summary,
    latestTrace?.timestamp,
    latestTrace?.summary,
  ].join("|")

  useEffect(() => {
    const previous = previousActiveRef.current
    // 真实模式以控制器 history 为准，不能把一个刚从 active 消失的 running 命令猜成 completed。
    if (mock && previous?.type === "message" && previous.id !== active?.id) {
      const prompt = promptByRequestId[previous.client_request_id]
      if (prompt) {
        setHistory((items) => items.some((item) => item.id === previous.id) ? items : [
          ...items,
          { id: previous.id, prompt, outcome: conversationOutcome(previous.status) || "completed" },
        ])
      }
    }
    previousActiveRef.current = active || null
  }, [active, mock, promptByRequestId])

  const scrollToLatest = (behavior: ScrollBehavior = "smooth") => {
    const container = conversationRef.current
    if (!container) return
    stickToLatestRef.current = true
    setShowLatestButton(false)
    container.scrollTo({ top: container.scrollHeight, behavior })
  }

  const onConversationScroll = () => {
    const container = conversationRef.current
    if (!container) return
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    const atLatest = distanceFromBottom < 72
    stickToLatestRef.current = atLatest
    setShowLatestButton(!atLatest)
  }

  useEffect(() => {
    if (!stickToLatestRef.current) {
      setShowLatestButton(true)
      return
    }
    const frame = requestAnimationFrame(() => scrollToLatest("auto"))
    return () => cancelAnimationFrame(frame)
  }, [
    active?.id,
    conversationVersion,
    events.length,
    history.length,
    queue.length,
    status,
    trace.length,
  ])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const text = message.trim()
    if (!runId || !text || !isReady || submitting) return
    setError(null)
    setSubmitting(true)
    try {
      if (mock) {
        const current = snapshot || mockFollowUp
        const existing = [current.active_command, ...current.queue].filter(Boolean) as FollowUpCommand[]
        const clientMessageId = requestId()
        const command: FollowUpCommand = {
          id: requestId(), client_request_id: clientMessageId, type: "message", status: "running",
          sequence: Math.max(0, ...existing.map((item) => item.sequence)) + 1, created_at: new Date().toISOString(),
        }
        setPromptByRequestId((currentPrompts) => ({ ...currentPrompts, [clientMessageId]: text }))
        if (current.status === "running" && current.active_command) {
          setSnapshot({
            ...current,
            queue_length: current.queue.length + 1,
            queue: [...current.queue, { ...command, status: "queued" }],
          })
        } else {
          setSnapshot({ ...mockFollowUp, status: "running", active_command: command, active_command_id: command.id })
        }
      } else {
        const clientMessageId = requestId()
        const result = await api.enqueueFollowUp(runId, text, clientMessageId)
        setPromptByRequestId((currentPrompts) => ({ ...currentPrompts, [result.command.client_request_id || clientMessageId]: text }))
        setSnapshot(result.follow_up)
      }
      setMessage("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败")
    } finally {
      setSubmitting(false)
    }
  }

  const interrupt = async () => {
    if (!runId || !canInterrupt || interrupting) return
    setError(null)
    setInterrupting(true)
    try {
      if (mock) {
        setSnapshot((current) => current ? { ...current, status: "interrupting" } : current)
        mockTimerRef.current = setTimeout(() => {
          setSnapshot((current) => {
            const queued = current?.queue || []
            const [next, ...remaining] = queued
            if (!next) return mockFollowUp
            return {
              ...current,
              status: "running",
              active_command: { ...next, status: "running" },
              active_command_id: next.id,
              queue: remaining,
              queue_length: remaining.length,
            }
          })
        }, 600)
      } else {
        const result = await api.interruptFollowUp(runId, requestId())
        setSnapshot(result.follow_up)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "中断请求失败")
    } finally {
      setInterrupting(false)
    }
  }

  const startEdit = (command: FollowUpCommand) => {
    setError(null)
    setEditingCommandId(command.id)
    setEditingText(promptByRequestId[command.client_request_id] || "")
  }

  const saveEdit = async (command: FollowUpCommand) => {
    const text = editingText.trim()
    if (!runId || !text || queueActionId) return
    setError(null)
    setQueueActionId(command.id)
    try {
      if (mock) {
        setSnapshot((current) => current ? {
          ...current,
          queue: current.queue.map((item) =>
            item.id === command.id ? { ...item, text } : item
          ),
        } : current)
      } else {
        const result = await api.updateQueuedFollowUp(runId, command.id, text)
        setSnapshot(result.follow_up)
      }
      setPromptByRequestId((current) => ({ ...current, [command.client_request_id]: text }))
      setEditingCommandId(null)
      setEditingText("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新队列项失败")
    } finally {
      setQueueActionId(null)
    }
  }

  const removeQueueItem = async (command: FollowUpCommand) => {
    if (!runId || queueActionId) return
    setError(null)
    setQueueActionId(command.id)
    try {
      if (mock) {
        setSnapshot((current) => current ? {
          ...current,
          queue: current.queue.filter((item) => item.id !== command.id),
          queue_length: Math.max(0, current.queue_length - 1),
        } : current)
      } else {
        const result = await api.removeQueuedFollowUp(runId, command.id)
        setSnapshot(result.follow_up)
      }
      setPromptByRequestId((current) => {
        const next = { ...current }
        delete next[command.client_request_id]
        return next
      })
      if (editingCommandId === command.id) {
        setEditingCommandId(null)
        setEditingText("")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除队列项失败")
    } finally {
      setQueueActionId(null)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      void submit(event as unknown as React.FormEvent)
    }
  }

  return (
    <div className={cn("flex h-[clamp(460px,calc(100vh-190px),680px)] min-w-0 flex-col overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface/60", className)}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-5 py-3.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent/15 text-accent-soft">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
            <path d="M8 9h8M8 13h5M5 4h14v14H9l-4 3V4Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <div>
          <p className="text-sm font-semibold text-foreground">Agent 构建会话</p>
        </div>
        <StatusPill status={displayStatus} />
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={conversationRef}
          onScroll={onConversationScroll}
          className="h-full overscroll-contain overflow-y-auto px-4 py-4 pr-3"
        >
          <div className="space-y-3">
            {initialPrompt && (
              <UserBubble
                text={initialPrompt}
                label="Build Prompt"
                timestamp={initialPromptAt || events[0]?.timestamp}
              />
            )}

            {events.map((event, index) => (
              <AgentEventBubble
                key={`${event.kind}-${event.timestamp || "event"}-${index}`}
                event={event}
                running={buildRunning && index === events.length - 1}
              />
            ))}

            {buildRunning && !initialBuildReady && <GenerationPendingIndicator />}

            {history.map((item) => (
              <ConversationHistory
                key={item.id}
                item={item}
                trace={traceInWindow(trace, item.createdAt, item.completedAt)}
              />
            ))}

            {active && (
              <>
                <CommandCard
                  command={active}
                  prompt={promptByRequestId[active.client_request_id]}
                  active
                  stopping={status === "interrupting"}
                />
                <FollowUpTrace
                  trace={traceInWindow(trace, active.created_at)}
                  running={status === "running"}
                  fallbackTimestamp={active.created_at}
                />
              </>
            )}

            {queue.length > 0 && (
              <div className="space-y-1.5 border-t border-border/70 pt-3">
                <div className="flex justify-end px-3 text-[11px] font-medium text-subtle">
                  等待处理 {queue.length} 项
                </div>
                {queue.map((command, index) => (
                  <CommandCard
                    key={command.id}
                    command={command}
                    prompt={promptByRequestId[command.client_request_id]}
                    queuePosition={index + 1}
                    editing={editingCommandId === command.id}
                    editingText={editingText}
                    busy={queueActionId === command.id}
                    onEdit={() => startEdit(command)}
                    onEditingTextChange={setEditingText}
                    onSave={() => void saveEdit(command)}
                    onCancel={() => { setEditingCommandId(null); setEditingText("") }}
                    onRemove={() => void removeQueueItem(command)}
                  />
                ))}
              </div>
            )}

            {initialBuildReady && status === "starting" && (
              <AgentNotice running timestamp={state?.updated_at}>续跑会话准备中，正在连接 ArkPilot…</AgentNotice>
            )}
            {initialBuildReady && status === "interrupting" && (
              <AgentNotice timestamp={state?.updated_at}>正在停止当前调整，确认后即可继续输入。</AgentNotice>
            )}
            {mock && <AgentNotice timestamp={state?.updated_at}>本地模拟模式：不会调用 ArkPilot 或修改应用代码。</AgentNotice>}
            {initialBuildReady && status === "unavailable" && (
              <AgentNotice tone="danger" timestamp={state?.updated_at}>
                {state?.last_error || "续跑会话暂不可用，请稍后刷新。"}
              </AgentNotice>
            )}
            {error && <AgentNotice tone="danger" timestamp={state?.updated_at}>{error}</AgentNotice>}
          </div>
        </div>

        {showLatestButton && (
          <button
            type="button"
            onClick={() => scrollToLatest()}
            className="absolute bottom-3 right-5 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-foreground shadow-lg shadow-black/30 hover:border-accent/40"
          >
            回到最新
            <span aria-hidden="true">↓</span>
          </button>
        )}
      </div>

      <form onSubmit={submit} className="min-w-0 shrink-0 border-t border-border bg-surface/90 px-4 py-3">
        <div className="relative">
          <textarea
            value={message}
            onChange={(event) => { setError(null); setMessage(event.target.value) }}
            onKeyDown={onKeyDown}
            rows={3}
            disabled={!isReady || submitting}
            placeholder={
              isReady
                ? "描述你希望继续调整的内容，例如：把首页主色改成蓝色、再加一个设置页…"
                : !initialBuildReady
                  ? "首版本自动签名并生成安装二维码后可继续调整…"
                  : status === "starting"
                    ? "续跑会话准备中…"
                    : status === "interrupting"
                      ? "正在停止当前调整，完成后可继续输入…"
                      : "续跑会话暂不可用"
            }
            className={cn(
              "w-full resize-none rounded-xl border bg-surface/60 px-3.5 pb-10 pt-2.5 pr-14 text-sm text-foreground placeholder:text-subtle focus:outline-none",
              isReady ? "border-border focus:border-accent/50" : "cursor-not-allowed border-border/60 opacity-60",
            )}
          />
          <span className="pointer-events-none absolute bottom-3 left-3.5 text-[11px] text-subtle">
            {!initialBuildReady
              ? "安装二维码就绪后开放输入"
              : status === "interrupting"
                ? "正在等待停止确认…"
                : isBusy
                  ? "Enter 加入队列 · 右侧按钮停止当前调整"
                  : "Enter 提交 · Shift + Enter 换行"}
          </span>
          <button
            type={showStopState ? "button" : "submit"}
            onClick={canInterrupt ? () => void interrupt() : undefined}
            disabled={showStopState ? interrupting : !isReady || !message.trim() || submitting}
            aria-label={showStopState ? "停止当前续跑调整" : "提交续跑调整"}
            title={showStopState ? "停止当前续跑调整" : "提交续跑调整"}
            className={cn(
              "absolute bottom-3 right-3 inline-flex h-7 w-7 items-center justify-center rounded-full shadow-sm transition-all hover:scale-105 disabled:cursor-not-allowed disabled:opacity-60",
              showStopState
                ? "border border-accent/35 bg-accent/10 text-accent hover:bg-accent/20"
                : "bg-accent text-background shadow-accent/25 hover:bg-accent-soft",
            )}
          >
            {interrupting ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent/35 border-t-accent" />
            ) : canInterrupt ? (
              <span className="h-2.5 w-2.5 rounded-[2px] bg-current" />
            ) : submitting ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-background/40 border-t-background" />
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
                <path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        </div>
      </form>
    </div>
  )
}

async function copyConversationText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 非安全上下文或权限受限时继续使用 DOM fallback。
    }
  }
  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand("copy")
  textarea.remove()
  return copied
}

function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    const ok = await copyConversationText(text)
    setCopied(ok)
    if (ok) setTimeout(() => setCopied(false), 1400)
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label="复制消息"
      title="复制消息"
      className="absolute -left-9 top-2 invisible inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-surface text-subtle opacity-0 shadow-lg transition-all hover:text-foreground group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
    >
      {copied ? (
        <span className="text-[10px] text-success">✓</span>
      ) : (
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">
          <rect x="8" y="8" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
          <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      )}
    </button>
  )
}

function formatMessageTime(timestamp?: string): string {
  if (!timestamp) return ""
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)
}

function MessageTime({ timestamp }: { timestamp?: string }) {
  const formatted = formatMessageTime(timestamp)
  if (!formatted) return null
  return <time dateTime={timestamp} className="text-[10px] normal-case tracking-normal text-subtle">{formatted}</time>
}

function UserBubble({ text, label, timestamp }: { text: string; label?: string; timestamp?: string }) {
  return (
    <div className="flex justify-end px-3">
      <div className="group relative max-w-[88%] rounded-2xl rounded-br-md border border-accent/30 bg-accent/10 px-3.5 py-2.5 text-accent-soft">
        <CopyMessageButton text={text} />
        {(label || timestamp) && (
          <div className="mb-1 flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.12em] text-accent/80">
            <span>{label}</span>
            <MessageTime timestamp={timestamp} />
          </div>
        )}
        <p className="select-text whitespace-pre-wrap break-words text-sm leading-relaxed">{text}</p>
      </div>
    </div>
  )
}

function AgentEventBubble({
  event,
  running,
}: {
  event: TimelineEvent | FollowUpTraceEvent
  running?: boolean
}) {
  if (isToolEvent(event)) return null
  const labels: Record<string, string> = {
    run: "Agent",
    status: "执行状态",
    stage: "执行阶段",
    compact: "上下文整理",
    capture: "预览采集",
    distribution: "安装包",
    question: "等待确认",
    assistant: "Agent",
  }
  return (
    <div className="flex justify-start px-3">
      <div className="max-w-[88%] rounded-2xl rounded-bl-md border border-border bg-surface-raised px-3.5 py-2.5">
        <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-subtle">
          <span className={cn("h-1.5 w-1.5 rounded-full", running ? "live-dot bg-accent" : "bg-border-strong")} />
          <span>{labels[event.kind] || "Agent"}</span>
          <MessageTime timestamp={event.timestamp} />
        </div>
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
          {event.summary}
        </p>
      </div>
    </div>
  )
}

function GenerationPendingIndicator() {
  return (
    <div className="flex justify-start px-3" role="status" aria-live="polite">
      <div className="flex max-w-[88%] items-center gap-3 rounded-2xl rounded-bl-md border border-accent/25 bg-accent/[0.07] px-3.5 py-3">
        <span className="relative flex h-7 w-7 shrink-0 items-center justify-center">
          <span className="absolute inset-0 animate-ping rounded-full bg-accent/10" />
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent/25 border-t-accent" />
        </span>
        <span className="min-w-0">
          <span className="flex items-center text-xs font-medium text-accent-soft">
            正在生成应用
            <span className="ml-1 inline-flex w-5" aria-hidden="true">
              <span className="generation-dot">·</span>
              <span className="generation-dot">·</span>
              <span className="generation-dot">·</span>
            </span>
          </span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-subtle">
            后续阶段会自动更新，请稍候
          </span>
        </span>
      </div>
    </div>
  )
}

function isToolEvent(event: TimelineEvent | FollowUpTraceEvent): boolean {
  return String(event.kind || "").trim().toLowerCase().includes("tool")
}

function AgentNotice({
  children,
  running = false,
  tone = "normal",
  timestamp,
}: {
  children: React.ReactNode
  running?: boolean
  tone?: "normal" | "danger" | "success" | "warning"
  timestamp?: string
}) {
  const toneClass = tone === "danger"
    ? "border-danger/30 bg-danger/10 text-danger"
    : tone === "success"
      ? "border-success/25 bg-success/5 text-muted"
      : tone === "warning"
        ? "border-warning/25 bg-warning/5 text-muted"
        : "border-border bg-surface-raised text-muted"
  const dotClass = running
    ? "live-dot bg-accent"
    : tone === "danger"
      ? "bg-danger"
      : tone === "success"
        ? "bg-success"
        : tone === "warning"
          ? "bg-warning"
          : "bg-border-strong"
  return (
    <div className="flex justify-start px-3">
      <div className={cn(
        "flex max-w-[88%] items-start gap-2 rounded-2xl rounded-bl-md border px-3 py-2.5 text-xs font-medium leading-relaxed",
        toneClass,
      )}>
        <span className={cn("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", dotClass)} />
        <span className="min-w-0">
          <span>{children}</span>
          <span className="mt-1 block"><MessageTime timestamp={timestamp} /></span>
        </span>
      </div>
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  const labels: Record<string, string> = {
    building: "首版本构建中",
    preparing: "等待首版本",
    starting: "连接中",
    idle: "可继续",
    running: "调整中",
    interrupting: "停止中",
    unavailable: "不可用",
  }
  const ready = ["building", "idle", "running"].includes(status)
  return (
    <span className={cn("ml-auto inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium", ready ? "border-accent/30 bg-accent/10 text-accent-soft" : "border-border bg-surface-raised text-subtle")}>
      {ready && <span className="live-dot h-1.5 w-1.5 rounded-full bg-accent" />}
      {labels[status] || status}
    </span>
  )
}

function CommandCard({
  command,
  prompt,
  active = false,
  stopping = false,
  queuePosition,
  editing = false,
  editingText = "",
  busy = false,
  onEdit,
  onEditingTextChange,
  onSave,
  onCancel,
  onRemove,
}: {
  command: FollowUpCommand
  prompt?: string
  active?: boolean
  stopping?: boolean
  queuePosition?: number
  editing?: boolean
  editingText?: string
  busy?: boolean
  onEdit?: () => void
  onEditingTextChange?: (value: string) => void
  onSave?: () => void
  onCancel?: () => void
  onRemove?: () => void
}) {
  const running = active && !["completed", "interrupted", "failed"].includes(command.status)
  const queued = !active && command.status === "queued"
  return (
    <div className="flex justify-end px-3 py-2.5">
      <div className={cn("min-w-0 max-w-[88%] rounded-2xl rounded-br-md px-3 py-2.5", running ? "border border-accent/30 bg-accent/10 text-accent-soft" : "border border-border bg-surface") }>
        {editing ? (
          <div className="flex items-start gap-1.5">
            <textarea value={editingText} onChange={(event) => onEditingTextChange?.(event.target.value)} rows={2} autoFocus className="min-w-0 flex-1 resize-none rounded-lg border border-accent/50 bg-surface px-2.5 py-2 text-sm text-foreground outline-none" />
            <div className="flex shrink-0 self-center items-center gap-1">
              <button type="button" onClick={onSave} disabled={busy || !editingText.trim()} aria-label="保存编辑" title="保存编辑" className="inline-flex h-7 w-7 items-center justify-center rounded-md text-warning transition-colors hover:border hover:border-warning/40 hover:bg-warning/10 disabled:opacity-50">
                {busy ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-warning/30 border-t-warning" /> : <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true"><path d="m5 12 4 4L19 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
              </button>
              <button type="button" onClick={onCancel} disabled={busy} aria-label="取消编辑" title="取消编辑" className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:border hover:border-border hover:bg-surface hover:text-foreground disabled:opacity-50">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className={cn("whitespace-pre-wrap break-words text-sm", running ? "text-accent-soft" : "text-foreground")}>{command.type === "message" ? prompt || `调整请求 #${command.sequence}` : "停止请求"}</p>
              <div className="mt-1"><MessageTime timestamp={command.created_at} /></div>
              {running && (
                <p className="mt-1 text-[10px] font-medium text-accent/80">
                  {stopping ? "正在停止" : "正在执行"}
                </p>
              )}
              {queued && (
                <p className="mt-1 text-[10px] font-medium text-subtle">
                  排队中{queuePosition ? ` · 第 ${queuePosition} 位` : ""}
                </p>
              )}
            </div>
            {queued && (
              <div className="flex shrink-0 items-center gap-1 text-subtle">
                <button type="button" onClick={onEdit} disabled={busy} aria-label="编辑队列项" title="编辑" className="rounded p-1 hover:bg-surface hover:text-foreground disabled:opacity-50">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true"><path d="m4 16.5-.7 3.2 3.2-.7L18 7.5 15.5 5 4 16.5ZM14.5 6l2.5 2.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
                <button type="button" onClick={onRemove} disabled={busy} aria-label="删除队列项" title="删除" className="rounded p-1 hover:bg-danger/10 hover:text-danger disabled:opacity-50">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true"><path d="M4 7h16M10 11v5m4-5v5M9 7l.7-2h4.6l.7 2m-9 0 1 12h10l1-12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </div>
            )}
          </div>
        )}
        {!editing && !running && (command.error || command.result) && <p className="mt-1.5 text-[11px] text-subtle">{command.error || command.result}</p>}
      </div>
    </div>
  )
}

function ConversationHistory({
  item,
  trace,
}: {
  item: ConversationRecord
  trace: FollowUpTraceEvent[]
}) {
  const interrupted = item.outcome === "interrupted"
  const failed = item.outcome === "failed"
  const message = interrupted
    ? "已停止本轮调整，未处理的请求会继续保留在队列中。"
    : failed
      ? "本轮调整执行失败，请检查错误后重新提交。"
      : "已完成本轮调整，最新构建和预览会自动更新。"
  return (
    <div className="space-y-2.5">
      <UserBubble text={item.prompt} label="调整请求" timestamp={item.createdAt} />
      <FollowUpTrace trace={trace} running={false} />
      <AgentNotice
        tone={failed ? "danger" : interrupted ? "warning" : "success"}
        timestamp={item.completedAt}
      >
        {message}
      </AgentNotice>
    </div>
  )
}

function FollowUpTrace({
  trace,
  running,
  fallbackTimestamp,
}: {
  trace: FollowUpTraceEvent[]
  running: boolean
  fallbackTimestamp?: string
}) {
  // 工具调用属于内部实现细节；用户只看到 Agent 输出的业务分析、修改说明和验证结果。
  const visibleTrace = trace.filter((event) => !isToolEvent(event))
  if (!visibleTrace.length) {
    if (!running) return null
    return <AgentNotice running timestamp={fallbackTimestamp}>已接收调整，正在处理本轮修改…</AgentNotice>
  }
  return (
    <div className="space-y-3">
      {visibleTrace.map((event, index) => (
        <AgentEventBubble
          key={`${event.timestamp || "follow-up"}-${event.kind}-${index}`}
          event={event}
          running={running && index === visibleTrace.length - 1}
        />
      ))}
    </div>
  )
}

function traceInWindow(
  trace: FollowUpTraceEvent[],
  startedAt?: string,
  endedAt?: string,
): FollowUpTraceEvent[] {
  if (!startedAt) return []
  const start = Date.parse(startedAt)
  const end = endedAt ? Date.parse(endedAt) : Number.POSITIVE_INFINITY
  if (!Number.isFinite(start)) return []
  return trace.filter((event) => {
    const timestamp = Date.parse(event.timestamp)
    return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end
  })
}
