import type { RunProgress } from "@/lib/types"

type StepStatus = "pending" | "active" | "done" | "failed"

interface Step {
  id: string
  label: string
  desc: string
  status: StepStatus
  weight: number
}

interface StepDef {
  id: string
  label: string
  desc: string
  done: boolean
  active: boolean
  failed: boolean
  weight: number
}

const DONE_STATUSES = new Set(["complete", "completed", "done", "succeeded", "success", "ready"])
const ACTIVE_STATUSES = new Set(["active", "running", "in_progress", "packaging", "building"])
const FAILED_STATUSES = new Set(["failed", "error", "cancelled", "timeout"])

function normalize(value: unknown): string {
  return String(value || "").trim().toLowerCase()
}

function statusDone(value: unknown): boolean {
  return DONE_STATUSES.has(normalize(value))
}

function statusActive(value: unknown): boolean {
  return ACTIVE_STATUSES.has(normalize(value))
}

function statusFailed(value: unknown): boolean {
  return FAILED_STATUSES.has(normalize(value))
}

function isExpoRun(data: RunProgress | null | undefined): boolean {
  return normalize(data?.runtime || data?.run.runtime) === "expo"
}

function buildExpoStepDefs(data: RunProgress | null | undefined): StepDef[] {
  const state = data?.expo?.state
  const stateName = normalize(state?.state)
  const detail = normalize(state?.detail)
  const detailIndexes: Record<string, number> = {
    preparing: 0,
    model_generation: 1,
    verification: 2,
    model_repair: 2,
    repair_verification: 2,
    launching: 3,
    done: 4,
  }
  const lastKnownDetail = [...(state?.history || [])]
    .reverse()
    .map((item) => normalize(item.detail))
    .find((item) => item in detailIndexes)
  const effectiveDetail = detail in detailIndexes ? detail : lastKnownDetail || "preparing"
  const currentIndex = stateName === "completed" ? 4 : detailIndexes[effectiveDetail] ?? 0
  const failed = stateName === "failed" || statusFailed(data?.status)
  const completed = stateName === "completed"
  const packageStatus = normalize(data?.expo?.package?.status)

  const definitions = [
    { id: "expo-prepare", label: "工程准备", desc: "创建独立工作目录、Prompt 与能力索引" },
    { id: "expo-generate", label: "代码生成", desc: "由 Expo Harmony Fast Runtime 生成应用" },
    { id: "expo-verify", label: "验证修复", desc: "执行依赖、类型、源码与产物门禁，必要时自动修复" },
    { id: "expo-launch", label: "启动验收", desc: "在 Harmony Go 中启动并验证应用身份" },
  ]

  const steps: StepDef[] = definitions.map((step, index) => ({
    ...step,
    done: completed || currentIndex > index,
    active: !completed && !failed && currentIndex === index,
    failed: failed && currentIndex === index,
    weight: 20,
  }))
  steps.push({
    id: "expo-package",
    label: "等待打包实现",
    desc: "Expo 的打包、签名与发布流程将在后续接入",
    done: statusDone(packageStatus),
    active: statusActive(packageStatus),
    failed: statusFailed(packageStatus),
    weight: 20,
  })
  return steps
}

function stageIncludes(value: unknown, words: string[]): boolean {
  const stage = normalize(value)
  return words.some((word) => stage.includes(word))
}

function pipelineIndex(data: RunProgress | null | undefined, stageIds: string[]): number {
  const stages = data?.autopilot?.pipeline?.stages || []
  return stages.findIndex((stage) => stageIds.includes(normalize(stage.id)))
}

function pipelineStatus(data: RunProgress | null | undefined, stageIds: string[]): string {
  const stages = data?.autopilot?.pipeline?.stages || []
  return normalize(stages.find((stage) => stageIds.includes(normalize(stage.id)))?.status)
}

function pipelineDone(data: RunProgress | null | undefined, stageIds: string[]): boolean {
  const currentIndex = data?.autopilot?.pipeline?.currentStageIndex
  const index = pipelineIndex(data, stageIds)
  const status = pipelineStatus(data, stageIds)
  return statusDone(status) || (typeof currentIndex === "number" && index >= 0 && currentIndex > index)
}

function pipelineActive(data: RunProgress | null | undefined, stageIds: string[]): boolean {
  const currentIndex = data?.autopilot?.pipeline?.currentStageIndex
  const index = pipelineIndex(data, stageIds)
  const status = pipelineStatus(data, stageIds)
  return statusActive(status) || (typeof currentIndex === "number" && index >= 0 && currentIndex === index)
}

function pipelineFailed(data: RunProgress | null | undefined, stageIds: string[]): boolean {
  return statusFailed(pipelineStatus(data, stageIds))
}

function activeBackendStage(data: RunProgress | null | undefined): string {
  const activeLane = data?.tmux?.active_lane
  return (
    normalize(data?.stage) ||
    normalize(data?.tmux?.state?.current_stage) ||
    normalize(activeLane?.current_stage) ||
    normalize(activeLane?.current_prompt_stage) ||
    normalize(data?.tmux?.state?.active_lane) ||
    normalize(activeLane?.lane_name) ||
    "waiting"
  )
}

function formatBackendStage(data: RunProgress | null | undefined): string {
  const lane = normalize(data?.tmux?.state?.active_lane || data?.tmux?.active_lane?.lane_name)
  const stage = activeBackendStage(data)
  const uiQa = data?.tmux?.state?.ui_qa
  if (uiQa?.current_skill && statusActive(uiQa.status)) return `界面验证: ${uiQa.current_skill}`
  if (lane && stage && lane !== stage) return `${lane} / ${stage}`
  return stage
}

type FollowUpPhase = "implementation" | "build" | "preview" | null

function hasFollowUpAdjustment(data: RunProgress | null | undefined): boolean {
  const followUp = data?.follow_up
  return Boolean(
    followUp?.active_command?.type === "message" ||
      followUp?.queue?.some((command) => command.type === "message") ||
      followUp?.history?.some((command) => command.type === "message"),
  )
}

function activeFollowUpPhase(
  data: RunProgress | null | undefined,
  captureStatus: string,
): FollowUpPhase {
  const followUpStatus = normalize(data?.follow_up?.status)
  // starting 只表示续跑控制器正在连接，interrupting 只表示正在等待停止
  // 确认；两者都不代表代码仍在执行，不能让“代码实现”步骤持续旋转。
  if (followUpStatus !== "running") return null

  // 新 HAP 出现后，安装、启动与截图/视频采集进入独立的预览生成阶段。
  if (
    data?.artifacts.newer_hap_available &&
    (statusActive(captureStatus) || ["waiting_hap", "waiting_preview"].includes(captureStatus))
  ) {
    return "preview"
  }

  const activeCommandAt = Date.parse(data?.follow_up?.active_command?.created_at || "")
  const latestTrace = [...(data?.follow_up_trace || [])]
    .reverse()
    .find((event) => {
      if (!Number.isFinite(activeCommandAt)) return true
      const eventAt = Date.parse(event.timestamp)
      return Number.isFinite(eventAt) && eventAt >= activeCommandAt
    })
  const traceText = normalize(`${latestTrace?.tool_name || ""} ${latestTrace?.summary || ""}`)
  if (/(qa|test|verify|check|lint|验证|测试|检查)/.test(traceText)) {
    return "build"
  }
  if (/(build|compile|hvigor|构建|编译|打包)/.test(traceText)) {
    return "build"
  }
  return "implementation"
}

function buildStepDefs(data: RunProgress | null | undefined, finished: boolean): StepDef[] {
  const runStatus = normalize(data?.status)
  const backendStage = activeBackendStage(data)
  const activeLane = normalize(data?.tmux?.state?.active_lane || data?.tmux?.active_lane?.lane_name)
  const captureStatus = normalize(data?.capture?.status)
  const distStatus = normalize(data?.artifacts.distribution_status ?? "waiting_hap")
  const uiQaStatus = normalize(data?.tmux?.state?.ui_qa?.status)
  const followUpPhase = activeFollowUpPhase(data, captureStatus)
  const adjusted = hasFollowUpAdjustment(data)

  const hapFound = Boolean(data?.artifacts.hap_found && data?.artifacts.hap_path)
  const newerHapReady = Boolean(data?.artifacts.newer_hap_available)
  const packageOutdated = Boolean(data?.artifacts.package_outdated)
  const mediaReady = Boolean(data?.artifacts.media_ready && data?.artifacts.media_path)
  const installReady = Boolean(
    data?.artifacts.install_ready &&
      data?.artifacts.install_url &&
      data?.artifacts.install_qr_path,
  )
  // follow-up 控制器只会在首版本完成后建立。首版本保持完成；一旦调整使
  // 安装包过期，则改用最新 HAP 和预览状态重新计算本轮进度。
  const initialMilestonesComplete = Boolean(
    (data?.follow_up?.run_name || data?.follow_up?.session_id) &&
      !packageOutdated,
  )

  const planIds = ["plan", "design", "expansion", "ralplan"]
  const executionIds = ["execution", "implementation", "implement"]
  const qaIds = ["qa", "ui-qa", "ui_qa"]

  const designDone =
    initialMilestonesComplete ||
    pipelineDone(data, planIds) ||
    pipelineActive(data, executionIds) ||
    pipelineDone(data, executionIds) ||
    pipelineActive(data, qaIds) ||
    pipelineDone(data, qaIds) ||
    hapFound
  const designActive =
    !designDone &&
    (pipelineActive(data, planIds) ||
      ["design", "implementation_plan", "api_reference"].includes(activeLane) ||
      stageIncludes(backendStage, ["plan", "design", "expansion", "ralplan", "scaffold-preflight"]))

  const implementationDone =
    initialMilestonesComplete ||
    pipelineDone(data, executionIds) ||
    hapFound ||
    mediaReady ||
    installReady
  const implementationActive =
    followUpPhase === "implementation" ||
    (!implementationDone &&
      (pipelineActive(data, executionIds) ||
        activeLane === "implementation" ||
        stageIncludes(backendStage, ["execution", "implementation", "implement", "build"])))

  const buildDone = initialMilestonesComplete || (packageOutdated ? newerHapReady : hapFound)
  const buildActive =
    followUpPhase === "build" ||
    (!buildDone &&
      implementationDone &&
      (statusActive(runStatus) || stageIncludes(backendStage, ["build", "package", "hap"])))

  const previewDone =
    initialMilestonesComplete ||
    (packageOutdated
      ? newerHapReady && statusDone(captureStatus) && mediaReady
      : statusDone(captureStatus) || mediaReady)
  const previewActive =
    followUpPhase === "preview" ||
    (!previewDone &&
      buildDone &&
      (statusActive(captureStatus) ||
        (hapFound && ["waiting_hap", "waiting_preview"].includes(captureStatus))))

  // QA 基于已经安装并采集到的实际运行预览，检查界面规范和业务流程。
  const qaDone =
    initialMilestonesComplete ||
    (previewDone && (statusDone(uiQaStatus) || pipelineDone(data, qaIds)))
  const qaActive =
    !qaDone &&
    previewDone &&
    (statusActive(uiQaStatus) ||
      pipelineActive(data, qaIds) ||
      stageIncludes(backendStage, ["qa", "ui-qa", "ui_qa"]))

  // 后端 run 记录里的 distribution_status 可能仍保留首版本的 ready。
  // 只有“当前二维码确实对应最新代码”时，签名阶段才允许完成。
  const signingDone = Boolean(!packageOutdated && installReady && data?.artifacts.package_current)
  const signingActive = !signingDone && statusActive(distStatus)

  const runFailed = statusFailed(runStatus)
  const captureFailed = statusFailed(captureStatus)
  const distFailed = statusFailed(distStatus)

  const steps: StepDef[] = [
    {
      id: "design",
      label: "方案设计",
      desc: "生成需求、设计和实现约束",
      done: designDone,
      active: designActive,
      failed: pipelineFailed(data, planIds) || (runFailed && !designDone),
      weight: 15,
    },
    {
      id: "implementation",
      label: "代码实现",
      desc: "按设计产物实现 HarmonyOS 工程",
      done: implementationDone,
      active: implementationActive,
      failed: pipelineFailed(data, executionIds) || (runFailed && designDone && !implementationDone),
      weight: 20,
    },
    {
      id: "build",
      label: "构建产物",
      desc: "编译并产出最新 unsigned HAP",
      done: buildDone,
      active: buildActive,
      failed: !initialMilestonesComplete && runFailed && implementationDone && !buildDone,
      weight: 15,
    },
    {
      id: "preview",
      label: "预览生成",
      desc: "安装并启动应用，采集截图和预览视频",
      done: previewDone,
      active: previewActive,
      failed: !initialMilestonesComplete && captureFailed,
      weight: 15,
    },
    {
      id: "qa",
      label: "QA 验证",
      desc: "基于实际运行预览检查界面规范和业务流程",
      done: qaDone,
      active: qaActive,
      failed: !initialMilestonesComplete && pipelineFailed(data, qaIds),
      weight: 15,
    },
    {
      id: "signing",
      label: "签名安装",
      desc: "由用户确认后编译、签名并生成扫码安装页",
      done: signingDone,
      active: signingActive,
      failed: distFailed,
      weight: 20,
    },
  ]

  // 首版本仍展示 QA；一旦进入调整流程，步骤条切换为明确的五段流程，
  // 调整只重新实现、构建和生成预览，不重复执行 QA。签名前固定停在 80%。
  const visibleSteps = adjusted
    ? steps
        .filter((step) => step.id !== "qa")
        .map((step) => {
          const weights: Record<string, number> = {
            design: 20,
            implementation: 20,
            build: 20,
            preview: 20,
            signing: 20,
          }
          return { ...step, weight: weights[step.id] }
        })
    : steps

  return visibleSteps.map((step, index, list) => {
    if (followUpPhase) {
      const phaseOrder: Exclude<FollowUpPhase, null>[] = ["implementation", "build", "preview"]
      const phaseIndex = phaseOrder.indexOf(followUpPhase)
      const stepIndex = phaseOrder.indexOf(step.id as Exclude<FollowUpPhase, null>)
      if (step.id === "design") return { ...step, done: true, active: false, failed: false }
      if (step.id === "signing") return { ...step, done: false, active: false, failed: false }
      if (stepIndex >= 0) {
        return {
          ...step,
          done: stepIndex < phaseIndex,
          active: stepIndex === phaseIndex,
          failed: false,
        }
      }
    }
    if (step.active || step.done || step.failed) return step
    const previousDone = list.slice(0, index).every((item) => item.done)
    if (
      step.id === "signing" &&
      ["ready_to_package", "waiting_update", "waiting_preview"].includes(distStatus)
    ) {
      return step
    }
    if (!finished && previousDone) return { ...step, active: true }
    return step
  })
}

// 将后端进度负载映射成用户可感知的阶段，并计算每步状态与整体完成度。
export function deriveSteps(
  data: RunProgress | null | undefined,
  finished: boolean,
): { steps: Step[]; percent: number; doneCount: number; currentStage: string } {
  const defs = isExpoRun(data) ? buildExpoStepDefs(data) : buildStepDefs(data, finished)

  const steps: Step[] = defs.map((d) => {
    if (d.failed) return { ...d, status: "failed" }
    // 续跑会重新经过已完成的里程碑；此时用旋转态表达“正在刷新”，
    // 但 doneCount 仍保留首版本里程碑，不让整体进度错误倒退。
    if (d.active) return { ...d, status: "active" }
    if (d.done) return { ...d, status: "done" }
    return { ...d, status: "pending" }
  })

  const doneCount = defs.filter((d) => d.done).length
  const adjusted = hasFollowUpAdjustment(data)
  const percent = Math.round(defs.reduce((total, step) => {
    if (step.done) return total + step.weight
    // 调整流程使用离散的 20% 阶段值；旋转态只表示“正在执行”，
    // 不提前计入尚未完成的阶段。
    if (step.active && !adjusted) return total + step.weight / 2
    return total
  }, 0))

  return { steps, percent, doneCount, currentStage: formatBackendStage(data) }
}

export function BuildProgress({
  data,
  finished,
}: {
  data: RunProgress | null | undefined
  finished: boolean
}) {
  const { steps, percent, doneCount } = deriveSteps(data, finished)
  const failed = steps.some((s) => s.status === "failed")
  const allDone = doneCount === steps.length
  const followUpStatus = normalize(data?.follow_up?.status)
  const followUpBusy = ["starting", "running"].includes(followUpStatus)
  const followUpStopping = followUpStatus === "interrupting"
  const adjusted = hasFollowUpAdjustment(data)
  const expo = isExpoRun(data)
  const expoWaitingForPackage = Boolean(
    expo &&
      normalize(data?.expo?.state?.state) === "completed" &&
      normalize(data?.expo?.package?.status) === "not_implemented",
  )
  const waitingForPackage = Boolean(
    adjusted &&
      data?.artifacts.package_can_start &&
      !data?.artifacts.package_current,
  )

  return (
    <div className="flex flex-col gap-2.5 p-4">
      {/* 整体进度条 */}
      <div>
        <div className="mb-1.5 flex items-baseline justify-between">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold">{expo ? "Expo 生成进度" : adjusted ? "调整进度" : "生成进度"}</span>
            <span className="text-xs text-subtle">
              {expoWaitingForPackage
                ? "等待打包实现"
                : followUpStopping
                ? "正在停止本轮调整"
                : followUpBusy
                ? "正在刷新应用"
                : waitingForPackage
                  ? "代码与预览已更新，等待手动生成安装包"
                  : `已完成 ${doneCount}/${steps.length} 阶段`}
            </span>
          </div>
          <span
            className={[
              "text-sm font-semibold tabular-nums",
              failed ? "text-danger" : allDone ? "text-success" : "text-accent",
            ].join(" ")}
          >
            {percent}%
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-raised">
          <div
            className={[
              "h-full rounded-full transition-all duration-700 ease-out",
              failed ? "bg-danger" : allDone ? "bg-success" : "bg-accent",
            ].join(" ")}
            style={{ width: `${Math.max(percent, 4)}%` }}
          />
        </div>
      </div>

      {/* 步骤：横向一排 图标+标签 */}
      <ol className="flex items-center justify-between gap-1">
        {steps.map((step, i) => (
          <li key={step.id} className="flex min-w-0 flex-1 items-center gap-1.5" title={step.desc}>
            <StepIcon status={step.status} index={i} />
            <span
              className={[
                "truncate text-[11px] font-medium leading-tight",
                step.status === "pending" ? "text-subtle" : "text-foreground",
              ].join(" ")}
            >
              {step.label}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function StepIcon({ status, index }: { status: StepStatus; index: number }) {
  const base =
    "relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"

  if (status === "done") {
    return (
      <span className={`${base} bg-success/15 text-success`}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
          <path
            d="M20 6L9 17l-5-5"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    )
  }
  if (status === "failed") {
    return (
      <span className={`${base} bg-danger/15 text-danger`}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
          <path
            d="M18 6L6 18M6 6l12 12"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </svg>
      </span>
    )
  }
  if (status === "active") {
    return (
      <span className={`${base} bg-accent/15 text-accent`}>
        <svg className="animate-spin" viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
          <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      </span>
    )
  }
  return <span className={`${base} bg-surface-raised text-subtle`}>{index + 1}</span>
}
