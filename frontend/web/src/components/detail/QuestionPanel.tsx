import { useEffect, useMemo, useState } from "react"
import { api } from "@/lib/api"
import { cn } from "@/lib/format"
import type { AskUserQuestionRequest } from "@/lib/types"

interface QuestionPanelProps {
  runId: string | undefined
  pending: AskUserQuestionRequest[]
  mock?: boolean
}

type Selected = Record<number, string[]>
type OtherValues = Record<number, string>

export function QuestionPanel({ runId, pending, mock }: QuestionPanelProps) {
  const request = pending[0]
  const questions = useMemo(() => request?.toolInput.questions || [], [request])
  const [selected, setSelected] = useState<Selected>({})
  const [otherValues, setOtherValues] = useState<OtherValues>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [submittedAnswers, setSubmittedAnswers] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!request) return
    const next: Selected = {}
    questions.forEach((question, index) => {
      if (!question.multiSelect && question.options?.[0]?.label) {
        next[index] = [question.options[0].label]
      } else {
        next[index] = []
      }
    })
    setSelected(next)
    setOtherValues({})
    setSubmitting(false)
    setSubmitted(false)
    setSubmittedAnswers({})
    setError(null)
  }, [request?.id])

  if (!request || !questions.length) return null

  const setSingle = (index: number, value: string) => {
    setError(null)
    setSelected((prev) => ({ ...prev, [index]: [value] }))
  }

  const toggleMulti = (index: number, value: string) => {
    setError(null)
    setSelected((prev) => {
      const current = new Set(prev[index] || [])
      if (current.has(value)) current.delete(value)
      else current.add(value)
      return { ...prev, [index]: Array.from(current) }
    })
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!runId) return
    const answers: Record<string, string> = {}
    for (let i = 0; i < questions.length; i += 1) {
      const question = questions[i]
      const values = [...(selected[i] || [])]
      const other = (otherValues[i] || "").trim()
      const withoutOther = values.filter((value) => value !== "__other__")
      if (values.includes("__other__") && other) withoutOther.push(other)
      if (!question.multiSelect && values.includes("__other__") && !other) withoutOther.push("Other")
      answers[question.question] = question.multiSelect ? withoutOther.join(", ") : withoutOther[0] || ""
    }
    if (Object.values(answers).some((value) => !value)) {
      setError("请回答所有问题")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      if (mock) {
        await new Promise((resolve) => setTimeout(resolve, 500))
      } else {
        await api.answerQuestion(runId, request.id, answers)
      }
      setSubmittedAnswers(answers)
      setSubmitted(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败")
      setSubmitting(false)
    }
  }

  const audienceLabel = {
    end_user: "用户偏好",
    developer: "开发决策",
    safety: "需要确认",
    auto_decidable: "可自动判断",
  }[request.audience || "end_user"] || "需要回答"

  const answerSummary = Object.values(submittedAnswers).filter(Boolean).join("、")

  if (submitted) {
    return (
      <div className="rounded-[var(--radius-card)] border border-success/30 bg-success/5 p-5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
              <path
                d="M20 6L9 17l-5-5"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">已提交回答</p>
            <p className="mt-1 break-words text-sm leading-relaxed text-muted">{answerSummary}</p>
            <p className="mt-2 text-xs text-subtle">
              {mock ? "演示模式提交成功。" : "已回传给 AI，正在继续生成..."}
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <form
      onSubmit={submit}
      className="relative overflow-hidden rounded-[var(--radius-card)] border border-accent/40 bg-accent/[0.06] p-5 shadow-[0_0_0_1px_var(--color-accent)/10]"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-accent/15 blur-3xl"
      />

      <div className="relative">
        <div className="mb-4 flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent/15 text-accent-soft">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
              <path
                d="M9.5 9a2.5 2.5 0 1 1 5 0c0 1.5-1.5 2-2.2 2.6-.5.4-.8.9-.8 1.6M12 17h.01"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="text-sm font-semibold text-accent-soft">AI 需要你的确认</span>
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent-soft">
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-accent" />
            {mock ? "演示预览" : "等待回答"}
          </span>
        </div>

        <div className="mb-4 flex items-center justify-between gap-3">
          <p className="text-xs leading-relaxed text-muted">Agent 暂停等待回答，提交后会继续执行。</p>
          <span className="shrink-0 rounded-full border border-border bg-surface/60 px-2 py-0.5 text-[11px] text-subtle">
            {audienceLabel}
          </span>
        </div>

        <div className="space-y-6">
        {questions.map((question, index) => {
          const values = selected[index] || []
          return (
            <fieldset key={`${request.id}-${index}`} className="min-w-0">
              <legend className="text-balance text-base font-semibold leading-snug text-foreground">
                <span className="block">
                  {question.header && (
                    <span className="mb-2 mr-2 inline-flex rounded-md bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent-soft">
                      {question.header}
                    </span>
                  )}
                  {question.question}
                </span>
              </legend>
              <ul className="mt-3 flex flex-col gap-2">
                {(question.options || []).map((option) => (
                  <li key={option.label}>
                    <button
                      type="button"
                      onClick={() =>
                        question.multiSelect
                          ? toggleMulti(index, option.label)
                          : setSingle(index, option.label)
                      }
                      aria-pressed={values.includes(option.label)}
                      disabled={submitting}
                      className={cn(
                        "flex w-full items-start gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-all",
                        values.includes(option.label)
                          ? "border-accent bg-accent/10"
                          : "border-border bg-surface/60 hover:border-accent/40 hover:bg-surface-raised",
                      )}
                    >
                      <ChoiceMark active={values.includes(option.label)} multi={!!question.multiSelect} />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-foreground">{option.label}</span>
                        {option.description && (
                          <span className="mt-0.5 block text-xs leading-relaxed text-subtle">
                            {option.description}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
                <li>
                  <button
                    type="button"
                    onClick={() =>
                      question.multiSelect ? toggleMulti(index, "__other__") : setSingle(index, "__other__")
                    }
                    aria-pressed={values.includes("__other__")}
                    disabled={submitting}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-all",
                      values.includes("__other__")
                        ? "border-accent bg-accent/10"
                        : "border-border bg-surface/60 hover:border-accent/40 hover:bg-surface-raised",
                    )}
                  >
                    <ChoiceMark active={values.includes("__other__")} multi={!!question.multiSelect} />
                    <span className="text-sm font-medium text-foreground">Other</span>
                  </button>
                </li>
              </ul>
                {values.includes("__other__") && (
                  <textarea
                    value={otherValues[index] || ""}
                    onChange={(event) =>
                      setOtherValues((prev) => ({ ...prev, [index]: event.target.value }))
                    }
                    rows={2}
                    placeholder="输入你的补充说明..."
                    className="mt-2.5 w-full resize-none rounded-xl border border-border bg-surface/60 px-3.5 py-2.5 text-sm text-foreground placeholder:text-subtle focus:border-accent/50 focus:outline-none"
                    disabled={submitting}
                  />
                )}
            </fieldset>
          )
        })}
        </div>

        {error && <p className="mt-2.5 text-xs text-danger">{error}</p>}

        <div className="mt-5 flex items-center justify-between gap-3">
          <span className="text-xs text-subtle">
            {questions.some((question) => question.multiSelect) ? "包含多选" : "单选"}
            {" · 支持自定义"}
          </span>
          <button
            type="submit"
            disabled={submitting}
            className={cn(
              "inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-all",
              "bg-accent text-background hover:bg-accent-soft",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {submitting ? (
              <>
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-background/40 border-t-background" />
                提交中...
              </>
            ) : (
              <>
                提交并继续
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
                  <path
                    d="M5 12h14M13 6l6 6-6 6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </>
            )}
          </button>
        </div>
      </div>
    </form>
  )
}

function ChoiceMark({ active, multi }: { active: boolean; multi: boolean }) {
  return (
    <span
      className={cn(
        "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border transition-colors",
        multi ? "rounded-[5px]" : "rounded-full",
        active ? "border-accent bg-accent text-background" : "border-subtle",
      )}
    >
      {active && (
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" aria-hidden="true">
          <path
            d="M20 6L9 17l-5-5"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </span>
  )
}
