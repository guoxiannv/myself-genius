# UI 美观与生成链路改动记录

## 这次提交解决的问题

- 生成阶段先产生一个一次性的 `.expo-fast/design.html`，主实现模型必须读取它并按其视觉层级、色彩 token、间距、圆角、密度和 Lucide 图标实现原生 UI；main 现有的 `.expo-fast/brief.json` 和独立应用图标流程保持不变。
- HTML 设计回合在拿到 prompt 后立即启动，并与模板准备、能力索引和依赖准备并行，避免增加端到端关键路径。
- 设计稿现在明确按三档逻辑画布检查：`390x844` 手机、`1024x640` 紧凑 PC/平板、`1440x900` 宽屏桌面。
- HTML 使用 CSS media query 作为响应式布局事实来源：`<640`、`640–1279`、`>=1280`；要求紧凑 PC 使用平衡的顶部导航和一到两列内容，宽屏使用侧边栏和真正的多列内容，避免把手机列表横向拉宽。
- 设计稿包含轻量 `matchMedia` 监测脚本，更新 `html[data-viewport]`、`data-logical-width` 和 `data-logical-height`，仅用于检查当前画布，不负责替代 CSS 布局。
- 如果模型漏写监测脚本，runner 在保存设计稿时会自动补齐；如果设计回合超时或输出不合格，则降级为无设计稿流程。

## 原生实现与验证规则

- Harmony 首屏使用根容器 `onLayout` 获取稳定逻辑宽度，在布局和 AsyncStorage hydration 都完成后才挂载业务页面，修复首次页面挤压、切换 Tab 后才正常的问题。
- 多设备断点统一为手机 `<640`、平板 `640–1279`、桌面 `>=1280`，不再根据物理模拟器像素推断布局。
- 半宽换行卡片使用约 `48%` 的 `flexBasis`、匹配的 `maxWidth` 和 `flexGrow: 0`，避免最后一个 item 独占整行。
- 桌面导航必须和主内容位于同一个横向 root 中；图标优先使用本地 Path-only Lucide 几何，避免 Harmony Go 对混合 SVG shape 的渲染问题。
- HAP 预览在新 bundle 尚未安装时允许 `force-stop` 失败后继续安装；runner 测试覆盖布局、权限、trace scope、依赖和预览池规则。

## Thinking 配置说明

- 独立 HTML 设计回合：`haiku` 默认、`low` effort、45 秒硬上限，并通过 `X-Genius-Disable-Thinking: 1` 请求关闭 thinking；它只负责快速生成视觉参考。
- 主实现回合：仍按所选模型和 effort 正常运行，没有设置 `X-Genius-Disable-Thinking: 1`。因此不会为了省设计稿时间而牺牲主实现质量。
- `deepseek-v4-flash` 是可通过 `--model` 指定的主实现/修复模型，不等同于“全链路禁止 thinking”。当前代码中 no-thinking header 只位于 `designTurn()`。

## 验证

- `runner/tests/orchestrator.test.mjs`：71/71 通过。
- 相关变更：`runner/scripts/run-livetest.mjs`、`runner/scripts/start-livetest.mjs`、`runner/templates/expo-harmony/src/app-shell.tsx`、`runner/scripts/verify-product.mjs`、`runner/scripts/trace-scope.mjs`、`runner/AGENTS.md`、`runner/docs/runtime-contract.md` 及对应测试/示例配置。
