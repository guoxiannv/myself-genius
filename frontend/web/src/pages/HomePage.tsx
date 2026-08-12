import { Link } from "react-router-dom"
import { TopBar } from "@/components/layout/TopBar"
import { AuthControl } from "@/components/layout/AuthControl"
import { PromptComposer } from "@/components/home/PromptComposer"

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

        <h1 className="mt-5 text-balance text-center text-4xl font-bold leading-tight tracking-tight sm:text-6xl">
          一句话，构建你的
          <br />
          <span className="text-glow">鸿蒙应用</span>
        </h1>

        <p className="mt-4 max-w-lg text-pretty text-center text-base leading-relaxed text-muted">
          从想法到真机，全程自动完成。
        </p>

        <div className="mt-8 w-full">
          <PromptComposer />
        </div>
      </main>

      {/* 第二屏：三步流程 + CTA，占满整屏高度并垂直居中 */}
      <section className="relative z-10 mx-auto flex min-h-screen w-full max-w-5xl flex-col justify-center px-5 py-16">
        <h2 className="text-center font-serif text-4xl font-black tracking-tight sm:text-5xl">
          三步，从想法到上架
        </h2>

        <ol className="mt-12 grid gap-10 sm:grid-cols-3 sm:gap-8">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex flex-col">
              <span className="text-5xl font-bold leading-none tracking-tight text-accent/70">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="mt-5 text-lg font-semibold text-foreground">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{step.desc}</p>
            </li>
          ))}
        </ol>

        <div className="mt-16 rounded-[2.5rem] border border-border bg-surface/50 px-6 py-12 text-center">
          <h2 className="text-balance font-serif text-3xl font-black tracking-tight sm:text-4xl">
            现在就开始打造你的鸿蒙 App
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-pretty text-base leading-relaxed text-muted">
            免费体验 AI 生成能力，几分钟即可看到你的第一个鸿蒙应用。
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={scrollToTop}
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
              免费开始生成
            </button>
            <a
              href="https://gitee.com/harmonyos-cases/cases"
              target="_blank"
              rel="noreferrer"
              className="rounded-xl border border-border bg-surface-raised px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-border-strong"
            >
              查看示例作品
            </a>
          </div>
        </div>
      </section>
    </div>
  )
}
