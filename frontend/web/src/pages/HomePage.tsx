import { Link } from "react-router-dom"
import { TopBar } from "@/components/layout/TopBar"
import { AuthControl } from "@/components/layout/AuthControl"
import { PromptComposer } from "@/components/home/PromptComposer"
import { cn } from "@/lib/format"

const STEPS = [
  {
    title: "描述创意",
    desc: "用一句话告诉 AI 你想做什么样的鸿蒙 App",
  },
  {
    title: "AI 生成与预览",
    desc: "AI 实时生成界面与逻辑，在鸿蒙模拟器中即时预览效果",
  },
  {
    title: "确认并安装",
    desc: "预览满意后主动生成签名安装包，再扫码安装到手机",
  },
]

function scrollToTop() {
  window.scrollTo({ top: 0, behavior: "smooth" })
}

export function HomePage() {
  return (
    <div className="aurora-bg relative flex min-h-screen flex-col">
      <TopBar
        right={
          <>
            <AuthControl />
            <Link
              to="/runs"
              className="inline-flex h-9 items-center gap-1.5 rounded-full border border-accent/35 bg-accent/15 px-3.5 text-xs font-semibold text-accent-soft shadow-lg shadow-black/20 transition-colors hover:border-accent/55 hover:bg-accent/25 hover:text-foreground"
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
          </>
        }
      />

      {/* 首屏：输入区，占满整屏高度 */}
      <main className="relative z-10 mx-auto flex min-h-screen w-full max-w-3xl flex-col items-center justify-center px-5 py-16">
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface/60 px-3 py-1 text-xs text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-accent live-dot" />
          AI 驱动的 HarmonyOS 应用生成
        </span>

        <h1 className="mt-6 text-balance text-center text-[2.5rem] leading-[1.15] tracking-tight text-foreground sm:text-6xl">
          一句话，构建你的
          <br />
          <span className="text-glow">鸿蒙应用</span>
        </h1>

        <p className="mt-5 max-w-lg text-pretty text-center text-sm leading-relaxed text-subtle sm:text-base">
          从想法到真机，全程自动完成。
        </p>

        <div className="mt-8 w-full">
          <PromptComposer />
        </div>
      </main>

      {/* 第二屏：三步流程 + CTA，占满整屏高度并垂直居中 */}
      <section className="relative z-10 mx-auto flex min-h-screen w-full max-w-5xl flex-col justify-center px-5 py-16">
        <h2 className="text-center text-3xl leading-tight tracking-tight text-foreground sm:text-4xl">
          三步，从想法到上架
        </h2>

        {/* 三步是真实时序，用一条贯穿的轨道表达推进关系，而非并列的装饰性编号 */}
        <ol className="mt-14 grid gap-10 sm:grid-cols-3 sm:gap-6">
          {STEPS.map((step, i) => (
            <li key={step.title} className="relative flex flex-col pt-6">
              {/* 轨道线跨过 grid gap 连到下一个节点，形成一条连续的时序轨道；末节收束为短促的收尾 */}
              <span
                aria-hidden="true"
                className={cn(
                  "absolute left-0 top-[3px] hidden h-px sm:block",
                  i === STEPS.length - 1
                    ? "w-10 bg-gradient-to-r from-accent/35 to-transparent"
                    : "w-[calc(100%+1.5rem)] bg-gradient-to-r from-accent/35 via-border to-accent/35",
                )}
              />
              <span
                aria-hidden="true"
                className="absolute left-0 top-0 h-[7px] w-[7px] rounded-full bg-accent ring-4 ring-accent/10"
              />
              <h3 className="text-base leading-snug text-foreground">{step.title}</h3>
              <p className="mt-2.5 max-w-[26ch] text-sm leading-relaxed text-subtle">{step.desc}</p>
            </li>
          ))}
        </ol>

        <div className="mt-20 flex flex-col items-center rounded-[var(--radius-card)] border border-border bg-surface/40 px-6 py-14 text-center">
          <h2 className="text-balance text-2xl leading-snug tracking-tight text-foreground sm:text-3xl">
            现在就开始打造你的鸿蒙 App
          </h2>
          <p className="mt-3.5 max-w-md text-pretty text-sm leading-relaxed text-subtle">
            免费体验 AI 生成能力，几分钟即可看到你的第一个鸿蒙应用。
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={scrollToTop}
              className="inline-flex h-10 items-center gap-1.5 rounded-full bg-accent px-5 text-sm text-background transition-colors hover:bg-accent-soft"
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
              免费开始生成
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
