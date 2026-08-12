import { type PointerEvent, type WheelEvent, useEffect, useRef, useState } from "react"
import { api, withCacheBust } from "@/lib/api"
import { LivePreviewWebRTC } from "@/lib/livePreviewWebRTC"
import type { RunArtifacts } from "@/lib/types"

type PreviewMediaElement = HTMLImageElement | HTMLVideoElement
const FRAME_REQUEST_RETRY_DELAY_MS = 25
const FRAME_LONG_POLL_WAIT_MS = 1000
const STALE_FRAME_RETRY_DELAY_MS = 500
const FRAME_ERROR_RETRY_DELAY_MS = 1000
const WEBRTC_FIRST_FRAME_TIMEOUT_MS = 5_000

export function DevicePreview({
  artifacts,
  waitingMessage,
  runId,
}: {
  artifacts: RunArtifacts
  waitingMessage: string
  runId?: string
}) {
  const hasMedia = artifacts.media_ready && artifacts.media_path
  const isVideo = artifacts.media_type === "mp4" || artifacts.media_type === "webm"
  const liveEnabled = Boolean(runId && artifacts.live_ready && artifacts.live_frame_path)
  const [frameSource, setFrameSource] = useState("")
  const [liveError, setLiveError] = useState("")
  const [liveTransport, setLiveTransport] = useState<"connecting" | "webrtc" | "rest">(
    artifacts.live_webrtc_config_path ? "connecting" : "rest",
  )
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === "visible")
  const pointerStart = useRef<{ x: number; y: number; at: number } | null>(null)
  const lastWheelAt = useRef(0)
  const frameObjectUrlRef = useRef("")
  const latestFrameSequenceRef = useRef(0)
  const webRTCRef = useRef<LivePreviewWebRTC | null>(null)
  const inputErrorUntilRef = useRef(0)

  useEffect(() => {
    latestFrameSequenceRef.current = 0
    inputErrorUntilRef.current = 0
    setLiveTransport(artifacts.live_webrtc_config_path ? "connecting" : "rest")
  }, [artifacts.live_frame_path, runId])

  useEffect(() => {
    const handleVisibilityChange = () => setPageVisible(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", handleVisibilityChange)
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange)
  }, [])

  useEffect(() => {
    if (!liveEnabled || !artifacts.live_frame_path || !pageVisible || liveTransport === "webrtc") {
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
        const separator = artifacts.live_frame_path?.includes("?") ? "&" : "?"
        const query = new URLSearchParams({
          frame: String(Date.now()),
          after: String(latestFrameSequenceRef.current),
          wait_ms: String(FRAME_LONG_POLL_WAIT_MS),
        })
        const response = await fetch(`${artifacts.live_frame_path}${separator}${query}`, {
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
  }, [artifacts.live_frame_path, liveEnabled, liveTransport, pageVisible])

  useEffect(() => {
    if (!liveEnabled || !runId || !artifacts.live_webrtc_config_path || !pageVisible) {
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
  }, [artifacts.live_webrtc_config_path, liveEnabled, pageVisible, runId])

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

  const sendInput = async (body: Parameters<typeof api.sendLiveInput>[1]) => {
    if (!runId) return
    if (liveTransport === "webrtc" && webRTCRef.current?.sendInput(body)) {
      setLiveError("")
      return
    }
    try {
      setLiveError("")
      await api.sendLiveInput(runId, body)
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

  return (
    <div className="flex flex-col items-center">
      <div className="relative mx-auto w-full max-w-[420px]">
        <div className="relative aspect-[9/16] rounded-[1.5rem] border border-border-strong bg-black p-1.5 shadow-2xl shadow-black/60">
          <div className="relative h-full w-full overflow-hidden rounded-[1.15rem] bg-black">
            {liveEnabled ? (
              frameSource ? (
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
              ) : (
                <WaitingState message="正在连接本地模拟器…" />
              )
            ) : hasMedia ? (
              isVideo ? (
                <video
                  src={withCacheBust(artifacts.media_path)}
                  className="h-full w-full object-contain"
                  autoPlay
                  loop
                  muted
                  playsInline
                />
              ) : (
                <img
                  src={withCacheBust(artifacts.media_path)}
                  alt="应用运行效果预览"
                  className="h-full w-full object-contain"
                />
              )
            ) : (
              <WaitingState message={waitingMessage} />
            )}
          </div>
        </div>
      </div>

      {liveEnabled && liveError ? (
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
      ) : !liveEnabled ? (
        <p className="mt-3 max-w-[260px] text-center text-xs leading-relaxed text-subtle">
          {hasMedia ? "已切换为真机运行效果" : "构建完成后这里会显示真机运行画面"}
        </p>
      ) : null}
    </div>
  )
}

function clamp(value: number) {
  return Math.min(1, Math.max(0, value))
}

function revokeAfterPaint(objectUrl: string) {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => URL.revokeObjectURL(objectUrl))
  })
}

function WaitingState({ message }: { message: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-5 px-6 text-center">
      <div className="relative flex h-16 w-16 items-center justify-center">
        <span className="absolute inset-0 rounded-2xl bg-accent/15" />
        <svg className="animate-spin text-accent" viewBox="0 0 24 24" width="28" height="28" fill="none">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
          <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      </div>
      <p className="text-sm leading-relaxed text-muted">{message}</p>
    </div>
  )
}
