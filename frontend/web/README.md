# HarmonyPilot Web 前端

基于 **Vite + React + TypeScript + Tailwind CSS v4** 的现代化前端，替代原 `templates/` + 手写 `static/app.js` 方案。后端 Python 服务保留为纯 JSON API。

## 目录结构

```
web/
├── src/
│   ├── pages/            # HomePage（一句话构建入口）、DetailPage（构建详情）
│   ├── components/
│   │   ├── home/         # PromptComposer、建议胶囊
│   │   ├── detail/       # Timeline、BuildProgress、DevicePreview、InstallDock（扫码安装悬浮坞）
│   │   ├── layout/       # TopBar
│   │   └── ui/           # Card、StatusBadge 等基础组件
│   ├── hooks/
│   │   └── useRunStream.ts   # 实时数据：优先 SSE，自动降级轮询
│   ├── lib/
│   │   ├── api.ts        # 类型化 API 客户端
│   │   ├── types.ts      # 与后端 payload 对齐的类型
│   │   └── format.ts     # 时间/className 工具
│   └── index.css         # 设计系统 token（近黑底 + 暖橙强调色）
└── vite.config.ts        # /api 代理到 Python 后端
```

详情页 `BuildProgress` 的阶段名称与状态不是前端硬编码顺序推进，而是由后端
`RunProgress` 中的 pipeline、tmux lane、UI QA、capture 和分发状态综合映射。
详细规则见 [`../docs/BUILD_PROGRESS_STAGE_RULES.md`](../docs/BUILD_PROGRESS_STAGE_RULES.md)。

## 本地开发

```bash
# 1. 启动 Python 后端（默认 127.0.0.1:8080）
PORT=8080 python3 app.py

# 2. 启动前端 dev（默认 127.0.0.1:5173，自动代理 /api）
cd web
npm install
npm run dev
```

如后端端口不同，用环境变量覆盖代理目标：

```bash
VITE_API_TARGET=http://127.0.0.1:9000 npm run dev
```

## 单独调试前端界面

前端是完全独立的工程，可以脱离 Python 后端单独启动调试。根据要调的页面选择对应方式：

### 方式一：只调首页 / 静态 UI（无需后端）

首页（`/`）不依赖任何后端数据，直接起前端即可热更新调试样式与交互：

```bash
cd web
npm install   # 首次
npm run dev
```

打开 http://127.0.0.1:5173 即可。此时 `/api/*` 没有后端会返回错误，
但首页渲染、建议胶囊、输入卡片等纯 UI 都能正常调试。
提交构建（POST `/api/runs`）需要后端，见方式二。

### 方式二：连本地后端调完整流程（首页 + 详情页）

详情页（`/runs/{id}`）需要真实的构建进度数据，要同时起后端。开两个终端：

```bash
# 终端 A：项目根目录，启动 Python 后端
PORT=8080 python3 app.py

# 终端 B：web 目录，启动前端 dev（自动把 /api 代理到 8080）
cd web
npm run dev
```

之后在首页提交一句话构建，会自动跳到详情页并实时显示进度（SSE）。

### 方式三：前端连远端 / 已部署的后端

只想调前端界面、复用一台已经在跑的后端（本机别的端口或远程机器）：

```bash
# 指向任意后端地址，前端仍跑在 5173
VITE_API_TARGET=http://192.168.1.20:8080 npm run dev
```

> 提示：详情页地址形如 `http://127.0.0.1:5173/runs/<run_id>`，
> 其中 `<run_id>` 是后端 `data/runs/` 下已存在的任务 id（16 进制）。
> 想快速造一条用于调试的记录，可在后端项目根目录执行：
>
> ```bash
> python3 - <<'PY'
> import app
> rec = app.RunRecord(
>     run_id="abcdef0123", session_name="debug-session",
>     prompt="调试用任务", workspace=str(app.TARGET_WORKSPACE),
>     variant=app.DEFAULT_VARIANT, plan_skill=app.DEFAULT_PLAN_SKILL,
>     created_at=app.to_iso(), updated_at=app.to_iso(), status="running",
> )
> app.save_run(rec); print("saved", rec.run_id)
> PY
> ```
>
> 然后访问 `http://127.0.0.1:5173/runs/abcdef0123`。调试完删除 `data/runs/abcdef0123.json` 即可。

## 对接的后端接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/runs` | 提交构建任务 |
| GET | `/api/runs/{id}` | 获取构建进度（单次） |
| GET | `/api/runs/{id}/events` | 构建进度实时推送（SSE） |
| GET | `/api/runs/{id}/install-qr` · `/hap-qr` | 安装二维码 |
| GET | `/api/runs/{id}/hap` · `/media` | HAP 下载 / 运行预览 |
| GET | `/api/health` | 健康检查 |

## 实时更新

`useRunStream` 会先连接 `GET /api/runs/{id}/events`（SSE，已在后端实现），
每帧推送一份与 `/api/runs/{id}` 相同结构的 JSON，进入终态（succeeded / failed）后自动关流。
若 SSE 连接失败（如代理不透传），会自动降级为按 `poll_interval_ms` 轮询，前端无需改动。

## 生产构建

```bash
npm run build   # 产物输出到 web/dist，可由 Python 后端或 Nginx 托管
```
