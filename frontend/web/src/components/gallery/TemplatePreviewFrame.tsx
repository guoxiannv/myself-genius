import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/format"

/**
 * 把模板产物按容器尺寸等比缩放后嵌入。
 *
 * 与详情页 DevicePreview 的 Web 页签使用同一套 iframe 通路：真实接入后把
 * srcDoc 换成产物 URL 即可，缩放与懒加载逻辑无需改动。
 *
 * - fit：完整放入容器（详情页用，能看到整屏）
 * - cover：按宽度铺满、顶部对齐裁切（列表缩略图用，文字保持可读）
 */
export function TemplatePreviewFrame({
  html,
  canvasWidth,
  canvasHeight,
  title,
  mode = "fit",
  lazy = false,
  className,
}: {
  html: string
  canvasWidth: number
  canvasHeight: number
  title: string
  mode?: "fit" | "cover"
  lazy?: boolean
  className?: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0)
  const [visible, setVisible] = useState(!lazy)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (!box || box.width === 0) return
      const next =
        mode === "cover"
          ? box.width / canvasWidth
          : Math.min(box.width / canvasWidth, box.height / canvasHeight)
      setScale(next)
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [canvasHeight, canvasWidth, mode])

  useEffect(() => {
    if (!lazy) return
    const host = hostRef.current
    if (!host) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: "240px" },
    )
    observer.observe(host)
    return () => observer.disconnect()
  }, [lazy])

  return (
    <div ref={hostRef} className={cn("relative h-full w-full overflow-hidden", className)}>
      {!loaded && <div className="skeleton absolute inset-0" />}
      {visible && scale > 0 && (
        <iframe
          srcDoc={html}
          title={title}
          onLoad={() => setLoaded(true)}
          loading={lazy ? "lazy" : undefined}
          // 无 allow-same-origin：模板脚本可运行，但无法访问父页面。
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          tabIndex={-1}
          aria-hidden={mode === "cover"}
          className={cn(
            "absolute border-0 transition-opacity duration-300",
            loaded ? "opacity-100" : "opacity-0",
            mode === "cover" && "pointer-events-none",
          )}
          style={{
            width: canvasWidth,
            height: canvasHeight,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            // fit 模式下把缩放后的画布在容器内居中
            left: mode === "fit" ? "50%" : 0,
            top: mode === "fit" ? "50%" : 0,
            marginLeft: mode === "fit" ? -(canvasWidth * scale) / 2 : 0,
            marginTop: mode === "fit" ? -(canvasHeight * scale) / 2 : 0,
          }}
        />
      )}
    </div>
  )
}
