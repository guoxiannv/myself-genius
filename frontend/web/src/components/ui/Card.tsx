import { cn } from "@/lib/format"

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  glass?: boolean
}

export function Card({ glass, className, children, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-card)] border border-border",
        glass ? "glass" : "bg-surface",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
}

export function CardHeader({
  title,
  hint,
  action,
}: {
  title: React.ReactNode
  hint?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
        {hint && <p className="mt-0.5 truncate text-xs text-subtle">{hint}</p>}
      </div>
      {action}
    </div>
  )
}
