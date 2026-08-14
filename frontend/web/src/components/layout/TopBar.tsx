import { Link } from "react-router-dom"

export function TopBar({
  left,
  right,
  compact = false,
}: {
  left?: React.ReactNode
  right?: React.ReactNode
  compact?: boolean
}) {
  return (
    <header className={`relative z-10 flex items-center justify-between px-5 ${compact ? "py-2.5 sm:px-6" : "py-4 sm:px-8"}`}>
      {left ?? (
        <Link to="/" className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent/15 ring-1 ring-accent/30">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
              <path
                d="M12 2l2.6 6.4L21 11l-6.4 2.6L12 20l-2.6-6.4L3 11l6.4-2.6L12 2z"
                fill="var(--color-accent)"
              />
            </svg>
          </span>
          <span className="text-sm font-semibold tracking-tight">
            Bitfun <span className="text-glow">Genius</span>
          </span>
        </Link>
      )}
      <div className="flex items-center gap-3">{right}</div>
    </header>
  )
}
