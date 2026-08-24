import { useEffect, useRef, useState } from "react"
import { InstallPanel } from "@/components/detail/InstallPanel"
import type { RunArtifacts } from "@/lib/types"

/**
 * 悬浮安装坞。
 * - unsigned HAP 就绪后仍保持隐藏，由顶部“生成安装包”按钮启动签名。
 * - 签名完成后自动展开二维码气泡；后续版本每次生成成功都会再次展开。
 */
export function InstallDock({ artifacts }: { artifacts: RunArtifacts }) {
  const installReady = Boolean(
    artifacts.install_ready && artifacts.install_url && artifacts.install_qr_path,
  )
  const firstReady = Boolean(artifacts.first_install_ready && artifacts.first_install_url)
  const distributionStatus = artifacts.distribution_status || "waiting_hap"
  const outdated = Boolean(artifacts.package_outdated)

  const visible = firstReady || installReady || distributionStatus === "packaging"

  const [open, setOpen] = useState(false)
  const previousInstallKeyRef = useRef("")
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const installKey = installReady
      ? artifacts.install_url
      : firstReady && !outdated
        ? artifacts.first_install_url
        : ""
    if (installKey && installKey !== previousInstallKeyRef.current) {
      setOpen(true)
    }
    previousInstallKeyRef.current = installKey
  }, [artifacts.first_install_url, artifacts.install_url, firstReady, installReady, outdated])

  // 点击外部收起气泡
  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [open])

  if (!visible) return null

  const label = installReady
    ? "可扫码安装"
    : distributionStatus === "packaging"
      ? "正在生成安装包"
      : outdated
        ? "安装包待更新"
        : "查看安装二维码"

  return (
    <div ref={panelRef} className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">
      {/* 二维码气泡 */}
      {open && (
        <div className="glass w-[320px] origin-bottom-right animate-[scaleIn_0.18s_ease-out] overflow-hidden rounded-2xl border border-border shadow-2xl shadow-black/60">
          <InstallPanel artifacts={artifacts} />
        </div>
      )}

      {/* 悬浮触发按钮 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`group inline-flex items-center gap-2.5 rounded-full border px-5 py-3 text-sm font-semibold shadow-lg shadow-black/40 transition-all ${
          installReady
            ? "border-accent/40 bg-accent text-background hover:bg-accent-soft"
            : outdated
              ? "border-warning/40 bg-warning/10 text-warning"
              : "border-border bg-surface text-foreground"
        }`}
      >
        {installReady ? (
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-background/70" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-background" />
          </span>
        ) : distributionStatus === "packaging" ? (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-foreground/30 border-t-foreground" />
        ) : (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
            <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2z" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        )}
        {label}
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          aria-hidden="true"
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path
            d="M6 15l6-6 6 6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  )
}
