import type { ReactNode } from "react"

export interface Suggestion {
  label: string
  prompt: string
  icon: ReactNode
}

const iconProps = {
  viewBox: "0 0 24 24",
  width: 16,
  height: 16,
  fill: "none",
  "aria-hidden": true,
} as const

export const SUGGESTIONS: Suggestion[] = [
  {
    label: "番茄闹钟",
    prompt:
      "实现一个番茄闹钟计时器，支持专注与休息循环及提示音",
    icon: (
      <svg {...iconProps}>
        <circle cx="12" cy="13" r="8" stroke="currentColor" strokeWidth="2" />
        <path
          d="M12 9v4l2 2M9 2h6"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    label: "待办清单应用",
    prompt:
      "实现一个简洁的待办清单应用，支持增删改与本地存储",
    icon: (
      <svg {...iconProps}>
        <path
          d="M9 11l3 3L22 4"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    label: "记账应用",
    prompt:
      "实现一个记账应用，支持收支记录与分类统计",
    icon: (
      <svg {...iconProps}>
        <path
          d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    label: "相册心情拼贴",
    prompt:
      "做一个相册心情拼贴 App，从相册选多张图，添加心情标签，生成本地日记卡片",
    icon: (
      <svg {...iconProps}>
        <rect
          x="4"
          y="6"
          width="14"
          height="13"
          rx="2"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path
          d="M7 4h11a2 2 0 0 1 2 2v10"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M7 16l3.2-3.4 2.3 2.4 1.5-1.5 2 2.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="9" cy="10" r="1" fill="currentColor" />
      </svg>
    ),
  },
]
