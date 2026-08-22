import { ApiError, api } from "./api"
import type { LivePreviewInput } from "./types"

function createRequestId(prefix: string) {
  return globalThis.crypto?.randomUUID?.()
    || `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export interface WebRTCFrameMetadata {
  sequence: number
  width: number
  height: number
  size: number
  chunks: number
  stale: boolean
  request_ids: string[]
}

type WebRTCPreviewOptions = {
  runId: string
  preview?: string
  shareToken?: string
  onOpen: () => void
  onFallback: (reason: string) => void
  onInputError: (reason: string) => void
  onFrame: (blob: Blob, metadata: WebRTCFrameMetadata) => Promise<void>
}

type PendingFrame = {
  metadata: WebRTCFrameMetadata
  chunks: ArrayBuffer[]
  receivedBytes: number
}

export class LivePreviewWebRTC {
  private readonly options: WebRTCPreviewOptions
  private pc: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private pendingFrame: PendingFrame | null = null
  private inputStartedAt = new Map<string, number>()
  private closed = false
  private fallbackReported = false
  private disconnectTimer = 0

  constructor(options: WebRTCPreviewOptions) {
    this.options = options
  }

  async connect(): Promise<void> {
    try {
      const config = await retrySignaling(
        () => api.getLiveWebRTCConfig(
          this.options.runId,
          this.options.preview,
          this.options.shareToken,
        ),
        () => this.closed,
      )
      if (!config.available) throw new Error("服务端 WebRTC 不可用")
      const pc = new RTCPeerConnection({ iceServers: config.ice_servers })
      this.pc = pc
      if (this.closed) {
        pc.close()
        return
      }
      const channel = pc.createDataChannel("harmony-preview", { ordered: true })
      channel.binaryType = "arraybuffer"
      this.channel = channel
      this.bindChannel(channel)

      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "connected") {
          window.clearTimeout(this.disconnectTimer)
        } else if (pc.connectionState === "failed") {
          this.fallback(`WebRTC ${pc.connectionState}`)
        } else if (pc.connectionState === "disconnected") {
          window.clearTimeout(this.disconnectTimer)
          this.disconnectTimer = window.setTimeout(() => {
            if (pc.connectionState === "disconnected") this.fallback("WebRTC disconnected")
          }, 3_000)
        }
      })

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await waitForIceGathering(pc, 5_000)
      if (this.closed) return
      if (!pc.localDescription) throw new Error("浏览器未生成 WebRTC offer")
      const signalingId = createRequestId("signal")
      const answer = await retrySignaling(
        () => api.createLiveWebRTCAnswer(
          config.offer_path,
          pc.localDescription!.sdp,
          pc.localDescription!.type,
          signalingId,
        ),
        () => this.closed,
      )
      if (this.closed) return
      await pc.setRemoteDescription({ sdp: answer.sdp, type: answer.type })
      await waitForChannelOpen(channel, config.connect_timeout_ms || 10_000)
      if (this.closed) return
      this.options.onOpen()
      window.setTimeout(() => void this.reportDiagnostic(), 500)
    } catch (error) {
      this.fallback(error instanceof Error ? error.message : "WebRTC 建连失败")
    }
  }

  sendInput(payload: LivePreviewInput): boolean {
    const channel = this.channel
    if (!channel || channel.readyState !== "open" || this.closed) return false
    const requestId = createRequestId("input")
    this.inputStartedAt.set(requestId, performance.now())
    channel.send(JSON.stringify({ type: "input", request_id: requestId, payload }))
    return true
  }

  close(): void {
    this.closed = true
    window.clearTimeout(this.disconnectTimer)
    this.pendingFrame = null
    this.inputStartedAt.clear()
    this.channel?.close()
    this.pc?.close()
    this.channel = null
    this.pc = null
  }

  private bindChannel(channel: RTCDataChannel): void {
    channel.addEventListener("close", () => {
      if (!this.closed) this.fallback("WebRTC DataChannel 已关闭")
    })
    channel.addEventListener("error", () => this.fallback("WebRTC DataChannel 异常"))
    channel.addEventListener("message", (event) => void this.handleMessage(event.data))
  }

  private async handleMessage(data: unknown): Promise<void> {
    if (typeof data === "string") {
      let message: Record<string, unknown>
      try {
        message = JSON.parse(data) as Record<string, unknown>
      } catch {
        return
      }
      if (message.type === "frame") {
        this.pendingFrame = {
          metadata: message as unknown as WebRTCFrameMetadata,
          chunks: [],
          receivedBytes: 0,
        }
      }
      if (message.type === "input_ack" && message.ok === false) {
        const requestId = String(message.request_id || "")
        this.inputStartedAt.delete(requestId)
        this.options.onInputError(String(message.error || "模拟器操作失败"))
      }
      return
    }
    if (data instanceof Blob) data = await data.arrayBuffer()
    if (!(data instanceof ArrayBuffer) || !this.pendingFrame) return
    const pending = this.pendingFrame
    pending.chunks.push(data)
    pending.receivedBytes += data.byteLength
    if (pending.chunks.length < pending.metadata.chunks) return
    this.pendingFrame = null
    if (pending.receivedBytes !== pending.metadata.size) return
    const blob = new Blob(pending.chunks, { type: "image/jpeg" })
    try {
      await this.options.onFrame(blob, pending.metadata)
    } catch {
      this.fallback("WebRTC 帧解码失败")
      return
    }
    const completedAt = performance.now()
    for (const requestId of pending.metadata.request_ids || []) {
      const startedAt = this.inputStartedAt.get(requestId)
      if (startedAt === undefined) continue
      this.inputStartedAt.delete(requestId)
      this.sendMetric({
        type: "latency",
        request_id: requestId,
        click_to_frame_ms: completedAt - startedAt,
        frame_sequence: pending.metadata.sequence,
        frame_bytes: pending.metadata.size,
      })
    }
  }

  private async reportDiagnostic(attempt = 0): Promise<void> {
    const pc = this.pc
    if (!pc || this.closed) return
    if (pc.connectionState !== "connected") {
      if (attempt < 10) window.setTimeout(() => void this.reportDiagnostic(attempt + 1), 500)
      return
    }
    const stats = await pc.getStats()
    let selectedPair: Record<string, unknown> | undefined
    stats.forEach((item) => {
      const stat = item as unknown as Record<string, unknown>
      if (
        stat.type === "candidate-pair"
        && stat.state === "succeeded"
        && (stat.nominated === true || stat.selected === true)
      ) {
        selectedPair = stat
      }
    })
    if (!selectedPair) {
      if (attempt < 10) window.setTimeout(() => void this.reportDiagnostic(attempt + 1), 500)
      return
    }
    const local = stats.get(String(selectedPair.localCandidateId || "")) as unknown as Record<string, unknown> | undefined
    const remote = stats.get(String(selectedPair.remoteCandidateId || "")) as unknown as Record<string, unknown> | undefined
    this.sendMetric({
      type: "diagnostic",
      local_candidate_type: String(local?.candidateType || ""),
      remote_candidate_type: String(remote?.candidateType || ""),
      candidate_protocol: String(local?.protocol || ""),
      current_rtt_ms: Number(selectedPair.currentRoundTripTime || 0) * 1000,
    })
  }

  private sendMetric(payload: Record<string, unknown>): void {
    if (this.channel?.readyState === "open") {
      this.channel.send(JSON.stringify(payload))
    }
  }

  private fallback(reason: string): void {
    if (this.closed || this.fallbackReported) return
    this.fallbackReported = true
    this.options.onFallback(reason)
    this.close()
  }
}

async function retrySignaling<T>(
  operation: () => Promise<T>,
  isCancelled: () => boolean,
): Promise<T> {
  const retryDelaysMs = [250, 600, 1_200]
  let lastError: unknown
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    if (isCancelled()) throw new Error("WebRTC 建连已取消")
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt >= retryDelaysMs.length || !isRetriableSignalingError(error)) break
      await new Promise<void>((resolve) => window.setTimeout(resolve, retryDelaysMs[attempt]))
    }
  }
  throw lastError
}

function isRetriableSignalingError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true
  return error.status === 502 || error.status === 503 || error.status === 504
}

function waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve()
  return new Promise((resolve) => {
    const timer = window.setTimeout(done, timeoutMs)
    function done() {
      window.clearTimeout(timer)
      pc.removeEventListener("icegatheringstatechange", onChange)
      resolve()
    }
    function onChange() {
      if (pc.iceGatheringState === "complete") done()
    }
    pc.addEventListener("icegatheringstatechange", onChange)
  })
}

function waitForChannelOpen(channel: RTCDataChannel, timeoutMs: number): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => finish(new Error("WebRTC 直连超时")), timeoutMs)
    function finish(error?: Error) {
      window.clearTimeout(timer)
      channel.removeEventListener("open", onOpen)
      channel.removeEventListener("close", onClose)
      if (error) reject(error)
      else resolve()
    }
    const onOpen = () => finish()
    const onClose = () => finish(new Error("WebRTC 通道提前关闭"))
    channel.addEventListener("open", onOpen)
    channel.addEventListener("close", onClose)
  })
}
