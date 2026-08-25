import { useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { TopBar } from "@/components/layout/TopBar"
import { UserMenu } from "@/components/layout/UserMenu"
import { GalleryCard } from "@/components/gallery/GalleryCard"
import { TemplatePreviewFrame } from "@/components/gallery/TemplatePreviewFrame"
import { api, ApiError } from "@/lib/api"
import { cn, formatDateTime } from "@/lib/format"
import { GALLERY_TEMPLATES, findTemplate, type GalleryTemplate } from "@/lib/galleryData"

export function GalleryDetailPage() {
  const { templateId = "" } = useParams()
  const template = findTemplate(templateId)

  if (!template) {
    return (
      <div className="aurora-bg min-h-screen">
        <TopBar left={<BackLink />} right={<UserMenu />} />
        <main className="relative z-10 mx-auto w-full max-w-3xl px-5 py-24 text-center">
          <h1 className="text-2xl tracking-tight">模板不存在</h1>
          <p className="mt-3 text-sm text-muted">这个模板可能已下线，回到灵感库看看其他示例。</p>
          <Link
            to="/gallery"
            className="mt-7 inline-flex h-10 items-center rounded-full bg-accent px-5 text-sm text-background transition-colors hover:bg-accent-soft"
          >
            返回灵感库
          </Link>
        </main>
      </div>
    )
  }

  const related = GALLERY_TEMPLATES.filter(
    (t) => t.id !== template.id && t.category === template.category,
  ).slice(0, 3)

  return (
    <div className="aurora-bg min-h-screen">
      <TopBar
        left={<BackLink />}
        right={
          <>
            <Link
              to="/"
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-accent px-3.5 text-xs text-background shadow-lg shadow-accent/20 transition-colors hover:bg-accent-soft"
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
            <UserMenu />
          </>
        }
      />

      <main className="relative z-10 mx-auto w-full max-w-6xl px-5 pb-20 pt-4 sm:px-8">
        <nav className="flex items-center gap-2 text-xs text-subtle">
          <Link to="/gallery" className="transition-colors hover:text-foreground">
            灵感库
          </Link>
          <span aria-hidden="true">/</span>
          <span className="text-muted">{template.category}</span>
        </nav>

        <header className="mt-4 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-3xl tracking-tight sm:text-4xl">{template.title}</h1>
            <p className="mt-2.5 text-sm text-muted">{template.tagline}</p>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-subtle">
            <span>{template.author}</span>
            <span>{template.remixes} 次续跑</span>
            <span>首版耗时 {template.buildMinutes} 分钟</span>
          </div>
        </header>

        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:items-start">
          <PreviewPane template={template} />
          <div className="flex flex-col gap-6">
            <ResumePanel template={template} />
            <AboutPanel template={template} />
          </div>
        </div>

        {related.length > 0 && (
          <section className="mt-16">
            <h2 className="text-lg tracking-tight">同类模板</h2>
            <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {related.map((t) => (
                <GalleryCard key={t.id} template={t} />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

function PreviewPane({ template }: { template: GalleryTemplate }) {
  return (
    <section className="overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface/40">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-success" />
          <h2 className="text-sm text-foreground">应用预览</h2>
        </div>
        <span className="text-[11px] text-subtle">
          {template.canvasWidth} × {template.canvasHeight}
        </span>
      </div>
      {/* 与详情页 Web 页签相同的 iframe 通路，此处嵌入已存产物 */}
      <div className="relative h-[560px] bg-background sm:h-[640px]">
        <TemplatePreviewFrame
          html={template.previewHtml}
          canvasWidth={template.canvasWidth}
          canvasHeight={template.canvasHeight}
          title={`${template.title} 应用预览`}
          mode="fit"
          className="p-5"
        />
      </div>
      <p className="border-t border-border px-5 py-3 text-[11px] leading-relaxed text-subtle">
        预览为该模板首版生成的真实产物，可直接交互。续跑后会基于同一份工程继续修改。
      </p>
    </section>
  )
}

function ResumePanel({ template }: { template: GalleryTemplate }) {
  const navigate = useNavigate()
  const [extra, setExtra] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleResume() {
    if (submitting) return
    setSubmitting(true)
    setError(null)

    // 续跑 = 以模板工程为起点新建一次运行。后端支持 fork 后，这里应把
    // template.sourceRunId 一起提交，由后端复制该工作区而非从零生成。
    const prompt = extra.trim()
      ? `${template.prompt}\n\n在此基础上调整：${extra.trim()}`
      : template.prompt

    try {
      const res = await api.createRun({ prompt, runtime: template.runtime })
      navigate(res.detail_url || `/runs/${res.run_id}`)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "续跑启动失败，请稍后重试",
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="rounded-[var(--radius-card)] border border-accent/25 bg-accent/[0.06] p-5">
      <h2 className="text-sm text-foreground">以此模板续跑</h2>
      <p className="mt-2 text-[13px] leading-relaxed text-muted">
        我们已保存这个模板的完整工程。续跑会在它的基础上继续生成，你可以先补充想改动的地方。
      </p>

      <div className="mt-4 rounded-xl border border-border bg-background/50 p-3.5">
        <p className="text-[11px] tracking-[0.14em] text-subtle">原始创意</p>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">{template.prompt}</p>
      </div>

      <label htmlFor="resume-extra" className="mt-4 block text-[11px] tracking-[0.14em] text-subtle">
        补充调整（可选）
      </label>
      <textarea
        id="resume-extra"
        value={extra}
        onChange={(e) => setExtra(e.target.value)}
        rows={3}
        placeholder="例如：换成浅色主题，并加上每周统计图表"
        className="mt-2 w-full resize-none rounded-xl border border-border bg-background/50 px-3.5 py-3 text-sm leading-relaxed text-foreground outline-none transition-colors placeholder:text-subtle focus:border-accent/50"
      />

      {error && (
        <p className="mt-3 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13px] leading-relaxed text-danger">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={handleResume}
        disabled={submitting}
        className={cn(
          "mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-full text-sm transition-colors",
          submitting
            ? "cursor-not-allowed bg-accent/40 text-background/70"
            : "bg-accent text-background shadow-lg shadow-accent/20 hover:bg-accent-soft",
        )}
      >
        {submitting ? (
          "正在启动续跑…"
        ) : (
          <>
            开始续跑
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
              <path
                d="M5 12h14M13 6l6 6-6 6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </>
        )}
      </button>
    </section>
  )
}

function AboutPanel({ template }: { template: GalleryTemplate }) {
  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface/40 p-5">
      <h2 className="text-sm text-foreground">关于这个模板</h2>
      <p className="mt-2.5 text-[13px] leading-relaxed text-muted">{template.description}</p>

      <div className="mt-4 flex flex-wrap gap-2">
        {template.tags.map((tag) => (
          <span
            key={tag}
            className="rounded-md border border-border bg-surface-raised px-2 py-1 text-[11px] text-muted"
          >
            {tag}
          </span>
        ))}
      </div>

      <dl className="mt-5 flex flex-col gap-3 border-t border-border pt-4 text-[13px]">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-subtle">生成引擎</dt>
          <dd className="text-muted">{template.runtime === "expo" ? "Genius 2.0" : "Genius 1.0"}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-subtle">工程标识</dt>
          <dd className="font-mono text-[12px] text-muted">{template.sourceRunId}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-subtle">发布时间</dt>
          <dd className="text-muted">{formatDateTime(template.createdAt)}</dd>
        </div>
      </dl>
    </section>
  )
}

function BackLink() {
  return (
    <Link
      to="/gallery"
      className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-surface/70 px-3.5 text-xs text-foreground shadow-lg shadow-black/15 transition-colors hover:border-accent/50 hover:bg-accent/10 hover:text-accent-soft"
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
