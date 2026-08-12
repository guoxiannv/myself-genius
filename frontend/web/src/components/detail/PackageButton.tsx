import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import type { RunArtifacts } from "@/lib/types"

export function PackageButton({
  runId,
  artifacts,
  compact = false,
}: {
  runId: string | undefined
  artifacts: RunArtifacts | undefined
  compact?: boolean
}) {
  const [requested, setRequested] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const status = artifacts?.distribution_status || "waiting_hap"
  const visible = Boolean(artifacts?.hap_found)
  const current = Boolean(artifacts?.package_current && artifacts.install_ready)
  const currentIsFirst = Boolean(
    current &&
      artifacts?.first_install_url &&
      artifacts.install_url === artifacts.first_install_url,
  )
  const packaging = requested || status === "packaging"
  const canStart = Boolean(runId && artifacts?.package_can_start && !packaging && !current)

  useEffect(() => {
    if (status === "packaging" || status === "ready" || status === "failed") {
      setRequested(false)
    }
    if (status === "ready") setError(null)
  }, [status])

  if (!visible) return null

  const label = current
    ? currentIsFirst
      ? "首版本二维码已生成"
      : "最新二维码已生成"
    : packaging
      ? "正在生成安装包"
      : status === "failed"
        ? "重新生成安装包"
        : status === "waiting_update"
          ? "等待最新构建"
          : status === "waiting_preview"
            ? "等待最新预览"
            : artifacts?.package_outdated
              ? "更新安装包"
              : canStart
                ? "生成安装包"
                : "等待调整完成"

  const start = async () => {
    if (!runId || !canStart) return
    setError(null)
    setRequested(true)
    try {
      await api.packageRun(runId)
    } catch (err) {
      setRequested(false)
      setError(err instanceof Error ? err.message : "安装包任务启动失败")
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => void start()}
        disabled={!canStart}
        aria-label={label}
        title={error || (current ? "当前二维码已对应最新代码" : label)}
        className={[
          `inline-flex items-center gap-2 rounded-full text-xs font-semibold shadow-lg transition-colors disabled:cursor-not-allowed ${compact ? "h-8 px-2.5 sm:px-3" : "h-9 px-2.5 sm:px-3.5"}`,
          current
            ? "border border-success/35 bg-success/15 text-success"
            : canStart
              ? "bg-accent text-background shadow-accent/20 hover:bg-accent-soft"
              : error
                ? "border border-danger/40 bg-danger/10 text-danger"
                : "border border-border bg-surface/75 text-muted shadow-black/20",
        ].join(" ")}
      >
        {packaging ? (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current/35 border-t-current" />
        ) : current ? (
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
            <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 19h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        <span>{label}</span>
      </button>
      {error && (
        <span className="absolute right-0 top-11 w-64 rounded-lg border border-danger/30 bg-surface px-2.5 py-2 text-right text-[11px] text-danger shadow-xl">
          {error}
        </span>
      )}
    </div>
  )
}
