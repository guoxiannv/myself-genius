import { useEffect, useRef, useState } from "react"
import { api } from "@/lib/api"
import type { RunProgress } from "@/lib/types"

type Transport = "connecting" | "sse" | "polling" | "error"

interface RunStreamState {
  data: RunProgress | null
  error: string | null
  transport: Transport
  /** 主构建是否进入终态；详情页仍持续同步预览租约与队列状态。 */
  finished: boolean
}

const TERMINAL_STATUSES = new Set([
  "complete",
  "completed",
  "done",
  "succeeded",
  "success",
  "ready",
  "failed",
  "error",
  "cancelled",
  "canceled",
])
const DEFAULT_POLL_MS = 3000

/**
 * 订阅单个 run 的实时进度。
 * 优先尝试 SSE（GET /api/runs/:id/events），后端暂未实现时自动降级为轮询。
 * 后端补上 SSE 端点后，本 hook 无需改动即可启用推送。
 */
export function useRunStream(runId: string | undefined, shareToken = ""): RunStreamState {
  const [data, setData] = useState<RunProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [transport, setTransport] = useState<Transport>("connecting")
  const [finished, setFinished] = useState(false)

  const finishedRef = useRef(false)
  const interactiveRef = useRef(false)
  const progressRef = useRef<RunProgress | null>(null)

  useEffect(() => {
    if (!runId) return

    finishedRef.current = false
    interactiveRef.current = false
    progressRef.current = null
    setFinished(false)
    setData(null)
    setError(null)
    setTransport("connecting")

    let cancelled = false
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    let eventSource: EventSource | null = null

    const markFinished = (progress: RunProgress) => {
      if (TERMINAL_STATUSES.has(String(progress.status).trim().toLowerCase())) {
        finishedRef.current = true
        setFinished(true)
      }
    }

    const applyProgress = (progress: RunProgress) => {
      if (cancelled) return
      // 详情页本身就是预览控制面。即使主构建已经结束、访问者没有代码
      // 写权限，也必须继续同步模拟器排队、连接和释放状态。
      interactiveRef.current = true
      progressRef.current = progress
      setData(progress)
      setError(null)
      markFinished(progress)
    }

    const poll = async () => {
      if (cancelled || (finishedRef.current && !interactiveRef.current)) return
      try {
        const progress = await api.getRun(runId, shareToken)
        if (cancelled) return
        applyProgress(progress)
        setTransport((prev) => (prev === "sse" ? prev : "polling"))
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : "状态获取失败")
        setTransport("error")
      } finally {
        if (!cancelled && (!finishedRef.current || interactiveRef.current)) {
          const latest = progressRef.current
          const status = latest?.follow_up?.status
          const distributionStatus = latest?.artifacts?.distribution_status
          const interval = distributionStatus === "packaging" ? 1000 : status === "running" ? 1500 : status === "interrupting" ? 750 : status === "idle" ? 5000 : latest?.ui.poll_interval_ms || DEFAULT_POLL_MS
          pollTimer = setTimeout(poll, interval)
        }
      }
    }

    const startPolling = () => {
      if (cancelled) return
      void poll()
    }

    const startSse = () => {
      if (typeof window === "undefined" || typeof EventSource === "undefined") {
        startPolling()
        return
      }

      try {
        const query = shareToken ? `?share=${encodeURIComponent(shareToken)}` : ""
        eventSource = new EventSource(`/api/runs/${runId}/events${query}`)
      } catch {
        startPolling()
        return
      }

      eventSource.onmessage = (event) => {
        try {
          const progress = JSON.parse(event.data) as RunProgress
          applyProgress(progress)
          setTransport("sse")
          if (finishedRef.current && !interactiveRef.current) eventSource?.close()
        } catch {
          /* 忽略心跳或非 JSON 帧 */
        }
      }

      eventSource.onerror = () => {
        // SSE 不可用（端点未实现或断连）→ 关闭并降级为轮询
        eventSource?.close()
        eventSource = null
        if (!cancelled && (!finishedRef.current || interactiveRef.current)) startPolling()
      }
    }

    // 先抓一次初始状态，保证首屏立刻有数据，再建立流。
    void api
      .getRun(runId, shareToken)
      .then((progress) => {
        applyProgress(progress)
        if (!finishedRef.current || interactiveRef.current) startSse()
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : "状态获取失败")
        startSse()
      })

    return () => {
      cancelled = true
      if (pollTimer) clearTimeout(pollTimer)
      eventSource?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, shareToken])

  return { data, error, transport, finished }
}
