// 与 Python 后端 build_progress_payload 输出对齐的类型定义。
// 后端字段一旦变动，这里更新后所有用到的地方会获得类型检查。

export type RunStatus = "waiting" | "running" | "succeeded" | "failed" | string
export type RunRuntime = "arkpilot" | "expo"

export interface RunRecord {
  run_id: string
  session_name: string
  prompt: string
  workspace: string
  variant?: string
  interactive_questions?: boolean
  status: RunStatus
  runtime?: RunRuntime | string
  created_at: string
  updated_at: string
  notes?: string
  command?: string[]
  process_pid?: number | null
  [key: string]: unknown
}

export interface TimelineEvent {
  timestamp: string
  kind: string
  summary: string
}

export interface AskUserQuestionOption {
  label: string
  description?: string
}

export interface AskUserQuestionItem {
  header?: string
  question: string
  options?: AskUserQuestionOption[]
  multiSelect?: boolean
}

export interface AskUserQuestionRequest {
  id: string
  toolUseId: string
  sessionId?: string
  agentId?: string
  agentType?: string
  audience?: "end_user" | "developer" | "auto_decidable" | "safety" | string
  status: "pending" | "answered" | string
  createdAt?: string
  expiresAt?: string
  answeredAt?: string | null
  completedAt?: string | null
  toolInput: {
    questions?: AskUserQuestionItem[]
    [key: string]: unknown
  }
  answers?: Record<string, string>
}

export interface AskUserQuestionState {
  pending: AskUserQuestionRequest[]
  answered: AskUserQuestionRequest[]
  stale?: AskUserQuestionRequest[]
}

export type PreviewKind = "desktop" | "phone"
export type PreviewTransport = "bundle_shell" | "hap_install"
export type PreviewStartMode = "automatic" | "on_demand"
export type PreviewSessionStatus =
  | "idle"
  | "queued"
  | "allocating"
  | "installing"
  | "loading_bundle"
  | "launching"
  | "ready"
  | "failed"
  | "released"
  | string

export interface RunPreviewPolicyItem {
  enabled: boolean
  transport: PreviewTransport
  start_mode: PreviewStartMode
}

export interface RunPreviewPolicy {
  default_kind: PreviewKind
  previews: Partial<Record<PreviewKind, RunPreviewPolicyItem>>
}

export interface RunPreviewSession {
  kind: PreviewKind
  transport: PreviewTransport
  status: PreviewSessionStatus
  requested?: boolean
  target?: string
  lease_id?: string
  artifact_digest?: string
  bundle_name?: string
  ability_name?: string
  /** 可直接展示的同源截图 URL；历史详情优先使用。 */
  screenshot_url?: string
  /** 兼容后端早期字段，返回给 Web 时也应是可访问 URL。 */
  screenshot_path?: string
  live_available?: boolean
  /** 当前模拟器安装版本或正式 HAP 是否落后于最新续跑源码。 */
  outdated?: boolean
  /** 最新 HAP 已就绪，可以手动重装到手机模拟器。 */
  refresh_available?: boolean
  refresh_status?: "idle" | "queued" | "building" | "ready" | "failed" | string
  refresh_error?: string
  error?: string
  updated_at?: string
}

export interface RunPreviewArtifact {
  kind: PreviewKind
  target: string
  capture_status: string
  status?: PreviewSessionStatus
  transport?: PreviewTransport
  requested?: boolean
  error?: string
  media_ready: boolean
  media_path: string
  media_source_path: string
  media_type: string
  live_ready: boolean
  live_frame_path: string
  live_input_path: string
  live_webrtc_config_path: string
}

export interface RunArtifacts {
  hap_found: boolean
  hap_path: string
  hap_display_path: string
  hap_download_path: string
  hap_qr_path: string
  install_ready: boolean
  install_url: string
  install_store_url: string
  manifest_url: string
  install_qr_path: string
  /** 首版本扫码安装信息（始终指向第一次成功签名的版本） */
  first_install_ready: boolean
  first_install_url: string
  first_install_store_url: string
  first_manifest_url: string
  first_install_qr_path: string
  signed_hap_path: string
  signed_hap_url: string
  distribution_status: string
  distribution_error: string
  /** 当前最新代码与预览是否允许用户主动生成签名安装包。 */
  package_can_start: boolean
  /** 当前二维码是否对应最新代码。 */
  package_current: boolean
  /** 已有签名包，但后续调整使它不再对应最新代码。 */
  package_outdated: boolean
  preview_source_outdated?: boolean
  preview_refresh_status?: string
  preview_refresh_error?: string
  media_ready: boolean
  media_path: string
  media_source_path: string
  media_type: string
  live_ready?: boolean
  live_frame_path?: string
  live_input_path?: string
  live_webrtc_config_path?: string
  previews?: Partial<Record<PreviewKind, RunPreviewArtifact>>
  newer_hap_available: boolean
}

export type LivePreviewInput =
  | { type: "tap"; point: { x: number; y: number } }
  | { type: "swipe"; start: { x: number; y: number }; end: { x: number; y: number }; duration_ms: number }
  | { type: "scroll"; direction: "up" | "down" }
  | { type: "key"; key: "BACK" | "HOME" }

export type FollowUpSessionStatus = "starting" | "idle" | "running" | "interrupting" | "unavailable"

export type FollowUpCommandStatus =
  | "queued"
  | "sending"
  | "running"
  | "submitted"
  | "interrupting"
  | "completed"
  | "interrupted"
  | "cancelled"
  | "failed"

/** Runtime follow-up-control CLI 返回的公开命令摘要（队列与活跃项不含用户消息正文）。 */
export interface FollowUpCommand {
  id: string
  client_request_id: string
  type: "message" | "interrupt" | string
  status: FollowUpCommandStatus | string
  sequence: number
  created_at: string
  send_started_at?: string | null
  sent_at?: string | null
  submitted_at?: string | null
  completed_at?: string | null
  interrupted_at?: string | null
  /** 仅在已完成的会话历史中返回，用于已授权 Remote UI 展示用户原始请求。 */
  text?: string
  error?: string
  result?: string
  acknowledgement?: string
  interrupted_before_assistant_activity?: boolean
}

/** 当前 Runtime follow-up-control 的会话状态镜像。 */
export interface FollowUpState {
  run_name?: string
  session_id?: string
  runtime?: string
  status: FollowUpSessionStatus | string
  transcript_path?: string
  queue_length: number
  active_command_id?: string | null
  interrupt_command_id?: string | null
  last_idle_at?: string | null
  last_error?: string
  active_command?: FollowUpCommand | null
  interrupt_command?: FollowUpCommand | null
  queue: FollowUpCommand[]
  history?: FollowUpCommand[]
  updated_at?: string
}

export interface FollowUpActionResponse {
  ok: boolean
  accepted: boolean
  duplicate: boolean
  command: FollowUpCommand
  follow_up: FollowUpState
}

/** 服务端从受信任 transcript 路径提取的安全摘要；不包含工具入参或内部思考。 */
export interface FollowUpTraceEvent {
  kind: "assistant" | "tool" | string
  tool_name?: string
  timestamp: string
  summary: string
}

export interface BackendPipelineStage {
  id: string
  status?: string
  startedAt?: string | null
  completedAt?: string | null
  error?: string
}

export interface BackendPipeline {
  stages?: BackendPipelineStage[]
  currentStageIndex?: number
  pipelineConfig?: {
    stageOrder?: string[]
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface BackendAutopilotState {
  status?: string
  stage_history?: Array<{ stage?: string; at?: string; reason?: string }>
  pipeline?: BackendPipeline
  qa?: Record<string, unknown>
  [key: string]: unknown
}

export interface BackendCaptureState {
  status?: string
  process_pid?: number | null
  command?: string[]
  manifest?: Record<string, unknown> | null
}

export interface ExpoClaudeTraceEvent {
  id: string
  kind: "session" | "action" | "assistant" | "result" | string
  timestamp: string
  summary: string
  tool_name?: string
  target?: string
  model?: string
  status?: string
}

export interface ExpoClaudeTraceGroup {
  id: string
  label: string
  kind: "generation" | "repair" | "runtime_repair" | "smoke" | string
  attempt?: number
  trace_file: string
  status: "waiting" | "running" | "completed" | "failed" | string
  event_count: number
  action_count: number
  message_count: number
  truncated: boolean
  updated_at: string
  events: ExpoClaudeTraceEvent[]
}

export interface ExpoServeState {
  enabled: boolean
  running: boolean
  host: string
  port: number
  local_origin: string
  public_origin: string
  status: "disabled" | "stopped" | "serving" | "failed" | string
  can_publish: boolean
  public_url: string
  local_url: string
  published_at: string
  error: string
}

export interface RunProgress {
  run: RunRecord
  runtime?: RunRuntime | string
  workspace: { path: string; [key: string]: unknown }
  tmux: {
    session_name: string
    state?: {
      status?: string
      current_stage?: string
      active_lane?: string
      ui_qa?: {
        status?: string
        current_skill?: string
        current_index?: number
        skills?: Array<{ name?: string; status?: string }>
      }
      [key: string]: unknown
    } | null
    active_lane?: {
      lane_name?: string
      status?: string
      current_stage?: string
      current_prompt_stage?: string
      [key: string]: unknown
    } | null
    [key: string]: unknown
  }
  autopilot?: BackendAutopilotState | null
  expo?: {
    state?: {
      schemaVersion?: number
      runId?: string
      project?: string
      pid?: number
      state?: "generating_code" | "repairing" | "completed" | "failed" | string
      label?: string
      status?: string
      detail?: string
      detailLabel?: string
      startedAt?: string
      updatedAt?: string
      context?: Record<string, unknown>
      history?: Array<{
        state?: string
        label?: string
        status?: string
        detail?: string
        detailLabel?: string
        at?: string
      }>
      error?: string
    } | null
    package?: {
      status?: string
      label?: string
      updated_at?: string
      error?: string
      duration_ms?: number
      sha256?: string
      bundle_name?: string
      slot_id?: string
    }
    serve?: ExpoServeState
    trace_groups?: ExpoClaudeTraceGroup[]
  } | null
  capture?: BackendCaptureState
  distribution: Record<string, unknown>
  signing: Record<string, unknown>
  status: RunStatus
  stage: string
  events: TimelineEvent[]
  questions?: AskUserQuestionState
  artifacts: RunArtifacts
  preview_policy?: RunPreviewPolicy
  preview_sessions?: Partial<Record<PreviewKind, RunPreviewSession>>
  follow_up?: FollowUpState
  follow_up_trace?: FollowUpTraceEvent[]
  ui: {
    poll_interval_ms: number
    waiting_message: string
  }
}

export interface CreateRunRequest {
  prompt: string
  runtime?: RunRuntime
  workspace?: string
  variant?: string
  plan_skill?: string
  interactive_questions?: boolean
}

export interface CreateRunResponse {
  run_id: string
  detail_url: string
  runtime?: RunRuntime | string
  signing_slot_id?: string
  signing_bundle_name?: string
}

export interface HealthPayload {
  ok: boolean
  workspace?: string
  hpack_enabled?: boolean
  qrcode_enabled?: boolean
  [key: string]: unknown
}

export interface AuthState {
  role: "root" | "guest"
  root_login_enabled: boolean
}

/** GET /api/runs 返回的单条运行摘要 */
export interface RunSummary {
  run_id: string
  prompt: string
  status: RunStatus
  runtime?: RunRuntime | string
  variant: string
  session_name: string
  created_at: string
  updated_at: string
  notes: string
  detail_url: string
  has_media: boolean
  media_url: string
  media_type: string
  has_thumbnail: boolean
  thumbnail_url: string
  default_preview_kind?: PreviewKind
  preview_sessions?: Partial<Record<PreviewKind, RunPreviewSession>>
}

export interface RunListResponse {
  runs: RunSummary[]
  total: number
  counts: Record<string, number>
}
