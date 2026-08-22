import { type PointerEvent, type ReactNode, type WheelEvent, useEffect, useRef, useState } from "react"
import { api, withCacheBust } from "@/lib/api"
import { LivePreviewWebRTC } from "@/lib/livePreviewWebRTC"
import type {
  LivePreviewInput,
  PreviewKind,
  RunArtifacts,
  RunPreviewPolicy,
  RunPreviewSession,
  RunRuntime,
} from "@/lib/types"

type PreviewMediaElement = HTMLImageElement | HTMLVideoElement
const FRAME_REQUEST_RETRY_DELAY_MS = 25
const FRAME_LONG_POLL_WAIT_MS = 1000
const STALE_FRAME_RETRY_DELAY_MS = 500
const FRAME_ERROR_RETRY_DELAY_MS = 1000
const WEBRTC_FIRST_FRAME_TIMEOUT_MS = 5_000

function createViewerId() {
  return globalThis.crypto?.randomUUID?.()
    || `viewer-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function DevicePreview({
  artifacts,
  waitingMessage,
  runId,
  runtime,
  previewPolicy,
  previewSessions,
  shareToken = "",
}: {
  artifacts: RunArtifacts
  waitingMessage: string
  runId?: string
  runtime: RunRuntime | string
  previewPolicy?: RunPreviewPolicy
  previewSessions?: Partial<Record<PreviewKind, RunPreviewSession>>
  shareToken?: string
}) {
  const isExpo = String(runtime).toLowerCase() === "expo"
  const defaultPolicy: RunPreviewPolicy = isExpo
    ? {
        default_kind: "desktop",
        previews: {
          desktop: { enabled: true, transport: "hap_install", start_mode: "on_demand" },
          phone: { enabled: true, transport: "hap_install", start_mode: "on_demand" },
        },
      }
    : {
        default_kind: "phone",
        previews: {
          phone: { enabled: true, transport: "hap_install", start_mode: "on_demand" },
        },
      }
  const resolvedPolicy = previewPolicy || defaultPolicy
  const availablePreviews = (["desktop", "phone"] as PreviewKind[]).filter(
    (kind) => resolvedPolicy.previews[kind]?.enabled,
  )
  const defaultPreview = availablePreviews.includes(resolvedPolicy.default_kind)
    ? resolvedPolicy.default_kind
    : availablePreviews[0] || (isExpo ? "desktop" : "phone")
  const [activePreview, setActivePreview] = useState<PreviewKind>(defaultPreview)
  const activeSession = previewSessions?.[activePreview]
  const activeArtifacts = artifacts.previews?.[activePreview] || artifacts
  const sessionStatus = String(activeSession?.status || ("status" in activeArtifacts ? activeArtifacts.status : "") || "").toLowerCase()
  // Build-time capture failures are separate from the user-triggered preview.
  const previewFailed = Boolean(activeSession?.requested && sessionStatus === "failed")
  const previewInactive = sessionStatus === "idle" || sessionStatus === "released"
  const previewStarting = ["queued", "allocating", "installing", "loading_bundle", "launching"].includes(sessionStatus)
  const previewInitiallyIdle = sessionStatus === "idle" && !activeSession?.requested
  const queuePosition = Number(activeSession?.queue_position || 0)
  const phoneNeedsRequest = activePreview === "phone" && isExpo && (
    !activeSession?.requested || previewInactive
  )
  const phonePreviewOutdated = activePreview === "phone" && isExpo && Boolean(activeSession?.outdated)
  const phoneRefreshAvailable = phonePreviewOutdated && Boolean(activeSession?.refresh_available)
  const desktopRefreshMessage = activePreview === "desktop" && isExpo
    ? activeSession?.outdated && ["queued", "building"].includes(String(activeSession.refresh_status || ""))
      ? "正在为最新修改构建 HAP…"
      : previewStarting
        ? desktopPreviewRefreshMessage(sessionStatus, queuePosition)
        : ""
    : ""
  const sessionScreenshot = activeSession?.screenshot_url || activeSession?.screenshot_path || ""
  const mediaPath = activeArtifacts.media_path || sessionScreenshot
  const hasMedia = Boolean((activeArtifacts.media_ready || sessionScreenshot) && mediaPath)
  const isVideo = !sessionScreenshot && (activeArtifacts.media_type === "mp4" || activeArtifacts.media_type === "webm")
  const liveEnabled = Boolean(runId && activeArtifacts.live_ready && activeArtifacts.live_frame_path && sessionStatus !== "released")
  const showInactiveAction = hasMedia && !liveEnabled && (
    previewFailed || phoneNeedsRequest || previewInactive
  )
  const [frameSource, setFrameSource] = useState("")
  const [liveError, setLiveError] = useState("")
  const [liveTransport, setLiveTransport] = useState<"connecting" | "webrtc" | "rest">(
    activeArtifacts.live_webrtc_config_path ? "connecting" : "rest",
  )
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === "visible")
  const viewerIdRef = useRef(createViewerId())
  const pointerStart = useRef<{ x: number; y: number; at: number } | null>(null)
  const lastWheelAt = useRef(0)
  const frameObjectUrlRef = useRef("")
  const latestFrameSequenceRef = useRef(0)
  const webRTCRef = useRef<LivePreviewWebRTC | null>(null)
  const previewContainerRef = useRef<HTMLDivElement | null>(null)
  const inputErrorUntilRef = useRef(0)
  const automaticStartAttemptRef = useRef("")
  const [fullscreenSupported, setFullscreenSupported] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [retryingPreview, setRetryingPreview] = useState(false)
  const [retryPreviewError, setRetryPreviewError] = useState("")

  useEffect(() => {
    if (availablePreviews.length && !availablePreviews.includes(activePreview)) {
      setActivePreview(defaultPreview)
    }
  }, [activePreview, availablePreviews.join("|"), defaultPreview])

  useEffect(() => {
    if (["idle", "ready", "failed", "released"].includes(sessionStatus)) {
      setRetryingPreview(false)
      if (!previewFailed) setRetryPreviewError("")
    }
  }, [previewFailed, sessionStatus])

  useEffect(() => {
    const startMode = resolvedPolicy.previews[activePreview]?.start_mode
    const attemptKey = `${runId || ""}:${activePreview}:${activeSession?.updated_at || "initial"}`
    if (
      !runId ||
      !pageVisible ||
      startMode !== "automatic" ||
      !previewInitiallyIdle ||
      retryingPreview ||
      automaticStartAttemptRef.current === attemptKey
    ) {
      return
    }
    automaticStartAttemptRef.current = attemptKey
    setRetryingPreview(true)
    setRetryPreviewError("")
    void api.startPreview(runId, activePreview, viewerIdRef.current, shareToken)
      .then(() => setRetryingPreview(false))
      .catch((error) => {
        setRetryingPreview(false)
        setRetryPreviewError(error instanceof Error ? error.message : "自动连接模拟器失败")
      })
  }, [activePreview, activeSession?.updated_at, pageVisible, previewInitiallyIdle, resolvedPolicy.previews, retryingPreview, runId, shareToken])

  useEffect(() => {
    latestFrameSequenceRef.current = 0
    inputErrorUntilRef.current = 0
    setRetryingPreview(false)
    setRetryPreviewError("")
    if (frameObjectUrlRef.current) {
      URL.revokeObjectURL(frameObjectUrlRef.current)
      frameObjectUrlRef.current = ""
    }
    setFrameSource("")
    setLiveError("")
    setLiveTransport(activeArtifacts.live_webrtc_config_path ? "connecting" : "rest")
  }, [activeArtifacts.live_frame_path, activeArtifacts.live_webrtc_config_path, activePreview, runId])

  useEffect(() => {
    const handleVisibilityChange = () => setPageVisible(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", handleVisibilityChange)
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange)
  }, [])

  useEffect(() => {
    if (!runId) return

    let timer = 0
    const reportHeartbeat = (keepalive = false, leaving = false) => {
      void api.heartbeatPreview(
        runId,
        activePreview,
        document.visibilityState === "visible",
        keepalive,
        viewerIdRef.current,
        shareToken,
        leaving,
      ).catch(() => undefined)
    }
    const handlePageHide = (event: PageTransitionEvent) => {
      // A BFCache transition is not a real departure; keep the viewer and
      // resume its heartbeat when the page is shown again.
      if (!event.persisted) reportHeartbeat(true, true)
    }
    const handlePageShow = () => reportHeartbeat(true, false)

    reportHeartbeat()
    timer = window.setInterval(() => reportHeartbeat(), 15_000)
    window.addEventListener("pagehide", handlePageHide)
    window.addEventListener("pageshow", handlePageShow)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("pagehide", handlePageHide)
      window.removeEventListener("pageshow", handlePageShow)
      reportHeartbeat(true, true)
    }
  }, [activePreview, runId, shareToken])

  // The component can mount before the first run snapshot arrives. The
  // initial heartbeat is then correctly ignored while the session is idle,
  // but without this status-triggered refresh a page opened onto an already
  // queued/ready preview would not register its viewer until the next 15s
  // interval. Register immediately whenever the live preview becomes active.
  useEffect(() => {
    if (!runId || !["queued", "allocating", "installing", "loading_bundle", "launching", "ready"].includes(sessionStatus)) {
      return
    }
    void api.heartbeatPreview(
      runId,
      activePreview,
      document.visibilityState === "visible",
      false,
      viewerIdRef.current,
      shareToken,
      false,
    ).catch(() => undefined)
  }, [activePreview, runId, sessionStatus, shareToken])

  useEffect(() => {
    setFullscreenSupported(Boolean(document.fullscreenEnabled && previewContainerRef.current?.requestFullscreen))
    const handleFullscreenChange = () => setIsFullscreen(document.fullscreenElement === previewContainerRef.current)
    document.addEventListener("fullscreenchange", handleFullscreenChange)
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange)
  }, [])

  useEffect(() => {
    if (!liveEnabled || !activeArtifacts.live_frame_path || !pageVisible || liveTransport === "webrtc") {
      if (frameObjectUrlRef.current) {
        if (!liveEnabled) {
          URL.revokeObjectURL(frameObjectUrlRef.current)
          frameObjectUrlRef.current = ""
        }
      }
      if (!liveEnabled) {
        setFrameSource("")
        setLiveError("")
      }
      return
    }

    let disposed = false
    let timer = 0
    let activeController: AbortController | null = null
    const scheduleNext = (delayMs = FRAME_REQUEST_RETRY_DELAY_MS) => {
      if (!disposed) timer = window.setTimeout(loadNextFrame, delayMs)
    }
    const loadNextFrame = async () => {
      if (pointerStart.current) {
        scheduleNext()
        return
      }
      let objectUrl = ""
      let retryDelayMs = FRAME_REQUEST_RETRY_DELAY_MS
      try {
        activeController = new AbortController()
        const separator = activeArtifacts.live_frame_path?.includes("?") ? "&" : "?"
        const query = new URLSearchParams({
          frame: String(Date.now()),
          after: String(latestFrameSequenceRef.current),
          wait_ms: String(FRAME_LONG_POLL_WAIT_MS),
        })
        const response = await fetch(`${activeArtifacts.live_frame_path}${separator}${query}`, {
          cache: "no-store",
          credentials: "same-origin",
          signal: activeController.signal,
        })
        if (!response.ok) throw new Error(`画面请求失败（${response.status}）`)
        const isStaleFrame = response.headers.get("X-Harmony-Preview-Status") === "stale"
        const frameSequence = Number(response.headers.get("X-Harmony-Preview-Sequence") || "0")
        objectUrl = URL.createObjectURL(await response.blob())
        const decodedFrame = new Image()
        decodedFrame.src = objectUrl
        await decodedFrame.decode()
        if (disposed) {
          URL.revokeObjectURL(objectUrl)
          return
        }
        const previousObjectUrl = frameObjectUrlRef.current
        if (Number.isSafeInteger(frameSequence) && frameSequence > 0) {
          latestFrameSequenceRef.current = Math.max(latestFrameSequenceRef.current, frameSequence)
        }
        frameObjectUrlRef.current = objectUrl
        setFrameSource(objectUrl)
        setLiveError(isStaleFrame ? "画面刷新暂时失败，正在显示最近一帧" : "")
        if (isStaleFrame) retryDelayMs = STALE_FRAME_RETRY_DELAY_MS
        if (previousObjectUrl) revokeAfterPaint(previousObjectUrl)
      } catch (error) {
        if (objectUrl) URL.revokeObjectURL(objectUrl)
        if (!disposed && !(error instanceof DOMException && error.name === "AbortError")) {
          setLiveError(error instanceof Error ? error.message : "无法连接本地模拟器")
        }
        retryDelayMs = FRAME_ERROR_RETRY_DELAY_MS
      } finally {
        activeController = null
        scheduleNext(retryDelayMs)
      }
    }
    void loadNextFrame()
    return () => {
      disposed = true
      activeController?.abort()
      window.clearTimeout(timer)
    }
  }, [activeArtifacts.live_frame_path, liveEnabled, liveTransport, pageVisible])

  useEffect(() => {
    if (!liveEnabled || !runId || !activeArtifacts.live_webrtc_config_path || !pageVisible) {
      webRTCRef.current?.close()
      webRTCRef.current = null
      return
    }
    let disposed = false
    let firstFrameReceived = false
    let firstFrameTimer = 0
    setLiveTransport("connecting")
    let client: LivePreviewWebRTC
    client = new LivePreviewWebRTC({
      runId,
      preview: artifacts.previews ? activePreview : "",
      shareToken,
      onOpen: () => {
        if (!disposed) {
          setLiveError("")
          window.clearTimeout(firstFrameTimer)
          firstFrameTimer = window.setTimeout(() => {
            if (disposed || firstFrameReceived) return
            setLiveTransport("rest")
            setLiveError("WebRTC 首帧超时，已自动切回 REST")
            client.close()
          }, WEBRTC_FIRST_FRAME_TIMEOUT_MS)
        }
      },
      onFallback: () => {
        window.clearTimeout(firstFrameTimer)
        if (!disposed) setLiveTransport("rest")
      },
      onInputError: (reason) => {
        if (!disposed) {
          inputErrorUntilRef.current = Date.now() + 3_000
          setLiveError(reason)
        }
      },
      onFrame: async (blob, metadata) => {
        if (disposed) return
        const objectUrl = URL.createObjectURL(blob)
        try {
          const decodedFrame = new Image()
          decodedFrame.src = objectUrl
          await decodedFrame.decode()
          if (disposed) {
            URL.revokeObjectURL(objectUrl)
            return
          }
          const previousObjectUrl = frameObjectUrlRef.current
          latestFrameSequenceRef.current = Math.max(
            latestFrameSequenceRef.current,
            metadata.sequence,
          )
          frameObjectUrlRef.current = objectUrl
          setFrameSource(objectUrl)
          if (metadata.stale) {
            setLiveError("WebRTC 正在显示最近一帧")
          } else if (Date.now() >= inputErrorUntilRef.current) {
            setLiveError("")
          }
          firstFrameReceived = true
          window.clearTimeout(firstFrameTimer)
          setLiveTransport("webrtc")
          if (previousObjectUrl) revokeAfterPaint(previousObjectUrl)
        } catch (error) {
          URL.revokeObjectURL(objectUrl)
          throw error
        }
      },
    })
    webRTCRef.current = client
    void client.connect()
    return () => {
      disposed = true
      window.clearTimeout(firstFrameTimer)
      client.close()
      if (webRTCRef.current === client) webRTCRef.current = null
    }
  }, [activeArtifacts.live_webrtc_config_path, activePreview, liveEnabled, pageVisible, runId, shareToken])

  useEffect(() => () => {
    if (frameObjectUrlRef.current) URL.revokeObjectURL(frameObjectUrlRef.current)
  }, [])

  const pointFor = (image: PreviewMediaElement, clientX: number, clientY: number) => {
    const bounds = image.getBoundingClientRect()
    const sourceWidth = (image instanceof HTMLVideoElement ? image.videoWidth : image.naturalWidth) || bounds.width
    const sourceHeight = (image instanceof HTMLVideoElement ? image.videoHeight : image.naturalHeight) || bounds.height
    const scale = Math.min(bounds.width / sourceWidth, bounds.height / sourceHeight)
    const renderedWidth = sourceWidth * scale
    const renderedHeight = sourceHeight * scale
    const left = bounds.left + (bounds.width - renderedWidth) / 2
    const top = bounds.top + (bounds.height - renderedHeight) / 2
    if (clientX < left || clientX > left + renderedWidth || clientY < top || clientY > top + renderedHeight) {
      return null
    }
    return {
      x: clamp((clientX - left) / renderedWidth),
      y: clamp((clientY - top) / renderedHeight),
    }
  }

  const sendInput = async (body: LivePreviewInput) => {
    if (!runId) return
    if (liveTransport === "webrtc" && webRTCRef.current?.sendInput(body)) {
      setLiveError("")
      return
    }
    try {
      setLiveError("")
      await api.sendLiveInput(runId, artifacts.previews ? activePreview : "", body, shareToken)
    } catch (error) {
      setLiveError(error instanceof Error ? error.message : "模拟器操作失败")
    }
  }

  const onPointerDown = (event: PointerEvent<PreviewMediaElement>) => {
    if (!liveEnabled || !event.isPrimary || event.button !== 0) return
    const point = pointFor(event.currentTarget, event.clientX, event.clientY)
    if (!point) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    pointerStart.current = { ...point, at: Date.now() }
  }

  const onPointerUp = (event: PointerEvent<PreviewMediaElement>) => {
    if (!liveEnabled || !event.isPrimary || !pointerStart.current) return
    event.preventDefault()
    const start = pointerStart.current
    pointerStart.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const end = pointFor(event.currentTarget, event.clientX, event.clientY)
    if (!end) return
    const distance = Math.hypot(end.x - start.x, end.y - start.y)
    if (distance < 0.025) {
      void sendInput({ type: "tap", point: end })
      return
    }
    const verticalSwipe = Math.abs(end.y - start.y) >= Math.abs(end.x - start.x)
    const minimumScrollDistance = 0.22
    const adjustedEnd = verticalSwipe && distance < minimumScrollDistance
      ? { ...end, y: clamp(start.y + Math.sign(end.y - start.y) * minimumScrollDistance) }
      : end
    void sendInput({
      type: "swipe",
      start,
      end: adjustedEnd,
      duration_ms: Math.max(140, Math.min(Date.now() - start.at, 900)),
    })
  }

  const scrollPreview = (contentDirection: "up" | "down") => {
    void sendInput({ type: "scroll", direction: contentDirection })
  }

  const onWheel = (event: WheelEvent<PreviewMediaElement>) => {
    if (!liveEnabled || Math.abs(event.deltaY) < 4) return
    const point = pointFor(event.currentTarget, event.clientX, event.clientY)
    if (!point) return
    event.preventDefault()
    const now = Date.now()
    if (now - lastWheelAt.current < 180) return
    lastWheelAt.current = now
    scrollPreview(event.deltaY > 0 ? "down" : "up")
  }

  const toggleFullscreen = async () => {
    if (!previewContainerRef.current || !fullscreenSupported) return
    try {
      if (document.fullscreenElement === previewContainerRef.current) {
        await document.exitFullscreen()
      } else {
        await previewContainerRef.current.requestFullscreen()
      }
    } catch {
      setFullscreenSupported(false)
    }
  }

  const startPreview = async () => {
    if (!runId || retryingPreview) return
    setRetryingPreview(true)
    setRetryPreviewError("")
    try {
      await api.startPreview(runId, activePreview, viewerIdRef.current, shareToken)
      setRetryingPreview(false)
    } catch (error) {
      setRetryingPreview(false)
      setRetryPreviewError(error instanceof Error ? error.message : "重新预览失败")
    }
  }

  const startAction = runId ? (
    <button
      type="button"
      disabled={retryingPreview || previewStarting || (phonePreviewOutdated && !phoneRefreshAvailable)}
      onClick={() => void startPreview()}
      className={`inline-flex h-11 w-full max-w-[300px] items-center justify-center gap-2 rounded-xl border px-5 text-sm font-semibold shadow-lg transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-wait disabled:opacity-60 disabled:hover:translate-y-0 ${
        previewFailed
          ? "border-danger/50 bg-danger/12 text-danger shadow-danger/10 hover:-translate-y-0.5 hover:bg-danger/18"
          : activePreview === "phone"
            ? "border-accent/80 bg-accent text-background shadow-accent/30 hover:-translate-y-0.5 hover:bg-accent-soft hover:shadow-accent/40"
            : "border-accent/60 bg-accent/15 text-accent-soft shadow-accent/15 hover:-translate-y-0.5 hover:border-accent hover:bg-accent/25 hover:text-foreground"
      }`}
    >
      {retryingPreview || previewStarting
        ? <PreviewLoadingIcon />
        : previewFailed
          ? <RetryIcon />
          : <PreviewPlayIcon />}
      {retryingPreview || previewStarting
        ? "正在排队…"
        : phoneRefreshAvailable
          ? "刷新手机预览"
          : previewFailed
            ? `重新预览${activePreview === "phone" ? "手机" : "PC"}`
            : activePreview === "phone"
              ? "在手机模拟器上预览"
              : "在 PC 模拟器中预览"}
    </button>
  ) : null

  const previewContent = frameSource ? (
      <img
        src={frameSource}
        alt="可交互的本地模拟器预览"
        className="h-full w-full touch-none select-none object-contain"
        decoding="async"
        fetchPriority="high"
        draggable={false}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { pointerStart.current = null }}
        onWheel={onWheel}
      />
  ) : hasMedia ? (
    isVideo ? (
      <video
        src={withCacheBust(mediaPath)}
        className="h-full w-full object-contain"
        autoPlay
        loop
        muted
        playsInline
      />
    ) : (
      <img
        src={withCacheBust(mediaPath)}
        alt="应用运行效果预览"
        className="h-full w-full object-contain"
      />
    )
  ) : liveEnabled ? (
    <WaitingState message="正在连接本地模拟器…" />
  ) : (
    <WaitingState
      message={
        retryingPreview || previewStarting
          ? previewStatusMessage(sessionStatus, activePreview, queuePosition)
            : phonePreviewOutdated && !phoneRefreshAvailable
            ? activeSession?.refresh_status === "failed"
              ? activeSession?.refresh_error || "最新预览 HAP 构建失败。"
              : "正在为最新修改构建 HAP…"
              : previewFailed
              ? activeSession?.error || ("error" in activeArtifacts ? activeArtifacts.error : "") || "设备预览失败，生成产物仍然可用。"
              : phoneNeedsRequest || previewInactive
                ? hasMedia
                  ? "当前显示最后一次预览画面；模拟器会话已释放。"
                  : ""
                : waitingMessage
      }
      failed={previewFailed}
      action={(previewFailed || phoneNeedsRequest || previewInactive) ? startAction : null}
      error={retryPreviewError}
    />
  )

  // Reserve vertical room for the page header, controls and status.
  // Phone preview is intentionally shorter so it never stretches the two-column page.
  const fittedPreviewWidth = activePreview === "phone"
    ? "min(300px, max(194px, calc(46.2185dvh - 120.17px)))"
    : "min(100%, max(420px, calc(150dvh - 330px)))"

  return (
    <div className="flex flex-col items-center">
      {isExpo && availablePreviews.length > 1 && (
        <div className="mb-3 inline-flex rounded-lg bg-black/20 p-0.5 ring-1 ring-white/[0.06]" role="tablist" aria-label="预览设备">
          {availablePreviews.map((kind) => (
            <button
              key={kind}
              type="button"
              role="tab"
              aria-selected={activePreview === kind}
              onClick={() => setActivePreview(kind)}
              className={`rounded-md px-4 py-1.5 text-xs font-medium transition-colors ${
                activePreview === kind
                  ? "bg-accent text-background shadow-sm shadow-accent/25"
                  : "text-muted hover:bg-white/[0.05] hover:text-foreground"
              }`}
            >
              {kind === "desktop" ? "PC" : "手机"}
            </button>
          ))}
        </div>
      )}
      <div ref={previewContainerRef} className="relative mx-auto w-full">
        <div
          className={`relative mx-auto flex w-full flex-col gap-2 ${activePreview === "phone" ? "max-w-[300px]" : ""}`}
          style={{
            width: isFullscreen
              ? activePreview === "phone"
                ? "min(calc(100vw - 32px), calc(46.22vh - 31px))"
                : "min(calc(100vw - 32px), calc(150vh - 102px))"
              : fittedPreviewWidth,
          }}
        >
          <div className="flex h-8 items-center px-1">
            <span className={`mr-2 h-1.5 w-1.5 rounded-full ${liveEnabled ? "bg-success shadow-[0_0_8px_rgba(73,222,128,0.55)]" : "bg-white/20"}`} />
            <span className="select-none text-[11px] font-medium text-muted">
              {activePreview === "phone" ? "HarmonyOS 手机模拟器" : "HarmonyOS PC 模拟器"}
            </span>
            {activePreview === "desktop" && fullscreenSupported && (
              <button
                type="button"
                onClick={() => void toggleFullscreen()}
                className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-muted transition-colors hover:bg-white/[0.06] hover:text-foreground"
                aria-label={isFullscreen ? "退出全屏" : "全屏查看模拟器"}
              >
                <FullscreenIcon active={isFullscreen} />
                {isFullscreen ? "退出全屏" : "全屏查看"}
              </button>
            )}
          </div>
          <div
            className={`relative w-full overflow-hidden bg-[#050607] shadow-[0_12px_36px_rgba(0,0,0,0.22)] ring-1 ring-white/[0.07] ${
              activePreview === "phone" ? "rounded-[22px]" : "rounded-lg"
            }`}
            style={{ aspectRatio: activePreview === "phone" ? "1320 / 2856" : "3 / 2" }}
          >
            {previewContent}
            {desktopRefreshMessage ? (
              <div
                className="pointer-events-none absolute inset-x-3 bottom-3 z-10 flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-black/75 px-3 py-2.5 text-xs font-medium text-white shadow-xl backdrop-blur-md"
                role="status"
                aria-live="polite"
              >
                <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-white/25 border-t-accent" aria-hidden="true" />
                <span>{desktopRefreshMessage}</span>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {showInactiveAction ? (
        <div className="mt-3 flex flex-col items-center gap-2">
          <p className={`max-w-[320px] text-center text-xs leading-relaxed ${previewFailed ? "text-warning" : "text-subtle"}`}>
            {previewFailed
              ? activeSession?.error || "实时模拟器会话失败，当前显示最后一次预览画面。"
              : "当前显示最后一次预览画面，模拟器会话未连接。"}
          </p>
          {startAction}
          {retryPreviewError ? <p className="max-w-[300px] text-center text-xs text-warning">{retryPreviewError}</p> : null}
        </div>
      ) : null}

      {phonePreviewOutdated && (hasMedia || liveEnabled) && !showInactiveAction ? (
        <div className="mt-3 flex w-full max-w-[320px] flex-col items-center gap-2">
          {phoneRefreshAvailable ? startAction : (
            <p className={`text-center text-xs leading-relaxed ${activeSession?.refresh_status === "failed" ? "text-warning" : "text-subtle"}`}>
              {activeSession?.refresh_status === "failed"
                ? activeSession?.refresh_error || "最新预览 HAP 构建失败。"
                : "最新修改正在生成 HAP，完成后可刷新手机模拟器。"}
            </p>
          )}
          {retryPreviewError ? <p className="text-center text-xs text-warning">{retryPreviewError}</p> : null}
        </div>
      ) : liveEnabled && liveError ? (
        <p className="mt-3 max-w-[320px] text-center text-xs leading-relaxed text-warning">
          {liveError}
        </p>
      ) : liveEnabled ? (
        <p className="mt-3 max-w-[320px] text-center text-xs leading-relaxed text-subtle">
          {liveTransport === "webrtc"
            ? "WebRTC 直连"
            : liveTransport === "connecting"
              ? "正在尝试 WebRTC 直连，当前由 REST 保持画面"
              : "REST 回退链路"}
        </p>
      ) : null}
    </div>
  )
}

function FullscreenIcon({ active }: { active: boolean }) {
  return active ? (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
      <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
      <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PreviewPlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">
      <path d="M5.25 3.75 11 8l-5.75 4.25V3.75Z" fill="currentColor" />
    </svg>
  )
}

function RetryIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">
      <path d="M13 7.25A5 5 0 1 0 12.2 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M13 3.75v3.5H9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PreviewLoadingIcon() {
  return (
    <span
      className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current/30 border-t-current"
      aria-hidden="true"
    />
  )
}

function previewStatusMessage(status: string, kind: PreviewKind, queuePosition = 0) {
  switch (status) {
    case "queued":
    case "allocating":
      return queuePosition > 0
        ? `正在排队，当前第 ${queuePosition} 位`
        : "正在排队…"
    case "installing":
      return `正在安装 HAP 到${kind === "phone" ? "手机" : "PC"}模拟器…`
    case "loading_bundle":
      return "正在恢复 PC 模拟器预览…"
    case "launching":
      return "应用已安装，正在等待首帧…"
    default:
      return "正在排队…"
  }
}

function desktopPreviewRefreshMessage(status: string, queuePosition = 0) {
  switch (status) {
    case "queued":
    case "allocating":
      return queuePosition > 0
        ? `正在排队，当前第 ${queuePosition} 位`
        : "正在排队…"
    case "installing":
      return "正在安装最新 HAP 到 PC 模拟器…"
    case "loading_bundle":
    case "launching":
      return "安装完成，正在等待应用首帧…"
    default:
      return "最新 HAP 已就绪，正在刷新 PC 预览…"
  }
}

function clamp(value: number) {
  return Math.min(1, Math.max(0, value))
}

function revokeAfterPaint(objectUrl: string) {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => URL.revokeObjectURL(objectUrl))
  })
}

function WaitingState({
  message,
  failed = false,
  action = null,
  error = "",
}: {
  message: string
  failed?: boolean
  action?: ReactNode
  error?: string
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-5 px-6 text-center">
      {(failed || !action) && <div className="relative flex h-16 w-16 items-center justify-center">
        <span className={`absolute inset-0 rounded-2xl ${failed ? "bg-warning/15" : "bg-accent/15"}`} />
        {failed ? (
          <svg className="text-warning" viewBox="0 0 24 24" width="30" height="30" fill="none" aria-hidden="true">
            <path d="M12 8v5m0 3.5v.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            <path d="M10.3 4.2 3.1 17a2 2 0 0 0 1.75 3h14.3a2 2 0 0 0 1.75-3L13.7 4.2a2 2 0 0 0-3.4 0Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg className="animate-spin text-accent" viewBox="0 0 24 24" width="28" height="28" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        )}
      </div>}
      {message ? <p className="text-sm leading-relaxed text-muted">{message}</p> : null}
      {action}
      {error ? <p className="max-w-[300px] text-xs leading-relaxed text-warning">{error}</p> : null}
    </div>
  )
}
