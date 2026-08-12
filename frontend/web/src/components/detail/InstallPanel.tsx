import { useState } from "react"
import { withCacheBust } from "@/lib/api"
import { StatusBadge } from "@/components/ui/StatusBadge"
import { cn } from "@/lib/format"
import type { RunArtifacts } from "@/lib/types"

export function InstallPanel({ artifacts }: { artifacts: RunArtifacts }) {
  const hapReady = Boolean(
    artifacts.hap_found && artifacts.hap_download_path && artifacts.hap_qr_path,
  )
  const installReady = Boolean(
    artifacts.install_ready && artifacts.install_url && artifacts.install_qr_path,
  )
  const firstReady = Boolean(artifacts.first_install_ready && artifacts.first_install_url)
  const distributionStatus = artifacts.distribution_status || "waiting_hap"

  // 首版本安装页与二维码（折叠展示）
  const [showFirst, setShowFirst] = useState(false)

  const badge = installReady ? (
    <StatusBadge tone="ready" pulse>
      最新可安装
    </StatusBadge>
  ) : distributionStatus === "failed" ? (
    <StatusBadge tone="failed">签名失败</StatusBadge>
  ) : distributionStatus === "packaging" ? (
    <StatusBadge tone="running" pulse>
      签名中
    </StatusBadge>
  ) : artifacts.package_outdated || distributionStatus === "ready_to_package" ? (
    <StatusBadge tone="waiting">待生成</StatusBadge>
  ) : (
    <StatusBadge tone="waiting">等待 HAP</StatusBadge>
  )

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">扫码直装 · 最新版本</h3>
        {badge}
      </div>

      {/* 最新二维码区（居中，纵向布局适配窄列） */}
      <div className="flex flex-col items-center gap-3">
        {installReady ? (
          <div className="flex aspect-square w-full max-w-[200px] items-center justify-center rounded-2xl bg-white p-3">
            <img
              src={withCacheBust(artifacts.install_qr_path)}
              alt="最新版本扫码安装二维码"
              className="h-full w-full rounded-lg object-contain"
            />
          </div>
        ) : (
          <div className="flex aspect-square w-full max-w-[200px] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-surface-raised text-center text-subtle">
            {distributionStatus === "packaging" ? (
              <span className="h-7 w-7 animate-spin rounded-full border-2 border-border-strong border-t-accent" />
            ) : (
              <svg viewBox="0 0 24 24" width="34" height="34" fill="none" aria-hidden="true">
                <path
                  d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
            )}
            <span className="px-4 text-xs leading-relaxed">
              {distributionStatus === "failed"
                ? "生成失败"
                : distributionStatus === "packaging"
                  ? "正在编译、签名并生成二维码…"
                  : artifacts.package_outdated
                    ? "代码已有新调整，等待重新生成"
                    : "点击右上角“生成安装包”后生成"}
            </span>
          </div>
        )}

        <p className="text-center text-xs leading-relaxed text-muted">{installCopy(artifacts)}</p>
      </div>

      {/* 操作按钮 */}
      {(installReady || hapReady || firstReady) && (
        <div className="flex flex-col gap-2">
          {installReady && (
            <a
              href={artifacts.install_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-background transition-colors hover:bg-accent-soft"
            >
              打开最新安装页
            </a>
          )}
          {hapReady && (
            <a
              href={artifacts.hap_download_path}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-surface-raised px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-border-strong"
            >
              下载原始 HAP（最新 unsigned）
            </a>
          )}
          {firstReady && (
            <button
              type="button"
              onClick={() => setShowFirst((v) => !v)}
              aria-expanded={showFirst}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-surface-raised px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-border-strong"
            >
              查看首版本二维码（旧版）
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                aria-hidden="true"
                className={cn("transition-transform", showFirst && "rotate-180")}
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
          )}
        </div>
      )}

      {/* 首版本二维码（明确标记旧版，避免与主区域的最新二维码混淆） */}
      {firstReady && showFirst && (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-border bg-surface-raised/60 p-4">
          <div className="flex items-center gap-2 self-start">
            <StatusBadge tone="waiting">首版本 · 旧版</StatusBadge>
            <span className="text-xs text-muted">仅用于查看和安装首次生成版本</span>
          </div>
          {artifacts.first_install_qr_path ? (
            <div className="flex aspect-square w-full max-w-[180px] items-center justify-center rounded-2xl bg-white p-3">
              <img
                src={withCacheBust(artifacts.first_install_qr_path)}
                alt="首版本扫码安装二维码"
                className="h-full w-full rounded-lg object-contain"
              />
            </div>
          ) : null}
          <a
            href={artifacts.first_install_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-border-strong"
          >
            在浏览器打开首版本安装页
          </a>
        </div>
      )}
    </div>
  )
}

function installCopy(artifacts: RunArtifacts): string {
  const installReady = Boolean(
    artifacts.install_ready && artifacts.install_url && artifacts.install_qr_path,
  )
  const hapReady = Boolean(artifacts.hap_found && artifacts.hap_download_path)
  const status = artifacts.distribution_status || "waiting_hap"

  if (installReady) {
    return "扫描上方二维码安装最新版本；下载的原始 HAP 始终为最新未签名包。"
  }
  if (hapReady) {
    if (status === "packaging") return "正在用当前最新代码重新编译、签名并生成二维码…"
    if (status === "failed")
      return `扫码安装生成失败：${artifacts.distribution_error || "请查看 HPack 日志"}`
    if (artifacts.package_outdated) return "当前代码已调整；旧二维码不再代表最新代码，请重新生成安装包。"
    return "unsigned HAP 和预览已就绪，可继续调整，或点击右上角“生成安装包”。"
  }
  return "QA 与 unsigned HAP 就绪后，可由用户主动生成签名安装包。"
}
