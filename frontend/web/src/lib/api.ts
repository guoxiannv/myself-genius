import type {
  AuthState,
  CreateRunRequest,
  CreateRunResponse,
  FollowUpActionResponse,
  HealthPayload,
  LivePreviewInput,
  PreviewKind,
  RunListResponse,
  RunPreviewSession,
  RunProgress,
  ExpoServeState,
} from "./types"

export class ApiError extends Error {
  status: number
  payload: unknown

  constructor(message: string, status: number, payload: unknown) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.payload = payload
  }
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  })

  const text = await response.text()
  const data = text ? safeParse(text) : null

  if (!response.ok) {
    const message =
      (data && typeof data === "object" && "error" in data
        ? String((data as Record<string, unknown>).error)
        : "") || `请求失败（${response.status}）`
    throw new ApiError(message, response.status, data)
  }

  return data as T
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export const api = {
  createRun: (body: CreateRunRequest) =>
    request<CreateRunResponse>("/api/runs", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getRun: (runId: string) => request<RunProgress>(`/api/runs/${runId}`),

  getRuns: () => request<RunListResponse>("/api/runs"),

  getAuthMe: () => request<AuthState>("/api/auth/me"),

  login: (password: string) =>
    request<AuthState>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  logout: () => request<AuthState>("/api/auth/logout", { method: "POST" }),

  answerQuestion: (runId: string, questionId: string, answers: Record<string, string>) =>
    request<{ ok: boolean }>(`/api/runs/${runId}/questions/${questionId}/answer`, {
      method: "POST",
      body: JSON.stringify({ answers }),
    }),

  /** 对当前工作区的最新代码执行编译、签名并生成扫码安装页。 */
  packageRun: (runId: string) =>
    request<{ ok: boolean; accepted: boolean; status: string }>(`/api/runs/${runId}/package`, {
      method: "POST",
      body: "{}",
    }),

  publishExpoRun: (runId: string) =>
    request<{ ok: boolean; accepted: boolean; serve: ExpoServeState }>(`/api/runs/${runId}/expo-serve`, {
      method: "POST",
      body: "{}",
    }),

  unpublishExpoRun: (runId: string) =>
    request<{ ok: boolean; accepted: boolean; serve: ExpoServeState }>(`/api/runs/${runId}/expo-serve`, {
      method: "DELETE",
      body: "{}",
    }),

  startPreview: (runId: string, kind: PreviewKind) =>
    request<{
      ok: boolean
      accepted: boolean
      run_id: string
      status: string
      preview?: RunPreviewSession
    }>(`/api/runs/${runId}/previews/${kind}/start`, {
      method: "POST",
      body: "{}",
    }),

  heartbeatPreview: (runId: string, kind: PreviewKind, visible: boolean, keepalive = false) =>
    request<{ ok: boolean; run_id: string; kind: PreviewKind; visible: boolean }>(
      `/api/runs/${runId}/previews/${kind}/heartbeat`,
      {
        method: "POST",
        body: JSON.stringify({ visible }),
        keepalive,
      },
    ),

  /** 将调整加入 ArkPilot 持久化 FIFO；重复请求复用 clientMessageId。 */
  enqueueFollowUp: (runId: string, text: string, clientMessageId: string) =>
    request<FollowUpActionResponse>(`/api/runs/${runId}/follow-up/messages`, {
      method: "POST",
      body: JSON.stringify({ text, clientMessageId }),
    }),

  /** 非破坏性中断当前续跑任务；后端负责确认与派发队列下一项。 */
  interruptFollowUp: (runId: string, clientActionId: string) =>
    request<FollowUpActionResponse>(`/api/runs/${runId}/follow-up/interrupt`, {
      method: "POST",
      body: JSON.stringify({ clientActionId }),
    }),

  /** 仅编辑尚未派发的续跑消息，ArkPilot 保持原有 FIFO 顺序。 */
  updateQueuedFollowUp: (runId: string, commandId: string, text: string) =>
    request<FollowUpActionResponse>(`/api/runs/${runId}/follow-up/messages/${commandId}`, {
      method: "PATCH",
      body: JSON.stringify({ text }),
    }),

  /** 仅从 FIFO 中移除尚未派发的续跑消息。 */
  removeQueuedFollowUp: (runId: string, commandId: string) =>
    request<FollowUpActionResponse>(`/api/runs/${runId}/follow-up/messages/${commandId}`, {
      method: "DELETE",
    }),

  sendLiveInput: (runId: string, preview: string, body: LivePreviewInput) =>
    request<{
      ok: boolean
      frame_seq: number
      frame_status: "refreshing"
      refresh_queued: boolean
      timings: Record<string, number>
    }>(
      `/api/runs/${runId}/live/input${preview ? `?preview=${encodeURIComponent(preview)}` : ""}`,
      {
        method: "POST",
        body: JSON.stringify(body),
        keepalive: true,
      },
    ),

  getLiveWebRTCConfig: (runId: string, preview = "") =>
    request<{
      available: boolean
      ice_servers: RTCIceServer[]
      connect_timeout_ms: number
      transport: string
      offer_path: string
    }>(`/api/runs/${runId}/live/webrtc/config${preview ? `?preview=${encodeURIComponent(preview)}` : ""}`),

  createLiveWebRTCAnswer: (
    offerPath: string,
    sdp: string,
    type: RTCSdpType,
    signalingId: string,
  ) =>
    request<{
      ok: boolean
      peer_id: string
      sdp: string
      type: RTCSdpType
      local_candidate_types: string[]
    }>(offerPath, {
      method: "POST",
      body: JSON.stringify({ sdp, type, signaling_id: signalingId }),
    }),

  getHealth: () => request<HealthPayload>("/api/health"),
}

/** 给二维码 / 媒体等带缓存破坏参数的资源地址 */
export function withCacheBust(path: string): string {
  if (!path) return ""
  const sep = path.includes("?") ? "&" : "?"
  return `${path}${sep}t=${Date.now()}`
}
