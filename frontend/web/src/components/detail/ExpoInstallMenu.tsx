import { useEffect, useRef, useState } from "react"
import { api, withCacheBust } from "@/lib/api"
import type { ExpoServeState, RunArtifacts } from "@/lib/types"

// 占位地址：接入正式 HarmonyOS PC 版 ExpoGo 安装包后只需替换这一项。
const EXPO_GO_PC_DOWNLOAD_URL = "https://appgallery.huawei.com/link/invite-test-wap?taskId=6bf8b471bc2dded43952e4f1cb58f1eb"

type InstallTarget = "phone" | "desktop"

export function ExpoInstallMenu({
  runId,
  artifacts,
  serve,
}: {
  runId: string
  artifacts: RunArtifacts
  serve?: ExpoServeState
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialog, setDialog] = useState<InstallTarget | null>(null)
  const [phoneRequestPending, setPhoneRequestPending] = useState(false)
  const [phoneRequestError, setPhoneRequestError] = useState("")
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [menuOpen])

  useEffect(() => {
    if (!dialog) return
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDialog(null)
    }
    document.addEventListener("keydown", close)
    return () => document.removeEventListener("keydown", close)
  }, [dialog])

  const openDialog = (target: InstallTarget) => {
    setMenuOpen(false)
    setDialog(target)
    if (target !== "phone" || artifacts.install_ready || phoneRequestPending) return
    setPhoneRequestPending(true)
    setPhoneRequestError("")
    api.packageRun(runId)
      .catch((error: unknown) => {
        setPhoneRequestError(error instanceof Error ? error.message : "手机安装包生成失败。")
      })
      .finally(() => setPhoneRequestPending(false))
  }

  return (
    <>
      <div ref={menuRef} className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((value) => !value)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-accent/35 bg-accent/15 px-3 text-xs font-semibold text-accent-soft shadow-lg shadow-black/20 transition-colors hover:border-accent/55 hover:bg-accent/25 hover:text-foreground"
        >
          <InstallIcon />
          安装
          <ChevronIcon open={menuOpen} />
        </button>

        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 top-10 z-50 w-56 overflow-hidden rounded-xl border border-border-strong bg-surface p-1.5 shadow-2xl shadow-black/50"
          >
            <InstallOption
              label="安装到手机"
              description="后台生成，点击后展示二维码"
              icon={<PhoneIcon />}
              onClick={() => openDialog("phone")}
            />
            <InstallOption
              label="安装到 PC"
              description="获取 ExpoGo 与预览地址"
              icon={<DesktopIcon />}
              onClick={() => openDialog("desktop")}
            />
          </div>
        )}
      </div>

      {dialog && (
        <InstallDialog title={dialog === "phone" ? "安装到手机" : "安装到 PC"} onClose={() => setDialog(null)}>
          {dialog === "phone" ? (
            <PhoneInstallContent
              artifacts={artifacts}
              requestPending={phoneRequestPending}
              requestError={phoneRequestError}
            />
          ) : (
            <PcInstallContent serve={serve} />
          )}
        </InstallDialog>
      )}
    </>
  )
}

function InstallOption({
  label,
  description,
  icon,
  onClick,
}: {
  label: string
  description: string
  icon: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-white/[0.06]"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent-soft">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-foreground">{label}</span>
        <span className="block text-[11px] text-muted">{description}</span>
      </span>
    </button>
  )
}

function InstallDialog({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="glass w-full max-w-md overflow-hidden rounded-2xl border border-border-strong shadow-2xl shadow-black/70">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭安装窗口"
            className="flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-white/[0.07] hover:text-foreground"
          >
            <CloseIcon />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

function PhoneInstallContent({
  artifacts,
  requestPending,
  requestError,
}: {
  artifacts: RunArtifacts
  requestPending: boolean
  requestError: string
}) {
  const signedReady = Boolean(
    artifacts.install_ready && artifacts.install_qr_path && artifacts.install_url,
  )

  if (!signedReady) {
    const failed = Boolean(requestError) || artifacts.distribution_status === "failed"
    return (
      <div className="flex flex-col items-center py-5 text-center">
        <span
          className={`flex h-14 w-14 items-center justify-center rounded-2xl ${failed ? "bg-danger/10 text-danger" : "bg-warning/10 text-warning"}`}
        >
          <PhoneIcon size={28} />
        </span>
        <h3 className="mt-4 text-sm font-semibold text-foreground">
          {failed ? "手机安装包生成失败" : "正在生成手机安装包"}
        </h3>
        <p className="mt-2 max-w-sm text-xs leading-relaxed text-muted">
          {failed
            ? requestError || artifacts.distribution_error || "HPack 未能完成签名，请查看构建日志。"
            : requestPending || artifacts.distribution_status === "packaging"
              ? "正在使用当前任务的签名 Profile 生成手机安装二维码。"
              : "请求已提交，等待后端开始生成手机安装二维码。"}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex aspect-square w-full max-w-[240px] items-center justify-center rounded-2xl bg-white p-3">
        <img
          src={withCacheBust(artifacts.install_qr_path)}
          alt="手机扫码安装二维码"
          className="h-full w-full rounded-lg object-contain"
        />
      </div>
      <p className="text-center text-xs leading-relaxed text-muted">
        请使用 HarmonyOS 手机扫描二维码。当前是 internal-testing 包，仅 Profile 已登记 UDID 的设备可安装；未登记设备会提示应用验证失败 10019。
      </p>
      <a
        href={artifacts.install_url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex w-full items-center justify-center rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-background transition-colors hover:bg-accent-soft"
      >
        打开手机安装页
      </a>
    </div>
  )
}

function PcInstallContent({ serve }: { serve?: ExpoServeState }) {
  const previewUrl = serve?.public_url || ""

  return (
    <div className="space-y-5">
      <GuideStep number="1" title="下载 ExpoGo">
        <p className="text-xs leading-relaxed text-muted">
          在 HarmonyOS PC 上复制下面的链接，用浏览器打开并下载、安装 ExpoGo。
        </p>
        <CopyableUrl value={EXPO_GO_PC_DOWNLOAD_URL} linkLabel="打开下载链接" />
      </GuideStep>

      <GuideStep number="2" title="打开生成的应用">
        <p className="text-xs leading-relaxed text-muted">
          打开 ExpoGo，把下面的外网预览地址粘贴到地址输入框中。
        </p>
        {previewUrl ? (
          <CopyableUrl value={previewUrl} />
        ) : (
          <div className="mt-3 rounded-lg border border-border bg-black/15 px-3 py-3 text-xs text-muted">
            {serve?.status === "failed"
              ? `外网预览发布失败：${serve.error || "请检查 Expo Gateway 配置。"}`
              : "外网预览地址正在发布，请稍候…"}
          </div>
        )}
      </GuideStep>
    </div>
  )
}

function GuideStep({
  number,
  title,
  children,
}: {
  number: string
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="flex gap-3 rounded-xl border border-border bg-surface-raised p-4">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-bold text-accent-soft">
        {number}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <div className="mt-1.5">{children}</div>
      </div>
    </section>
  )
}

function CopyableUrl({ value, linkLabel }: { value: string; linkLabel?: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value)
      } else {
        const textarea = document.createElement("textarea")
        textarea.value = value
        textarea.style.position = "fixed"
        textarea.style.opacity = "0"
        document.body.appendChild(textarea)
        textarea.select()
        const copied = document.execCommand("copy")
        textarea.remove()
        if (!copied) throw new Error("copy is unavailable")
      }
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-stretch gap-2">
        <code className="min-w-0 flex-1 break-all rounded-lg border border-border bg-black/20 px-3 py-2 text-[11px] leading-relaxed text-foreground">
          {value}
        </code>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded-lg border border-accent/30 bg-accent/10 px-3 text-xs font-semibold text-accent-soft transition-colors hover:bg-accent/20"
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      {linkLabel ? (
        <a
          href={value}
          target="_blank"
          rel="noreferrer"
          className="inline-flex text-xs text-accent-soft underline decoration-accent/40 underline-offset-4 hover:text-foreground"
        >
          {linkLabel}
        </a>
      ) : null}
    </div>
  )
}

function InstallIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
      <path d="M12 3v11m0 0 4-4m-4 4-4-4M5 19h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg className={`transition-transform ${open ? "rotate-180" : ""}`} viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true">
      <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PhoneIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M10.5 5h3M11 18.5h2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function DesktopIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 20h8M12 16v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
