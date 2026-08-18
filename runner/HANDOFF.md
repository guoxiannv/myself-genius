# Expo Harmony Fast 编排优化交接

更新日期：2026-08-18（Asia/Shanghai）

> 本文件主要保留 2026-08-09 至 2026-08-10 的实验结论和决策背景。当前运行入口、目录结构和脚本职责以 `README.md` 为准；历史轮次的固定数据不要改写为当前运行状态。

## 0. 当前架构（2026-08-18）

编排现位于 Genius 仓库的 `runner/` 子目录，生成应用默认放在相邻的 `expo-app/`。运行时已停止依赖 `skills/expo-harmony-fast/SKILL.md`：模板迁到 `templates/expo-harmony/`，运行合同迁到 `docs/runtime-contract.md`，能力与模板逻辑迁到 `scripts/fast-harmony.mjs`。

当前职责边界如下：

- `scripts/run-livetest.mjs` 是唯一端到端状态机和模型回合控制器。
- `scripts/execution-policy.mjs` 统一解析外部 model/effort 参数与 `config/execution.json` 默认值。
- `scripts/fast-harmony.mjs` 只负责模板准备、capability catalog 和 capability resolution。
- `scripts/dependencies.mjs` 统一负责 runtime pin、依赖缓存、能力依赖同步和 Harmony Go export。
- 独立的 `scripts/catalog.mjs` 已删除；`npm run catalog -- <project>` 直接调用 `fast-harmony.mjs catalog`。
- `direct`、`brief`、`repair` 三套 candidate 已合并为一套执行策略，`config/candidates.json` 已由 `config/execution.json` 取代。
- 启动入口不再接受 `--candidate` 或根据请求复杂度自动分流。主回合与 repair 回合的 model/effort 均可由外部参数传入，配置文件只提供默认值。
- 确定性门禁失败后在同一 session 继续 repair，单次运行最多 100 轮；达到上限、模型/进程失败、每轮 `--repair-timeout`、用户停止或系统限制均会终止。
- 当前模型 prompt 保持不变，仍由 `scripts/run-livetest.mjs` 和复制到生成工程的 `AGENTS.md` 共同构成。
- 首轮完成后可用 `--follow-up-file` 续跑原 Claude session；`follow-up-control.sh` 为 Remote UI 提供持久化 FIFO、编辑、删除和中断。worker 在 Agent 与最终 gate 后立即结束，不等待设备租约；Remote UI 再发布最新 Bundle。
- follow-up/repair Agent 可调用固定工程范围的 `check`、`build`，具体实现与外层最终门禁共用 `scripts/verification.mjs`；不存在任意 shell 工具。
- `--rebuild`、`--preview-only` 已从用户增量回合中拆开。follow-up 默认不自动重建 HAP，避免拖慢日常修改；请求最新手机安装包时再走 HAP/签名。`--rebuild --hap true` 强制 SDK pool 发布新 HAP 和新结果元数据，不复用旧 ready HAP。
- 增量 trace 位于 `.expo-fast/revisions/NNN-follow-up/`；`result.json.revisions` 保留每轮耗时/usage/repair 证据，首轮时间指标不被覆盖。

## 1. 历史交接结论

以下结论描述的是当时的 Prompt、Skill、runner、gate、测试和实验报告状态；相关文件现已迁入 `runner/`，但历史实验数据保持原样。

Live Test 生成应用按约定放在：

`../expo-app`

当前有效的三轮独立实验分别是：

- `cold-v1-learning-go`
- `cold-v2-learning-go`
- `cold-v3-learning-go`

每个应用自己的 `.expo-fast/agent-trace.jsonl` 是 Claude Code Runtime 原始生成
trace。编排仓中的 `experiments/cold-start-v1/*-trace.json` 是它们的汇总。

当前保留的编排基线是 Cold 2 使用的 vertical-slice prompt。它是三轮中唯一在
20 分钟内正常完成 typecheck、audit、Harmony Go export、artifact gate 和 launch 的
独立生成：总生成 788,597 ms（13:09），冻结评分 38/52（73.1%）。这只是当前最快
可用基线，不代表功能已完整。

不要采用 Cold 3 的 coverage-ledger 变体。该变体导致约 7 分钟首写前推理，Agent
又回到 `types → lib → state → components → screens → app-shell` 的 bottom-up 顺序，
20 分钟时只写出 Today/Board，入口仍是 starter。该 prompt/skill 变化已经回退。

2026-08-09 后续迭代已修复 Fast 能力面被硬编码为 SVG + AsyncStorage 的问题：

- catalog schema v3 同时读取 package-local `harmony-support.json` 和
  `tools/harmony/support/compatibility/*.json`，保留 available/unavailable、端口、限制和
  support contract 来源。
- SVG 仍是模板自带 icon system 的 scaffold capability；其他 Expo/RN 产品能力由单次
  implementation turn 在紧凑 brief 中选择，并以 catalog 精确版本写入
  `package.json.dependencies`。
- runner 在 typecheck 前通过 `scripts/dependencies.mjs sync` 确定性保护 scaffold、拒绝未支持包和
  版本漂移、安装所选依赖，并写 `.expo-fast/capability-selection.json`。
- JSON 导出/导入不再允许退化为页面展示和手工粘贴；source gate 分别要求
  `expo-sharing.shareAsync` 与 `expo-document-picker.getDocumentAsync`。
- AsyncStorage 只作为 Harmony Go Host 的 1.24 runtime override 用于普通大块本地状态；
  这不把 devkit 中未通过的 AsyncStorage 2.2 compatibility contract 宣称为可用。

上述变化已尝试 Cold 4，但该轮 Agent 越界读取旧产品源码，因此不能作为新的独立
cold-start 结论；旧 Cold 1/2/3 仍是有效对照组。

2026-08-10 根据会话 `019fe57a-c1ee-72c0-84c1-34cb2275cc09` 的多端复盘，Fast
Runner 又补齐了响应式合同：所有断点都使用 `useWindowDimensions()` 的逻辑宽度，手机
`<640` 为底部导航/单列，平板 `640–1279` 为顶部横向导航，桌面 `>=1280` 为固定左侧栏
加多栏主内容。桌面侧栏和主内容必须是同一个横向根容器的兄弟节点，不能把侧栏写在
横向 frame 外。模板已从旧的 `>=1000` 修正为 `>=1280`，并给桌面列表提供约 48% 卡片
换行结构；当时的 Runner Prompt、Skill、runtime contract、source audit 和回归测试同步更新。

2026-08-10 新一轮 `cold-v4-learning-go` 的原始实现回合在 20 分钟截止，且 trace 证明
它读取了 `test-project-go` 的 21 个业务源码文件；新工程非短唯一行有 73.9% 可在旧工程
找到。故这一轮冷启动实验作废，不能用恢复后的 40/52 或成品 PASS 替换其“超时 +
source-boundary invalid”结论。恢复后的应用最终通过 exact-app 核心状态变化和强停重启
持久化，可作为成品逻辑审阅样本。详见 `iteration-4-review.json` 与
`iteration-4-trace.json`。

本次同时补了三道通用门禁：`scripts/trace-scope.mjs` 拒绝跨项目/依赖/隐藏编排读取和
Bash；identity gate 拒绝可见 runtime error overlay；launch 对同 manifest id 先移除再
安装当前 catalog Bundle。当时的全量测试为 15/15 PASS；当前测试数量可能变化，以 `npm test` 结果为准。

## 2. 必须先读的文件

建议下一位 Agent 按以下顺序阅读：

1. `AGENTS.md`
2. 本文件 `HANDOFF.md`
3. `EXPERIMENT-REPORT.md` 的“独立 cold-start-v1 复现实验（有效结论）”章节
4. `experiments/cold-start-v1/rubric.json`
5. 四份 `iteration-*-review.json`（Iteration 4 标记为 invalid）
6. `scripts/run-livetest.mjs`
7. `scripts/validate-smoke.mjs`
8. `scripts/verify-product.mjs`
9. `scripts/fast-harmony.mjs`
10. `docs/runtime-contract.md`
11. `config/execution.json`
12. `scripts/verification.mjs`
13. `scripts/follow-up-control.mjs`

完整会话记录在 `session-history/README.md` 所列文件中。

## 3. 实验纪律

后续每一轮必须是独立 cold-start：

- 目标目录必须此前不存在。
- 只可复用技术模板和 fingerprint 一致的依赖缓存。
- 不复制上一轮 `App.tsx`、`src/**`、brief、缺陷清单或产品测试答案。
- 不恢复上一轮 Claude session。
- 不向生成 Agent 暴露冻结评分表或前一轮产品专用 bug 清单。
- 每轮使用相同原始场景 prompt 和冻结评分表。
- 每轮完成后依次审 Agent trace、源码、业务逻辑、构建证据、模拟器状态变化和视觉。
- 只把通用编排经验带到下一轮。
- 20 分钟超时即失败，不用 `--acceptClaudeDeadline true` 接受半成品。
- Live Test 可放 tmux，3–5 分钟低频监控；运行中不要读正在写入的 trace。

runner 会写 `.expo-fast/experiment.json`，其中必须有：

```json
{
  "protocol": "cold-start-v1",
  "coldStart": true,
  "sourceInheritance": false
}
```

`--baseProject` / `--base-project` 已被拒绝。此前报告中的 warm-start 7:57、5:42
结果已明确作废，不能再作为零到一速度结论。

## 4. 三轮有效结果

| 轮次 | 生成时间 | trace | 最终状态 | 冻结评分 |
| --- | ---: | --- | --- | ---: |
| Cold 1 | 20 分钟超时 | 27 turns / 19,828 output tokens / $0.5395 | TS FAIL；0 个业务 screen；starter 入口 | 13/52 |
| Cold 2 | 13:09 | 50 turns / 29,829 output tokens / $1.1470 | build/export/launch PASS；真实打卡与重启持久化曾通过 | 38/52 |
| Cold 3 | 20 分钟超时 | 24 turns / 54,545 output tokens / $1.0132 | TS/audit FAIL；只写 Today/Board；0 个业务 screen 接入 | 13/52 |

Cold 1 失败模式：bottom-up 先做 theme/types/dates/calc/seed/storage/store/charts/
forms，20 分钟时没有开始四个 screen。

Cold 2 成功点：prompt 要求第一阶段替换 starter、连接入口与所有 screen、建立真实
主状态变更，然后再深化计算、持久化、次要操作、图表和视觉；`repair` effort 使用
medium；无 repair 即正常退出。

Cold 3 失败模式：分类 coverage ledger 过重，诱发长时间前置推理；Agent 自己的 plan
违背 vertical-slice；完整重写 `lib.ts` 后才开始 screen。这个失败说明“更多闭环提示”
不等于更高完成率。

## 5. Cold 2 已知功能缺口

不要把 source audit / launch PASS 当成功能完整。冻结审阅确认：

- streak/rest-day 倒序扫描把最近 miss 当成本周第一次 miss，且不尊重 `goal.createdAt`。
- Python 连续漏打在 UI 中错误显示黄卡。
- ETA 的样本日计数使用全部历史日期，而非近 7 天内 distinct dates。
- 周报先按单位展示，却把不同单位相加计算统一 amount 环比。
- 看板每目标各画单系列柱，不是一个真正的多目标 stacked chart。
- seed 只有 12 条；20 条备份横幅初始不可达。
- 横幅 CTA 只切到“我的”，没有在一次点击中直接生成导出数据。
- modal close 使用文本 `×`，违反所有图标 inline SVG 的严格要求。
- 所谓紫色 gradient 主要是纯色背景。
- 预案文案可能显示成“我就如果……”。

详细逐项评分见 `iteration-2-review.json`。

## 6. 已修复：Harmony Go 身份、错误层与 stale Bundle gate

原先的 exact-app 假阳性风险已修复，不再是待办。

2026-08-09 再检查模拟器时，实际运行的是旧 warm-start
`fast-v2-learning-go-iter3`，而不是 Cold 2。Host 顶部会同时列出所有已安装项目，
所以 layout 中依然出现 `cold-v2-learning-go` 按钮。现有 gate 只检查整个 layout 是否
包含 manifest id：

- `run-livetest.mjs` 的 `alreadyProduct`
- `installAndOpen()` 最终 identity 检查
- `validate-smoke.mjs` 的 `contains(layout, manifest.id)`

这会把 catalog/项目切换按钮里的 id 当成“当前正在运行的 mini app id”。多个应用又
共享 `responsive-navigation`、`app-shell` 等模板 testID，进一步增加串 App 假 PASS
风险。

当前实现：

- Harmony Go 壳 bundleName 不再硬编码旧的 `host.exp.exponent.harmony`；统一由
  `scripts/harmony-go-runtime.mjs` 从显式覆盖、HAP 元数据或当前 SDK 默认值
  `com.example.myapplication1.ide` 解析，并贯穿安装、启动和身份门禁。
- 不允许“layout 任意位置包含 id”。
- 定位 Host 当前项目标题/selected project control，要求其精确等于 manifest id。
- 区分 catalog navigation subtree 与 product content subtree。
- 要求至少一个本轮唯一、非模板共享的 identity marker 位于 product subtree。
- 在 before、after、force-stop/reopen 三份 layout 中都验证同一 current-project marker。
- 新增负例单测：当前运行 A，但项目栏也列出 B；验证 B 必须失败。
- 可见 `Error:`、`RNOH ERROR CONTEXT` 或 `Cannot find native module` 会直接让身份失败。
- launch 进入项目 catalog，对同 id 的旧安装先“移除”，再安装当前导出的 Bundle。

不要删除旧 evidence；历史证据仍保留旧 gate 的局限说明。

## 7. 是否存在源码继承 hack

目前没有找到 Cold 2 业务源码继承证据：

- Cold 2 trace 没有读取 `fast-v2-*`、Cold 1/3 或 `baseProject`。
- trace 中绝对工具路径都在自己的 fresh project 内。
- Cold 2 与旧 warm Iteration 3 逐文件哈希对比，只有极小的技术入口 `App.tsx`
  完全相同；没有 `src/**` 整文件相同。
- 非空、非短行的 exact line overlap 约占 Cold 2 unique lines 的 13.9%，主要是 import、
  responsive shell 和 StyleSheet 模板结构。

视觉相似的主要来源：相同用户 prompt 明确规定冷白/紫色/四 Tab/桌面侧栏/同样示例
目标；编排又明确要求复用同一技术模板的 theme/icons/UI。因此独立生成也会视觉收敛。

准确表述应是：没有发现 Cold 2 继承旧业务源码，但模拟器曾打开错项目，且身份 gate
可能假阳性；不能用旧 gate 单独证明 exact app。

Cold 4 则不同：trace 明确读取 `test-project-go` 的完整业务实现以及 Cold 1/2/3 路径，
83 项 trace-scope 违规；其 73.9% 非短唯一行重叠不是单纯视觉收敛。Cold 4 必须标成
`invalid-source-boundary`，不能纳入 cold-start 排名。未来 runner 会在模型回合结束后
写 `trace-scope-audit.json` 并确定性拒绝此类结果。

## 8. 关键路径

编排仓（以下均相对于 `runner/`）：

- runner：`scripts/run-livetest.mjs`
- trace analyzer：`scripts/analyze-trace.mjs`
- trace scope gate：`scripts/trace-scope.mjs`
- product audit：`scripts/verify-product.mjs`
- smoke validator：`scripts/validate-smoke.mjs`
- capability/template helper：`scripts/fast-harmony.mjs`
- technical template：`templates/expo-harmony/`
- runtime contract：`docs/runtime-contract.md`
- 场景 prompt：`prompts/learning-goals.md`
- 总报告：`EXPERIMENT-REPORT.md`

Cold experiments：

- `/Users/stefan/Workspaces/fe-project/expo-app/cold-v1-learning-go`
- `/Users/stefan/Workspaces/fe-project/expo-app/cold-v2-learning-go`
- `/Users/stefan/Workspaces/fe-project/expo-app/cold-v3-learning-go`
- `/Users/stefan/Workspaces/fe-project/expo-app/cold-v4-learning-go`（invalid cold-start；恢复成品可运行）

有效评分/trace 汇总：

- `experiments/cold-start-v1/rubric.json`
- `experiments/cold-start-v1/iteration-1-review.json`
- `experiments/cold-start-v1/iteration-2-review.json`
- `experiments/cold-start-v1/iteration-3-review.json`
- `experiments/cold-start-v1/iteration-1-trace.json`
- `experiments/cold-start-v1/iteration-2-trace.json`
- `experiments/cold-start-v1/iteration-3-trace.json`
- `experiments/cold-start-v1/iteration-4-review.json`
- `experiments/cold-start-v1/iteration-4-trace.json`

## 9. 推荐下一步

1. 下一轮先确认 trace-scope gate PASS；任何越界都直接作废，不做成品恢复来冒充实验。
2. 若继续优化，保留 Cold 2 vertical-skeleton-first，但避免 Cold 3/4 的 bottom-up 路径。
3. 更可能有效的通用约束是“第一批写入必须同时完成入口、所有 surface 的最小实现与
   primary mutation；禁止在此之前整文件重写 domain”，而不是加入产品答案清单。
4. 每轮都使用冻结 rubric 做外部评分，并同时报告生成、repair、运行诊断和人工审阅时间。
5. 对 `expo-crypto` 一类聚合入口补运行时 eager-module 兼容测试；仅有导出矩阵不足以
   证明 import 不会加载同包的未实现原生模块。

## 10. 验证命令

修改 workflow contract 后必须运行：

```sh
cd runner
npm test
node --check scripts/run-livetest.mjs
node --check scripts/analyze-trace.mjs
node --check scripts/fast-harmony.mjs
node --check scripts/dependencies.mjs
```

当前自动化 HarmonyOS UI 操作由 runner 内置的 HDC/identity/smoke 流程负责，不读取外部 Skill。历史人工设备操作曾使用独立的 HarmonyOS UI 指南，但它不是运行时合同。

本轮实际使用设备是 `127.0.0.1:5555`；历史还连接过 `127.0.0.1:5557`。多设备时必须先
明确目标，不能默认选择第一个。

## 11. 工作区注意事项

- `runner/` 当前属于 Genius Git repository；runner 相关工作使用仓库约定的 `runner/*` 分支。
- 不要删除旧 warm/cold 工程、trace 或作废实验，它们仍是追溯证据。
- `session-history/*.jsonl` 文件较大，属于原始会话档案。
- 本轮结束时 `127.0.0.1:5555` 打开的是恢复后的 `cold-v4-learning-go`；但进程状态不是
  长期合同，下一位 Agent 仍应先 dump layout 并严格确认 current project。

## 12. 2026-08-10 Loop Engineer 最终状态（覆盖旧工作区说明）

本节记录 2026-08-10 当时的最终状态；当时分支为 `codex/loop-engineer-fast-optimization`。已经完成
四个有效、互相隔离的 cold-start 轮次；失败/作废样本未计入四轮上限。总报告追加在
`EXPERIMENT-REPORT.md`，结构化结果在
`experiments/loop-engineer-20260810/effective-round-{1,2,3,4}.json`。

推荐 Fast 默认值是有效轮次 2 的能力索引方案加上有效轮次 4 的门禁修正：复杂场景用
`k3-256k` low effort，实现失败后同一 session 用 K3 medium 做一次聚合 repair；模型只
能使用白名单内 Read/Write/Edit 和 24.5 KB 的确定性 capability index。不要恢复轮次 3
的 REQUIRED capability Prompt；它提高本场景质量但慢 13.7%，且没有避免缺失 API 调用。

速度记录：基线 788.6s；有效轮次 1 为 710.6s；轮次 2 为 645.9s（最快，比基线快
18.1%）；轮次 3 为 734.4s；轮次 4 为 970.1s。质量分别为 73.1%、82.7%、82.7%、
92.3%、84.6%。所有四个有效轮次的主/repair trace-scope、typecheck、source audit、
export、artifact audit、精确桌面启动均 PASS；按本轮合同没有执行 core-flow QA，因此
不能把代码级 AsyncStorage 审阅表述成每轮运行时重启持久化证明。

本轮结束时 `127.0.0.1:5555` 打开的是
`loop-fast-r14-gate-semantics-20260810`。其桌面截图证明无错误 overlay，但同时暴露
`LinearGradient` 主按钮背景透明、漏卡+逾期目标重复和桌面单列拉伸问题；不要把该产品
当最佳视觉样本。最佳速度/均衡样本仍是 `loop-fast-r12-k3-low-capindex-20260810`，最高
功能质量样本是 `loop-fast-r13-required-capabilities-20260810`。
