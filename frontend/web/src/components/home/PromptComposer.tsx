import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { api, ApiError } from "@/lib/api"
import { cn } from "@/lib/format"
import { SUGGESTIONS } from "./suggestions"

const PRO_WORKFLOW_VARIANT = "autopilot-html-tmux-no-uitree-fast-plan-launch-qa-split"

// 一套前端按 Runtime 分流到两套独立执行后端：Pro 使用 devkit_studio 的
// ArkPilot tmux-runner；Expo 使用 expo-arkpilot 的 one-click launcher。
const EFFORTS = [
  { id: "a2ui-pro", label: "Pro", hint: "Genius 1.0", planSkill: "", variant: PRO_WORKFLOW_VARIANT, runtime: "arkpilot" },
  { id: "expo", label: "Expo", hint: "Genius 2.0", planSkill: "", variant: undefined, runtime: "expo" },
] as const

const DEFAULT_EFFORT = "expo"

const DECISION_MODES = [
  { id: "auto", label: "Approve for me", hint: "基于你的描述直接生成初版，我来替你决策" },
  { id: "guided", label: "Ask for Approval", hint: "我把所有决策点列出来，你来逐项决策" },
] as const

const DEFAULT_DECISION_MODE = "auto"

export function PromptComposer() {
  const navigate = useNavigate()
  const [prompt, setPrompt] = useState("")
  const [skill, setSkill] = useState<string>(DEFAULT_EFFORT)
  const [decisionMode, setDecisionMode] = useState<string>(DEFAULT_DECISION_MODE)
  const [effortOpen, setEffortOpen] = useState(false)
  const effortRef = useRef<HTMLDivElement>(null)
  const [decisionModeOpen, setDecisionModeOpen] = useState(false)
  const decisionModeRef = useRef<HTMLDivElement>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const activeEffort = EFFORTS.find((e) => e.id === skill) ?? EFFORTS[0]
  const activeDecisionMode = DECISION_MODES.find((mode) => mode.id === decisionMode) ?? DECISION_MODES[0]

  // 点击外部关闭下拉
  useEffect(() => {
    if (!effortOpen && !decisionModeOpen) return
    const onClick = (event: MouseEvent) => {
      if (effortRef.current && !effortRef.current.contains(event.target as Node)) {
        setEffortOpen(false)
      }
      if (decisionModeRef.current && !decisionModeRef.current.contains(event.target as Node)) {
        setDecisionModeOpen(false)
      }
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [effortOpen, decisionModeOpen])

  const handleSubmit = async (event: React.SyntheticEvent) => {
    event.preventDefault()
    const trimmed = prompt.trim()
    if (!trimmed) {
      setError("请输入你想构建的应用描述")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const result = await api.createRun({
        prompt: trimmed,
        runtime: activeEffort.runtime,
        plan_skill: activeEffort.planSkill,
        variant: activeEffort.variant,
        interactive_questions: activeEffort.runtime === "expo" ? false : activeDecisionMode.id === "guided",
      })
      navigate(`/runs/${result.run_id}`)
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : "启动失败"
      setError(message)
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="w-full">
      <div className="glass rounded-[var(--radius-card)] p-2 shadow-2xl shadow-black/40">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              handleSubmit(e)
            }
          }}
          rows={3}
          placeholder="描述你想构建的鸿蒙应用，例如：做一个支持分类统计的记账应用…"
          className="w-full resize-none rounded-2xl bg-transparent px-4 py-3 text-base leading-relaxed text-foreground placeholder:text-subtle focus:outline-none"
        />

        <div className="flex flex-wrap items-center justify-between gap-3 px-2 pb-1.5">
          <div className="flex items-center gap-2">
            <div ref={effortRef} className="relative">
              <button
                type="button"
                onClick={() => setEffortOpen((v) => !v)}
                aria-haspopup="listbox"
                aria-expanded={effortOpen}
                title={activeEffort.hint}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-raised px-3 py-1.5 text-xs font-medium text-accent-soft transition-colors hover:text-foreground"
              >
                <span>{activeEffort.label}</span>
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="none"
                  aria-hidden="true"
                  className={cn("transition-transform", effortOpen && "rotate-180")}
                >
                  <path
                    d="M6 9l6 6 6-6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>

              {effortOpen && (
                <ul
                  role="listbox"
                  className="glass absolute bottom-full left-0 z-20 mb-2 w-56 overflow-hidden rounded-2xl border border-border p-1.5 shadow-2xl shadow-black/50"
                >
                  {EFFORTS.map((item) => (
                    <li key={item.id} role="option" aria-selected={skill === item.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSkill(item.id)
                          setEffortOpen(false)
                        }}
                        className={cn(
                          "flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition-colors",
                          skill === item.id
                            ? "bg-accent/10 text-foreground"
                            : "text-muted hover:bg-surface-raised hover:text-foreground",
                        )}
                      >
                        <span className="flex flex-col">
                          <span className="text-sm font-medium">{item.label}</span>
                          <span className="text-xs text-subtle">{item.hint}</span>
                        </span>
                        {skill === item.id && (
                          <svg
                            viewBox="0 0 24 24"
                            width="16"
                            height="16"
                            fill="none"
                            aria-hidden="true"
                            className="shrink-0 text-accent"
                          >
                            <path
                              d="M20 6L9 17l-5-5"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {activeEffort.runtime === "expo" ? (
              <span
                title="Expo Runtime 会直接生成、验证并启动应用"
                className="inline-flex items-center rounded-full border border-border bg-surface-raised px-3 py-1.5 text-xs font-medium text-accent-soft"
              >
                自动生成并启动
              </span>
            ) : (
              <div ref={decisionModeRef} className="relative">
                <button
                  type="button"
                  onClick={() => setDecisionModeOpen((value) => !value)}
                  aria-haspopup="listbox"
                  aria-expanded={decisionModeOpen}
                  title={activeDecisionMode.hint}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-raised px-3 py-1.5 text-xs font-medium text-accent-soft transition-colors hover:text-foreground"
                >
                  <span>{activeDecisionMode.label}</span>
                  <svg
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    aria-hidden="true"
                    className={cn("transition-transform", decisionModeOpen && "rotate-180")}
                  >
                    <path
                      d="M6 9l6 6 6-6"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>

                {decisionModeOpen && (
                  <ul
                    role="listbox"
                    className="glass absolute bottom-full left-0 z-20 mb-2 w-80 overflow-hidden rounded-2xl border border-border p-1.5 shadow-2xl shadow-black/50"
                  >
                    {DECISION_MODES.map((mode) => (
                      <li key={mode.id} role="option" aria-selected={decisionMode === mode.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setDecisionMode(mode.id)
                            setDecisionModeOpen(false)
                          }}
                          className={cn(
                            "flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition-colors",
                            decisionMode === mode.id
                              ? "bg-accent/10 text-foreground"
                              : "text-muted hover:bg-surface-raised hover:text-foreground",
                          )}
                        >
                          <span className="flex min-w-0 flex-col">
                            <span className="text-sm font-medium">{mode.label}</span>
                            <span className="text-xs leading-relaxed text-subtle">{mode.hint}</span>
                          </span>
                          {decisionMode === mode.id && (
                            <svg
                              viewBox="0 0 24 24"
                              width="16"
                              height="16"
                              fill="none"
                              aria-hidden="true"
                              className="shrink-0 text-accent"
                            >
                              <path
                                d="M20 6L9 17l-5-5"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent-soft">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
                <path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4L12 2z" />
              </svg>
              For HarmonyOS
            </span>
          </div>

          <button
            type="submit"
            disabled={submitting}
            aria-label="开始构建"
            title="开始构建"
            className={cn(
              "inline-flex h-9 w-9 items-center justify-center rounded-full transition-all",
              "bg-accent text-background hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            {submitting ? (
              <Spinner />
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
                <path
                  d="M12 19V5M5 12l7-7 7 7"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        </div>

      </div>

      {error && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2.5 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-left"
        >
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-danger"
          >
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
            <path d="M12 8v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <circle cx="12" cy="16.5" r="1" fill="currentColor" />
          </svg>
          <div className="min-w-0">
            <p className="text-sm font-medium text-danger">构建启动失败</p>
            <p className="mt-0.5 break-words text-xs leading-relaxed text-danger/90">{error}</p>
          </div>
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
        {SUGGESTIONS.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => setPrompt(item.prompt)}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-surface/60 px-3.5 py-2 text-sm text-muted transition-colors hover:border-border-strong hover:text-foreground"
          >
            <span className="text-accent">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </div>
    </form>
  )
}

function Spinner() {
  return (
    <svg className="animate-spin" viewBox="0 0 24 24" width="16" height="16" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}
