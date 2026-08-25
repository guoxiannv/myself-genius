import { Link } from "react-router-dom"
import { TemplatePreviewFrame } from "./TemplatePreviewFrame"
import type { GalleryTemplate } from "@/lib/galleryData"

export function GalleryCard({ template }: { template: GalleryTemplate }) {
  return (
    <Link
      to={`/gallery/${template.id}`}
      className="group flex flex-col overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface/50 transition-colors hover:border-accent/40 hover:bg-surface"
    >
      <div className="relative aspect-[4/3] overflow-hidden border-b border-border bg-background">
        <TemplatePreviewFrame
          html={template.previewHtml}
          canvasWidth={template.canvasWidth}
          canvasHeight={template.canvasHeight}
          title={`${template.title} 预览`}
          mode="cover"
          lazy
        />
        {/* 顶部渐隐，避免缩略图裁切边缘过硬 */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-background/85 to-transparent" />
        <div className="pointer-events-none absolute inset-0 flex items-end justify-center pb-4 opacity-0 transition-opacity group-hover:opacity-100">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-2 text-xs text-background shadow-lg shadow-black/30">
            查看并续跑
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

      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-surface-raised px-2 py-0.5 text-[11px] text-muted">
            {template.category}
          </span>
          <span className="text-[11px] text-subtle">{template.remixes} 次续跑</span>
        </div>
        <h3 className="mt-2.5 text-[15px] text-foreground">{template.title}</h3>
        <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-muted">{template.tagline}</p>
      </div>
    </Link>
  )
}
