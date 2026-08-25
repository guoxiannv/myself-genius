import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { TopBar } from "@/components/layout/TopBar"
import { AuthControl } from "@/components/layout/AuthControl"
import { GalleryCard } from "@/components/gallery/GalleryCard"
import { TemplatePreviewFrame } from "@/components/gallery/TemplatePreviewFrame"
import { GALLERY_CATEGORIES, GALLERY_TEMPLATES, type GalleryTemplate } from "@/lib/galleryData"
import { cn } from "@/lib/format"

type CategoryFilter = "全部" | (typeof GALLERY_CATEGORIES)[number]

export function GalleryPage() {
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState<CategoryFilter>("全部")

  const featured = useMemo(
    () => GALLERY_TEMPLATES.find((t) => t.featured) ?? GALLERY_TEMPLATES[0],
    [],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return GALLERY_TEMPLATES.filter((t) => {
      const matchCategory = category === "全部" || t.category === category
      const matchQuery =
        !q ||
        t.title.toLowerCase().includes(q) ||
        t.tagline.toLowerCase().includes(q) ||
        t.tags.some((tag) => tag.toLowerCase().includes(q))
      return matchCategory && matchQuery
    })
  }, [category, query])

  const counts = useMemo(() => {
    const acc: Record<string, number> = { 全部: GALLERY_TEMPLATES.length }
    for (const c of GALLERY_CATEGORIES) {
      acc[c] = GALLERY_TEMPLATES.filter((t) => t.category === c).length
    }
    return acc
  }, [])

  const isDefaultView = category === "全部" && !query.trim()

  return (
    <div className="aurora-bg min-h-screen">
      <TopBar
        left={<BackLink />}
        right={
          <>
            <AuthControl />
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
          </>
        }
      />

      <main className="relative z-10 mx-auto w-full max-w-6xl px-5 pb-20 pt-4 sm:px-8">
        <header>
          <h1 className="text-3xl tracking-tight sm:text-4xl">灵感库</h1>
          <p className="mt-2.5 max-w-xl text-pretty text-sm leading-relaxed text-muted">
            这些应用都由 Genius 生成并保留了完整工程。挑一个作为起点续跑，在它的基础上继续调整成你要的样子。
          </p>
        </header>

        {isDefaultView && featured && <FeaturedTemplate template={featured} />}

        <div className="mt-12 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            {(["全部", ...GALLERY_CATEGORIES] as CategoryFilter[]).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors",
                  category === c
                    ? "border-accent/40 bg-accent/15 text-accent-soft"
                    : "border-border bg-surface/60 text-muted hover:text-foreground",
                )}
              >
                {c}
                <span className="text-subtle">{counts[c]}</span>
              </button>
            ))}
          </div>

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
              placeholder="搜索模板或标签..."
              aria-label="搜索模板"
              className="w-full rounded-full border border-border bg-surface/60 py-2 pl-9 pr-4 text-sm text-foreground outline-none transition-colors placeholder:text-subtle focus:border-accent/50"
            />
          </div>
        </div>

        <div className="mt-6">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center rounded-[var(--radius-card)] border border-dashed border-border bg-surface/30 px-6 py-20 text-center">
              <p className="text-sm text-foreground">没有匹配的模板</p>
              <p className="mt-1.5 text-sm text-muted">试着换个关键词，或切换到其他分类。</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((t) => (
                <GalleryCard key={t.id} template={t} />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

function FeaturedTemplate({ template }: { template: GalleryTemplate }) {
  return (
    <section className="mt-8 overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface/40">
      <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <div className="flex flex-col justify-center gap-5 p-6 sm:p-8">
          <span className="inline-flex w-fit items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs text-accent-soft">
            <span className="h-1.5 w-1.5 rounded-full bg-accent live-dot" />
            本周精选
          </span>
          <div>
            <h2 className="text-2xl tracking-tight sm:text-[28px]">{template.title}</h2>
            <p className="mt-3 text-pretty text-sm leading-relaxed text-muted">
              {template.description}
            </p>
          </div>
          <dl className="flex flex-wrap gap-x-8 gap-y-3 border-t border-border pt-5">
            <div>
              <dt className="text-[11px] tracking-[0.14em] text-subtle">续跑次数</dt>
              <dd className="mt-1 text-lg text-foreground">{template.remixes}</dd>
            </div>
            <div>
              <dt className="text-[11px] tracking-[0.14em] text-subtle">首版耗时</dt>
              <dd className="mt-1 text-lg text-foreground">{template.buildMinutes} 分钟</dd>
            </div>
            <div>
              <dt className="text-[11px] tracking-[0.14em] text-subtle">分类</dt>
              <dd className="mt-1 text-lg text-foreground">{template.category}</dd>
            </div>
          </dl>
          <Link
            to={`/gallery/${template.id}`}
            className="inline-flex h-10 w-fit items-center gap-2 rounded-full bg-accent px-5 text-sm text-background shadow-lg shadow-accent/20 transition-colors hover:bg-accent-soft"
          >
            查看并续跑
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
              <path
                d="M5 12h14M13 6l6 6-6 6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
        </div>

        <div className="relative min-h-[340px] border-t border-border bg-background lg:border-l lg:border-t-0">
          <TemplatePreviewFrame
            html={template.previewHtml}
            canvasWidth={template.canvasWidth}
            canvasHeight={template.canvasHeight}
            title={`${template.title} 预览`}
            mode="fit"
            className="p-6"
          />
        </div>
      </div>
    </section>
  )
}

function BackLink() {
  return (
    <Link
      to="/"
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
