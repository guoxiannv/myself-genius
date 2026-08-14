import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { api, ApiError } from "@/lib/api"
import type { AuthState } from "@/lib/types"

const GUEST_STATE: AuthState = { role: "guest", root_login_enabled: false }

export function AuthControl({ compact = false }: { compact?: boolean }) {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    let active = true
    api.getAuthMe().then((state) => active && setAuth(state)).catch(() => active && setAuth(GUEST_STATE))
    return () => {
      active = false
    }
  }, [])

  const login = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!password || submitting) return
    setSubmitting(true)
    setError("")
    try {
      const state = await api.login(password)
      setAuth(state)
      setPassword("")
      setOpen(false)
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

  if (auth?.role === "root") {
    return (
      <button
        type="button"
        onClick={logout}
        className={`inline-flex items-center gap-1.5 rounded-full border border-accent/35 bg-accent/15 text-xs font-semibold text-accent-soft transition-colors hover:border-accent/55 hover:text-foreground ${compact ? "h-8 px-2.5" : "h-9 px-3"}`}
        title="退出管理员"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
          <path d="M10 5H5v14h5M14 8l4 4-4 4M18 12H9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="hidden sm:inline">管理员</span>
      </button>
    )
  }

  if (auth && !auth.root_login_enabled) return null

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError("")
          setOpen(true)
        }}
        className={`inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/70 text-xs font-semibold text-muted transition-colors hover:border-border-strong hover:text-foreground ${compact ? "h-8 px-2.5" : "h-9 px-3"}`}
        title="管理员登录"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
          <rect x="5" y="10" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span className="hidden sm:inline">管理员登录</span>
      </button>

      {open && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 px-5" role="presentation" onMouseDown={() => setOpen(false)}>
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
                <p className="text-xs font-semibold text-accent-soft">Bitfun Genius</p>
                <h2 id="root-login-title" className="mt-1 text-xl font-bold text-foreground">管理员登录</h2>
              </div>
              <button type="button" onClick={() => setOpen(false)} aria-label="关闭登录窗口" className="text-subtle transition-colors hover:text-foreground">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <label className="mt-6 block text-sm font-medium text-muted">
              管理员密码
              <input
                autoFocus
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="mt-2 h-10 w-full rounded-lg border border-border bg-surface-raised px-3 text-sm text-foreground outline-none transition-colors placeholder:text-subtle focus:border-accent/50"
              />
            </label>
            {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
            <button
              type="submit"
              disabled={!password || submitting}
              className="mt-6 inline-flex h-10 w-full items-center justify-center rounded-lg bg-accent px-4 text-sm font-semibold text-background transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-60"
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
