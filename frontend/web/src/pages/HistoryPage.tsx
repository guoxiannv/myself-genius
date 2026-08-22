import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { TopBar } from "@/components/layout/TopBar"
import { AuthControl } from "@/components/layout/AuthControl"
import { StatusBadge, statusToTone } from "@/components/ui/StatusBadge"
import { api, withCacheBust } from "@/lib/api"
import { cn, formatDateTime } from "@/lib/format"
import type { RunSummary } from "@/lib/types"
import generatedFailedImage from "@/assets/images/generated-failed-pc.jpeg"
import generatingImage from "@/assets/images/generating-pc.jpeg"

type StatusFilter = "all" | "running" | "succeeded" | "failed" | "waiting"
type SortOrder = "newest" | "oldest"
type ViewMode = "grid" | "list"

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "running", label: "生成中" },
  { value: "succeeded", label: "已完成" },
  { value: "failed", label: "失败" },
]

function statusBucket(status: string): StatusFilter {
  const s = status.toLowerCase()
  if (["succeeded", "ready", "install_ready", "complete"].includes(s)) return "succeeded"
  if (["failed", "error"].includes(s)) return "failed"
  if (["running", "packaging", "building", "active"].includes(s)) return "running"
  if (["waiting", "waiting_hap", "queued"].includes(s)) return "waiting"
  return "running"
}

function statusLabel(status: string): string {
  switch (statusBucket(status)) {
    case "succeeded":
      return "已完成"
    case "failed":
      return "失败"
    case "waiting":
      return "等待中"
    default:
      return "生成中"
  }
}

export function HistoryPage() {
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest")
  const [view, setView] = useState<ViewMode>("grid")

  useEffect(() => {
    let alive = true
    setLoading(true)
    api
      .getRuns()
      .then((res) => {
        if (!alive) return
        setRuns(res.runs)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setError(err instanceof Error ? err.message : "加载历史记录失败")
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = runs.filter((run) => {
      const matchQuery = !q || run.prompt.toLowerCase().includes(q)
      const matchStatus = statusFilter === "all" || statusBucket(run.status) === statusFilter
      return matchQuery && matchStatus
    })
    list = [...list].sort((a, b) => {
      const at = new Date(a.created_at).getTime() || 0
      const bt = new Date(b.created_at).getTime() || 0
      return sortOrder === "newest" ? bt - at : at - bt
    })
    return list
  }, [runs, query, statusFilter, sortOrder])

  const bucketCount = useMemo(() => {
    const acc: Record<StatusFilter, number> = {
      all: runs.length,
      running: 0,
      succeeded: 0,
      failed: 0,
      waiting: 0,
    }
    for (const run of runs) acc[statusBucket(run.status)] += 1
    return acc
  }, [runs])

  return (
    <div className="aurora-bg min-h-screen">
      <TopBar
        left={<BackLink />}
        right={
          <>
            <AuthControl />
            <Link
              to="/"
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-accent px-3.5 text-xs font-semibold text-background shadow-lg shadow-accent/20 transition-colors hover:bg-accent-soft"
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
              新建生成
            </Link>
          </>
        }
      />

      <main className="relative z-10 mx-auto w-full max-w-6xl px-5 pb-20 pt-4 sm:px-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-black tracking-tight sm:text-4xl">我的应用</h1>
            <p className="mt-2 text-sm text-muted">
              共 {runs.length} 个生成记录，随时回看、继续或重新生成。
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-full border border-border bg-surface/60 p-1">
            <ViewButton active={view === "grid"} onClick={() => setView("grid")} label="卡片">
              <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />
            </ViewButton>
            <ViewButton active={view === "list"} onClick={() => setView("list")} label="列表">
              <path
                d="M4 6h16M4 12h16M4 18h16"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                fill="none"
              />
            </ViewButton>
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative w-full lg:max-w-xs">
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle"
            >
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
              <path d="M20 20l-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索创意描述..."
              className="w-full rounded-full border border-border bg-surface/60 py-2 pl-9 pr-4 text-sm text-foreground outline-none transition-colors placeholder:text-subtle focus:border-accent/50"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setStatusFilter(f.value)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  statusFilter === f.value
                    ? "border-accent/40 bg-accent/15 text-accent-soft"
                    : "border-border bg-surface/60 text-muted hover:text-foreground",
                )}
              >
                {f.label}
                <span className="text-subtle">{bucketCount[f.value]}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setSortOrder((o) => (o === "newest" ? "oldest" : "newest"))}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/60 px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-foreground"
              title="切换排序"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
                <path
                  d="M7 4v16M7 20l-3-3M7 4l3 3M17 20V4M17 4l3 3M17 20l-3-3"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {sortOrder === "newest" ? "最新在前" : "最早在前"}
            </button>
          </div>
        </div>

        <div className="mt-8">
          {loading ? (
            <div className="py-24 text-center text-sm text-muted">正在加载历史记录...</div>
          ) : error ? (
            <div className="rounded-2xl border border-danger/30 bg-danger/10 px-5 py-6 text-sm text-danger">
              {error}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState hasRuns={runs.length > 0} />
          ) : view === "grid" ? (
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((run) => (
                <RunCard key={run.run_id} run={run} />
              ))}
            </div>
          ) : (
            <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/40">
              {filtered.map((run) => (
                <RunRow key={run.run_id} run={run} />
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  )
}

function BackLink() {
  return (
    <Link
      to="/"
      className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-surface/70 px-3.5 text-xs font-semibold text-foreground shadow-lg shadow-black/15 transition-colors hover:border-[#f59e0b] hover:bg-[#f59e0b]/10 hover:text-[#fbbf24]"
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

function ViewButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean
  onClick: () => void
  label: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors",
        active ? "bg-accent text-background" : "text-muted hover:text-foreground",
      )}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
        {children}
      </svg>
    </button>
  )
}

function RunCard({ run }: { run: RunSummary }) {
  const bucket = statusBucket(run.status)
  const mediaIsImage = ["png", "jpg", "jpeg", "webp"].includes(run.media_type)
  const successImageUrl =
    run.has_thumbnail && run.thumbnail_url
      ? run.thumbnail_url
      : run.has_media && mediaIsImage && run.media_url
        ? run.media_url
        : ""
  const useShot = bucket === "succeeded" && Boolean(successImageUrl)
  const imgSrc = useShot
    ? withCacheBust(successImageUrl)
    : bucket === "failed"
      ? generatedFailedImage
      : generatingImage

  return (
    <Link
      to={run.detail_url || `/runs/${run.run_id}`}
      className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-surface/50 transition-all hover:border-accent/40 hover:bg-surface"
    >
      <div className="relative aspect-[3/2] overflow-hidden bg-background">
        <img
          src={imgSrc}
          alt={useShot ? "应用首页截图" : bucket === "failed" ? "生成失败" : "生成中"}
          className="h-full w-full object-contain transition-transform duration-300 group-hover:scale-[1.03]"
          loading="lazy"
        />
      </div>

      <div className="flex flex-1 flex-col p-4">
        <div className="mb-3">
          <StatusBadge
            tone={statusToTone(run.status)}
            pulse={bucket === "running"}
            className="bg-background/80 backdrop-blur-sm"
          >
            {statusLabel(run.status)}
          </StatusBadge>
          <span className="mt-2 block text-xs text-subtle">创建于 {formatDateTime(run.created_at)}</span>
        </div>
        <p className="line-clamp-2 min-h-[2.6rem] text-sm font-medium leading-relaxed text-foreground">
          {run.prompt || "（无描述）"}
        </p>
        <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
          <span className="font-mono text-[11px] text-subtle">{run.run_id.slice(0, 8)}</span>
          <span className="inline-flex items-center gap-1 text-xs font-medium text-accent-soft opacity-0 transition-opacity group-hover:opacity-100">
            查看详情
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">
              <path
                d="M5 12h14M13 6l6 6-6 6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </div>
      </div>
    </Link>
  )
}

function RunRow({ run }: { run: RunSummary }) {
  return (
    <li>
      <Link
        to={run.detail_url || `/runs/${run.run_id}`}
        className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 transition-colors hover:bg-surface"
      >
        <StatusBadge tone={statusToTone(run.status)} pulse={statusBucket(run.status) === "running"}>
          {statusLabel(run.status)}
        </StatusBadge>
        <p className="order-3 w-full min-w-0 truncate text-sm text-foreground sm:order-none sm:flex-1">
          {run.prompt || "（无描述）"}
        </p>
        <span className="hidden shrink-0 font-mono text-[11px] text-subtle sm:inline">
          {run.run_id.slice(0, 10)}
        </span>
        <span className="ml-auto shrink-0 text-xs text-subtle">创建于 {formatDateTime(run.created_at)}</span>
      </Link>
    </li>
  )
}

function EmptyState({ hasRuns }: { hasRuns: boolean }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-20 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 ring-1 ring-accent/25">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
          <path
            d="M4 7h16M4 12h16M4 17h10"
            stroke="var(--color-accent)"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <p className="mt-4 text-sm font-medium text-foreground">
        {hasRuns ? "没有符合条件的记录" : "还没有生成记录"}
      </p>
      <p className="mt-1 text-sm text-muted">
        {hasRuns ? "试着调整搜索或筛选条件。" : "回到首页，用一句话开始构建你的第一个鸿蒙应用。"}
      </p>
      {!hasRuns && (
        <Link
          to="/"
          className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-background transition-all hover:bg-accent-soft"
        >
          去创建
        </Link>
      )}
    </div>
  )
}
