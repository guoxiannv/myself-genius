import { Link, useParams, useSearchParams } from "react-router-dom"
import { TopBar } from "@/components/layout/TopBar"
import { AuthControl } from "@/components/layout/AuthControl"
import { Card } from "@/components/ui/Card"
import { DevicePreview } from "@/components/detail/DevicePreview"
import { InstallDock } from "@/components/detail/InstallDock"
import { BuildProgress } from "@/components/detail/BuildProgress"
import { ExpoRunPanel } from "@/components/detail/ExpoRunPanel"
import { ExpoInstallMenu } from "@/components/detail/ExpoInstallMenu"
import { QuestionPanel } from "@/components/detail/QuestionPanel"
import { FollowUpPanel } from "@/components/detail/FollowUpPanel"
import { PackageButton } from "@/components/detail/PackageButton"
import { useRunStream } from "@/hooks/useRunStream"
import type { AskUserQuestionRequest } from "@/lib/types"

const DEMO_QUESTION: AskUserQuestionRequest = {
  id: "demo-q1",
  toolUseId: "demo-q1",
  audience: "end_user",
  status: "pending",
  createdAt: new Date().toISOString(),
  toolInput: {
    questions: [
      {
        header: "风格",
        question: "记账应用需要更偏哪种视觉风格？",
        options: [
          { label: "极简", description: "留白更足，强调数字可读性和长时间使用的舒适感。" },
          { label: "活泼", description: "色彩更丰富，卡片和反馈更有生活气息。" },
          { label: "极简为主、局部活泼", description: "整体克制，在分类标签和关键数据上用亮色点缀。" },
        ],
      },
      {
        header: "首页重点",
        question: "首页更想突出哪类内容？",
        options: [
          { label: "数据概览", description: "优先展示本月收支、预算进度和趋势。" },
          { label: "快捷操作", description: "优先展示记一笔、记收入、常用分类等入口。" },
          { label: "概览在上、操作在下", description: "首屏同时覆盖数据和入口，比例更均衡。" },
        ],
      },
    ],
  },
}

const COMPLETE_RUN_STATUSES = new Set(["complete", "completed", "done", "succeeded", "success", "ready"])

export function DetailPage() {
  const { runId } = useParams()
  const [searchParams] = useSearchParams()
  const { data, error, finished } = useRunStream(runId)

  const isDemo = searchParams.get("ask") === "demo"
  const isFollowUpDemo = searchParams.get("followup") === "demo"
  // 本地联调专用：绕过真实的签名和二维码生成，仅用于续跑交互模拟。
  const isFollowUpHapDemo = searchParams.get("followup") === "hap-demo"
  const isExpo = String(data?.runtime || data?.run.runtime || "").toLowerCase() === "expo"
  const runStatus = String(data?.status || "").trim().toLowerCase()
  // ArkPilot 的主任务终态实际为 complete；续跑控制器存在也说明首版本已完成并进入交互阶段。
  const followUpEstablished = Boolean(data?.follow_up?.run_name || data?.follow_up?.session_id)
  const mainBuildComplete = finished || COMPLETE_RUN_STATUSES.has(runStatus) || followUpEstablished
  const running = !mainBuildComplete && !["failed", "error", "cancelled", "canceled"].includes(runStatus)
  // 真实任务必须完成首版本自动签名并展示首个二维码，才开放续跑输入。
  // first_install_* 会持久化，因此后续调整使最新安装包过期时不会重新锁住面板。
  const firstInstallReady = Boolean(
    data?.artifacts.first_install_ready &&
      data.artifacts.first_install_url &&
      data.artifacts.first_install_qr_path,
  )
  const initialBuildReady = firstInstallReady || isFollowUpDemo || isFollowUpHapDemo
  const pendingQuestions = data?.questions?.pending?.length
    ? data.questions.pending
    : isDemo
      ? [DEMO_QUESTION]
      : []

  if (!data && !error) return <DetailPageLoading />

  return (
    <div className="aurora-bg relative min-h-screen">
      <TopBar
        compact
        left={<BackLink />}
        right={
          <div className="flex items-center gap-1.5 sm:gap-2">
            {!isExpo && <PackageButton compact runId={runId} artifacts={data?.artifacts} />}
            {isExpo && mainBuildComplete && data && (
              <ExpoInstallMenu runId={data.run.run_id} artifacts={data.artifacts} serve={data.expo?.serve} />
            )}
            <AuthControl compact />
            <Link
              to="/runs"
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-accent/35 bg-accent/15 px-3 text-xs font-semibold text-accent-soft shadow-lg shadow-black/20 transition-colors hover:border-accent/55 hover:bg-accent/25 hover:text-foreground"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
                <path
                  d="M4 7h16M4 12h16M4 17h10"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
              我的应用
            </Link>
            <Link
              to="/"
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-accent px-3 text-xs font-semibold text-background shadow-lg shadow-accent/20 transition-colors hover:bg-accent-soft"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
                <path
                  d="M12 5v14M5 12h14"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              新建构建
            </Link>
          </div>
        }
      />

      <main className="relative z-10 mx-auto w-full max-w-[1720px] px-3 pb-8 pt-1 sm:px-4 xl:px-5 lg:pb-4">
        {error && !data && (
          <Card className="mb-6 p-5">
            <p className="text-sm text-danger">加载失败：{error}</p>
          </Card>
        )}

        {/* 两栏：左 进展 / 右 真机预览（扫码安装改为右下角悬浮坞） */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(360px,0.8fr)_minmax(0,1.2fr)] xl:grid-cols-[minmax(420px,0.75fr)_minmax(0,1.35fr)]">
          {/* 左：进度概览 + 统一 Agent 构建会话 */}
          <div className="flex min-w-0 flex-col gap-3.5">
            {pendingQuestions.length ? (
              <QuestionPanel runId={runId} pending={pendingQuestions} mock={isDemo && !data?.questions?.pending?.length} />
            ) : null}

            <Card className="shrink-0">
              <BuildProgress data={data} finished={finished} />
            </Card>

            {isExpo && data ? (
              <ExpoRunPanel data={data} />
            ) : (
              <FollowUpPanel
                runId={runId}
                initialPrompt={data?.run.prompt || ""}
                initialPromptAt={data?.run.created_at}
                events={data?.events || []}
                initialBuildReady={initialBuildReady}
                buildRunning={Boolean(running)}
                followUp={data?.follow_up}
                trace={data?.follow_up_trace}
                mock={isFollowUpDemo || isFollowUpHapDemo}
              />
            )}
          </div>

          {/* 右：真机预览 */}
          <div className="lg:sticky lg:top-6 lg:self-start">
            <section className="px-2 py-1 sm:px-3" aria-label="设备预览">
              <DevicePreview
                artifacts={
                  data?.artifacts ?? ({ media_ready: false } as never)
                }
                waitingMessage={data?.ui.waiting_message || "Building…"}
                runId={runId}
                runtime={data?.runtime || data?.run.runtime || "arkpilot"}
                previewPolicy={data?.preview_policy}
                previewSessions={data?.preview_sessions}
              />
            </section>
          </div>
        </div>
      </main>

      {/* 扫码安装悬浮坞：HAP 生成前隐藏 */}
      {data && !isExpo && <InstallDock artifacts={data.artifacts} />}
    </div>
  )
}

function DetailPageLoading() {
  return (
    <div className="aurora-bg relative min-h-screen">
      <TopBar compact left={<BackLink />} />
      <main className="relative z-10 mx-auto w-full max-w-[1720px] px-3 pb-8 pt-1 sm:px-4 xl:px-5 lg:pb-4">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(360px,0.8fr)_minmax(0,1.2fr)] xl:grid-cols-[minmax(420px,0.75fr)_minmax(0,1.35fr)]">
          <div className="flex min-w-0 flex-col gap-3.5">
            <Card className="h-28 shrink-0 p-5">
              <div className="skeleton h-3 w-24 rounded-full" />
              <div className="mt-6 flex gap-5">
                <div className="skeleton h-8 flex-1 rounded-xl" />
                <div className="skeleton h-8 flex-1 rounded-xl" />
                <div className="skeleton h-8 flex-1 rounded-xl" />
              </div>
            </Card>
            <Card className="h-[clamp(460px,calc(100vh-190px),680px)] p-5">
              <div className="skeleton h-7 w-36 rounded-full" />
              <div className="mt-8 space-y-4">
                <div className="skeleton ml-auto h-16 w-3/5 rounded-2xl" />
                <div className="skeleton h-20 w-2/3 rounded-2xl" />
                <div className="skeleton h-16 w-1/2 rounded-2xl" />
              </div>
            </Card>
          </div>
          <div className="lg:sticky lg:top-6 lg:self-start">
            <div className="flex min-h-[570px] items-center justify-center px-2 py-1 sm:px-3">
              <div className="skeleton aspect-[3/2] w-full rounded-xl" />
            </div>
          </div>
        </div>
      </main>
      <div
        className="fixed inset-0 z-40 flex items-center justify-center bg-background/15"
        role="status"
        aria-live="polite"
      >
        <div className="flex flex-col items-center rounded-2xl border border-border-strong/80 bg-surface/70 px-8 py-6 text-center shadow-2xl shadow-black/30">
          <span className="relative flex h-14 w-14 items-center justify-center">
            <span className="absolute inset-0 animate-ping rounded-full bg-accent/15" />
            <span className="h-9 w-9 animate-spin rounded-full border-[3px] border-accent/20 border-t-accent" />
          </span>
          <p className="mt-5 text-sm font-semibold text-foreground">正在加载应用详情</p>
          <p className="mt-1.5 text-xs font-medium text-muted">正在同步构建进度、会话和预览…</p>
        </div>
      </div>
    </div>
  )
}

function BackLink() {
  return (
    <Link
      to="/"
      className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-surface/70 px-3 text-xs font-semibold text-foreground shadow-lg shadow-black/15 transition-colors hover:border-[#f59e0b] hover:bg-[#f59e0b]/10 hover:text-[#fbbf24]"
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
        <path
          d="M19 12H5M11 6l-6 6 6 6"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      返回
    </Link>
  )
}
