import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Link, useLocation } from "react-router-dom"
import { api, ApiError } from "@/lib/api"
import { cn } from "@/lib/format"
import type { AuthState } from "@/lib/types"

const GUEST_STATE: AuthState = { role: "guest", root_login_enabled: false }

const NAV_ITEMS = [
  {
    to: "/",
    label: "新建生成",
    hint: "从一句话开始",
    icon: (
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    ),
  },
  {
    to: "/gallery",
    label: "灵感库",
    hint: "挑个模板续跑",
    icon: (
      <path
        d="M4 5h7v7H4zM13 5h7v4h-7zM13 13h7v6h-7zM4 16h7v3H4z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    ),
  },
  {
    to: "/runs",
    label: "我的应用",
    hint: "查看历史构建",
    icon: <path d="M4 7h16M4 12h16M4 17h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
  },
]

export function UserMenu({ compact = false }: { compact?: boolean }) {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [open, setOpen] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const wrapRef = useRef<HTMLDivElement>(null)
  const { pathname } = useLocation()

  useEffect(() => {
    let active = true
    api
      .getAuthMe()
      .then((state) => active && setAuth(state))
      .catch(() => active && setAuth(GUEST_STATE))
    return () => {
      active = false
    }
  }, [])

  // 路由变化时收起菜单，避免跳转后浮层残留
  useEffect(() => setOpen(false), [pathname])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("mousedown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  const isRoot = auth?.role === "root"
  const canLogin = Boolean(auth?.root_login_enabled)

  const login = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!password || submitting) return
    setSubmitting(true)
    setError("")
    try {
      const state = await api.login(password)
      setAuth(state)
      setPassword("")
      setLoginOpen(false)
      window.location.reload()
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "登录失败，请稍后重试")
    } finally {
      setSubmitting(false)
    }
  }

  const logout = async () => {
    await api.logout().catch(() => undefined)
    window.location.reload()
  }

  return (
    <>
      <div ref={wrapRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="菜单与账户"
          className={cn(
            "inline-flex items-center gap-2 rounded-full border bg-surface/70 pl-1 pr-2.5 transition-colors",
            compact ? "h-8" : "h-9",
            open ? "border-accent/45 text-foreground" : "border-border text-muted hover:border-border-strong hover:text-foreground",
          )}
        >
          <span
            className={cn(
              "flex items-center justify-center rounded-full",
              compact ? "h-6 w-6" : "h-7 w-7",
              isRoot ? "bg-accent/20 text-accent-soft ring-1 ring-accent/40" : "bg-surface-raised text-subtle",
            )}
          >
            {isRoot ? (
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">
                <path
                  d="M12 3l7 3v5c0 4.2-2.8 7.6-7 9-4.2-1.4-7-4.8-7-9V6l7-3z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">
                <circle cx="12" cy="8.5" r="3.2" stroke="currentColor" strokeWidth="1.8" />
                <path d="M5.5 19.5a6.5 6.5 0 0113 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            )}
          </span>
          <svg
            viewBox="0 0 24 24"
            width="12"
            height="12"
            fill="none"
            aria-hidden="true"
            className={cn("transition-transform", open && "rotate-180")}
          >
            <path d="M6 9.5l6 5 6-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {open && (
          <div
            role="menu"
            aria-label="菜单与账户"
            className="glass absolute right-0 top-[calc(100%+0.5rem)] z-[80] w-60 overflow-hidden rounded-[var(--radius-card)] border border-border shadow-2xl shadow-black/50"
          >
            <p className="px-3 pb-1.5 pt-3 text-[0.6875rem] uppercase tracking-[0.18em] text-subtle">前往</p>
            <div className="pb-1.5">
              {NAV_ITEMS.map((item) => {
                const active = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to)
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    role="menuitem"
                    className={cn(
                      "flex items-center gap-2.5 px-3 py-2 transition-colors",
                      active ? "bg-accent/10 text-accent-soft" : "text-muted hover:bg-surface-raised hover:text-foreground",
                    )}
                  >
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true" className="shrink-0">
                      {item.icon}
                    </svg>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs leading-tight">{item.label}</span>
                      <span className="mt-0.5 block text-[0.6875rem] leading-tight text-subtle">{item.hint}</span>
                    </span>
                    {active && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />}
                  </Link>
                )
              })}
            </div>

            {(isRoot || canLogin) && (
              <div className="border-t border-border/70">
                {isRoot ? (
                  <>
                    <div className="flex items-center gap-2 px-3 pb-1 pt-2.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
                      <span className="text-[0.6875rem] text-accent-soft">管理员模式</span>
                    </div>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={logout}
                      className="flex w-full items-center gap-2.5 px-3 pb-2.5 pt-1 text-xs text-muted transition-colors hover:text-danger"
                    >
                      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true" className="shrink-0">
                        <path
                          d="M10 5H5v14h5M14 8l4 4-4 4M18 12H9"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      退出管理员
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setError("")
                      setOpen(false)
                      setLoginOpen(true)
                    }}
                    className="flex w-full items-center gap-2.5 px-3 py-2.5 text-xs text-muted transition-colors hover:bg-surface-raised hover:text-foreground"
                  >
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true" className="shrink-0">
                      <rect x="5" y="10" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.8" />
                      <path d="M8 10V7a4 4 0 018 0v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                    管理员登录
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {loginOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 px-5"
            role="presentation"
            onMouseDown={() => setLoginOpen(false)}
          >
            <form
              onSubmit={login}
              onMouseDown={(event) => event.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-labelledby="root-login-title"
              className="glass w-full max-w-sm rounded-[var(--radius-card)] border border-border p-6 shadow-2xl shadow-black/60"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs text-accent-soft">Bitfun Genius</p>
                  <h2 id="root-login-title" className="mt-1 text-xl text-foreground">
                    管理员登录
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => setLoginOpen(false)}
                  aria-label="关闭登录窗口"
                  className="text-subtle transition-colors hover:text-foreground"
                >
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
              <label className="mt-6 block text-sm text-muted">
                管理员密码
                <input
                  autoFocus
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="mt-2 h-10 w-full rounded-lg border border-border bg-surface-raised px-3 text-sm text-foreground outline-none transition-colors placeholder:text-subtle focus:border-accent/50"
                />
              </label>
              {error && (
                <p role="alert" className="mt-3 text-sm text-danger">
                  {error}
                </p>
              )}
              <button
                type="submit"
                disabled={!password || submitting}
                className="mt-6 inline-flex h-10 w-full items-center justify-center rounded-lg bg-accent px-4 text-sm text-background transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? "验证中…" : "进入管理模式"}
              </button>
            </form>
          </div>,
          document.body,
        )}
    </>
  )
}
