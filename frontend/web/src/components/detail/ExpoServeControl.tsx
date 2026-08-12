import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import { cn } from "@/lib/format"
import type { ExpoServeState } from "@/lib/types"

function statusText(status: string) {
  if (status === "serving") return "已发布"
  if (status === "failed") return "Gateway 不可用"
  if (status === "disabled") return "未启用"
  return "未发布"
}

export function ExpoServeControl({
  runId,
  value,
}: {
  runId: string
  value: ExpoServeState | undefined
}) {
  const [serve, setServe] = useState(value)
  const [busy, setBusy] = useState<"publish" | "unpublish" | null>(null)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setServe(value)
  }, [value])

  const published = Boolean(serve?.public_url)
  const serving = serve?.status === "serving"
  const canPublish = Boolean(serve?.can_publish && !published && !busy)
  const canUnpublish = Boolean(published && !busy)

  const toggle = async () => {
    if ((!published && !canPublish) || (published && !canUnpublish)) return
    setError("")
    setBusy(published ? "unpublish" : "publish")
    try {
      const response = published
        ? await api.unpublishExpoRun(runId)
        : await api.publishExpoRun(runId)
      setServe(response.serve)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "外网预览操作失败")
    } finally {
      setBusy(null)
    }
  }

  const copyUrl = async () => {
    if (!serve?.public_url) return
    try {
      await navigator.clipboard.writeText(serve.public_url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setError("复制失败，请手动选择链接。")
    }
  }

  const buttonLabel = busy === "publish"
    ? "正在开启"
    : busy === "unpublish"
      ? "正在关闭"
      : published
        ? "关闭外网预览"
        : "开启外网预览"

  return (
    <section className="mx-1 mb-4 rounded-2xl border border-accent/25 bg-accent/5 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">Harmony Go 外网预览</h3>
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                serving
                  ? "border-success/30 bg-success/10 text-success"
                  : serve?.status === "failed"
                    ? "border-danger/30 bg-danger/10 text-danger"
                    : "border-border bg-surface/80 text-muted",
              )}
            >
              {statusText(serve?.status || "stopped")}
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            发布后可在 Harmony Go 中输入公网地址安装应用；关闭后地址立即失效，不会占用新的应用端口。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={published ? !canUnpublish : !canPublish}
          className={cn(
            "inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-full px-3.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            published
              ? "border border-danger/35 bg-danger/10 text-danger hover:bg-danger/15"
              : "bg-accent text-background hover:bg-accent-soft",
          )}
        >
          {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current/30 border-t-current" />}
          {buttonLabel}
        </button>
      </div>

      {published && (
        <div className="mt-3 space-y-2 rounded-xl border border-border bg-surface/75 p-3">
          <div className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 flex-1 select-all truncate text-xs text-accent-soft">
              {serve?.public_url}
            </code>
            <button
              type="button"
              onClick={() => void copyUrl()}
              className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] font-semibold text-muted transition-colors hover:border-accent/40 hover:text-foreground"
            >
              {copied ? "已复制" : "复制地址"}
            </button>
          </div>
          {serve?.local_url && (
            <p className="break-all text-[10px] leading-relaxed text-subtle">
              本地验证：{serve.local_url} · Tunnel 请转发到 {serve.local_origin}
            </p>
          )}
        </div>
      )}

      {!published && !serve?.can_publish && serve?.status !== "failed" && (
        <p className="mt-3 text-[11px] text-subtle">生成、导出和 Harmony Go 启动验证完成后即可发布。</p>
      )}
      {(error || serve?.error) && (
        <p className="mt-3 rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-[11px] text-danger">
          {error || serve?.error}
        </p>
      )}
    </section>
  )
}
