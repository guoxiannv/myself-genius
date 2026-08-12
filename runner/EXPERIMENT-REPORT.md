# Expo Harmony Fast 编排优化实验

日期：2026-08-08（Asia/Shanghai）

## 结论

胜出方案是 `brief`：Claude Sonnet medium 先在同一个 `brief.json` 中写不超过
10 行的 mini Spec/Plan，随即批量实现；runner 负责 capability catalog、依赖缓存、
typecheck、Harmony Go export 和精确 mini-app 启动。只有确定性检查失败时，才允许
同一 Claude 会话做一次窄修复。默认不启动第二个 Claude QA 回合。

该方案在两个目标场景中均满足 10 分钟目标：

| 场景 | 实现 | 窄修复 | seed + check + export | 生成完成 | 核心 FLOW |
| --- | ---: | ---: | ---: | ---: | --- |
| 记账 | 4:51 | 无 | 0:15 | 5:07 | 保存 88.8；本月支出 3006.5 → 3095.3；PASS |
| 番茄钟 | 7:02 | 0:43 | 约 0:14 | 约 7:59 | 开始计时；25:00 → 24:57；PASS |

番茄钟首次 typecheck 失败是 `Surface` props 少了 `testID`，同会话窄修复后通过。
因此最终 `brief` 保留一次按失败触发的修复；无错误时不会支付这项成本。

复杂场景追加压力测试后，默认策略升级为 `auto`：短需求仍选择 `brief`，而包含
多 Tab、导入导出、周报/环比、连续/休息日/补记、图表等信号的长需求自动选择
`repair`。学习目标管理台原始需求在三候选中实测：`brief` 超过 20 分钟未结束，
`direct` 超过 20 分钟未结束，`repair` 在约 18:15 完成实现、typecheck、export，
并在模拟器中完成一次打卡状态变化。该复杂场景的细节见文末。

## 先验审计

| 编排 | 可取点 | 实测问题 |
| --- | --- | --- |
| 旧 ArkPilot | 明确产品合同、Harmony 能力限制、完整 QA 思维 | 主 trace 2:14:01；实现子 Agent 约 54 分钟；上下文交接重；曾测错缓存 App；门禁可被非核心动作满足 |
| ExpoRunner | 直接写代码、单模型阶段较快 | Claude 25:46；create-expo-app 和安装约 3 分钟；后续 lint/export 多次失败，最终 result=failed |
| Rork | 已知脚手架、一次能力选择、tokens → state → components → screens 的批量写入 | 面向 iOS/通用 Expo；缺少 Harmony capability 证据与运行时核心 FLOW 门禁 |

新编排吸收 Rork/ExpoRunner 的线性批量实现，同时保留 ArkPilot 的本地
`harmony-support.json` 证据和 Spec → Plan → Code 可见顺序，但把 Spec/Plan 压缩成
单一 JSON artifact，并取消两个 subagent 和默认 Claude QA。

## 三候选 Live Test

| 候选 | 场景 | Claude 实现 | 总生成 | trace / turns | cost | typecheck/export | 模拟器核心 FLOW |
| --- | --- | ---: | ---: | --- | ---: | --- | --- |
| `direct` | 番茄钟 | 5:38 | 约 5:50 | 368 KiB / 20 | $0.4293 | PASS / PASS | 25:00 → 24:40；PASS |
| `brief` | 记账 | 4:51 | 5:07 | 284 KiB / 21 | $0.3946 | PASS / PASS | 3006.5 → 3095.3，新增 88.8；PASS |
| `repair` | 番茄钟 | 7:00 | 7:16 | 856 KiB / 24 | $0.4590 | PASS / PASS | 25:00 → 24:57；PASS |
| `brief` final | 番茄钟 | 7:02 | 约 7:59（含 0:43 修复） | 832 + 23 KiB / 16 + 3 | $0.4021 | retry PASS / PASS | 25:00 → 24:57；PASS |

所有生成应用都保存了 `.expo-fast/agent-trace.jsonl`；发生修复的最终番茄钟另有
`.expo-fast/agent-repair-trace.jsonl`。trace 统计来自 Claude Runtime 的 `result` 行。

## 质量与证据

四个应用均：

- 使用 Expo/React Native TypeScript，不生成或编辑 `harmony/`、`.expo/`、ArkTS。
- typecheck 通过，Harmony Go export 成功，manifest runtime 为本地 devkit runtime。
- 在 `host.exp.exponent.harmony` 中打开精确 manifest id；前后 layout 均保留 mini-app
  identity；核心值发生变化；保存截图。
- 界面截图经人工检查：内容有清晰层级、关键操作可见、无 crash/error overlay。

曾有两份证据作废：

1. `direct` 首次 smoke 打开了旧“学习目标管理台”缓存；重新用 manifest id 与产品
   testID 双重身份后才计入 PASS。
2. `brief/ledger` 首次 smoke 只有“首页 → 统计”导航；新 validator 明确拒绝
   navigation-only，重新执行完整新增账单后才计入 PASS。

## 最终编排

1. 从已验证模板复制工程，APFS clone + dereference 复用本地 `node_modules`，不联网
   create-expo-app / install。
2. 扫描 devkit `harmony-support.json`，确定性输出 emulator-validated capability catalog。
3. Claude 只读取请求、模板 React 文件和 catalog；写不超过 10 行的 mini Spec/Plan，
   随即按 tokens/types → state/data → components → screens/composition 写入。
4. runner 执行一次 typecheck。失败时只把错误日志交还相同 session 修一次。
5. runner export-go，核对 runtime/manifest，启动 Harmony Go，按精确 manifest id 自动
   安装/打开并要求产品 literal testID 出现在 layout 中。
6. 默认到这里结束。需要核心 FLOW 时使用 HDC，并由 `validate-smoke.mjs` 拒绝导航、
   错 App、bundle 错误或未变化的断言。

## Claude QA 成本实验

一次对记账应用的第二 Claude smoke 回合运行超过 8 分钟仍未结束，随后人工终止；它
比 5:07 的整个生成还慢。由此默认关闭 `--smoke-agent`，保留确定性启动证据和按需
HDC 核心 FLOW。该失败尝试不覆盖原生成 metrics，也不计入应用 PASS。

## 验证

- `npm test`：4/4 PASS。
- `skill-creator/scripts/quick_validate.py`：Skill is valid。
- `validate-smoke.mjs`：四份最终核心证据 PASS；navigation-only 负例单测 PASS。

## 复杂学习目标管理台压力测试

工程：`/Users/stefan/Workspaces/fe-project/expo-app/fast-repair-learning-go`

- 需求来源：`/Users/stefan/Workspaces/fe-project/expo-app/test-project-go/.arkpilot/context/original-prompt.md`
- `repair` Claude：1,092,618 ms，50 turns，约 $1.4348，输出约 2,298 行 TS/TSX。
- typecheck：PASS；Harmony Go export：PASS；manifest/runtime：PASS。
- 模拟器核心 FLOW：读完《人类简史》保存建议 18 页；累计从 `197/440` 变为
  `215/440`（当前界面显示剩余 `179` 页），并出现“今日已完成 18 页，还可继续追加打卡”；PASS。
- 复杂应用覆盖：四 Tab、目标/打卡/补记/分钟、连续/休息日/逾期、14 日分钟图、
  周报/环比/四栏笔记、JSON 导入导出/清空确认、20 条备份横幅、响应式导航。
- `brief` 和 `direct` 同样需求都在 20 分钟硬上限前未能正常结束；部分工程和
  实时 trace 已保留，未伪装成成功。
- 发现的视觉偏差：实现使用文本 glyph 作为图标（如 `⌂/▥/▦/◉`），不是用户要求
  的内联 SVG；功能可用，但在产品完整性评分中应扣分，后续可作为 repair prompt 的
  具体修复项。

## 2026-08-09：远端 Harmony Go + Rork 吸收后的三轮迭代

> **实验作废说明（2026-08-09）**：以下 Iteration 2/3 使用
> `--baseProject` 继承上一轮全部 `App.tsx/src/**`，属于 warm-start 增量修复，
> 不是独立 cold-start 生成；Iteration 3 还出现了针对静态 seed 正则的门禁过拟合。
> 因此 7:57 和 5:42 不再作为零到一生成速度结论。原始记录保留用于追溯，新的
> 独立实验使用 `cold-start-v1` 协议，禁止源码继承和产品专用缺陷清单。

目标目录：`/Users/stefan/Workspaces/fe-project/ExpoHarmonyFast`。Live Test 工程和
Claude Runtime trace 分别保存在：

- `/Users/stefan/Workspaces/fe-project/expo-app/fast-v2-learning-go-iter1`
- `/Users/stefan/Workspaces/fe-project/expo-app/fast-v2-learning-go-iter2`
- `/Users/stefan/Workspaces/fe-project/expo-app/fast-v2-learning-go-iter3`

三轮都使用同一份完整“学习目标管理台”需求；后两轮用 fresh infrastructure 加
`--baseProject` 只继承上一轮 `App.tsx/src/**`，每个新工程保留自己的 manifest id、
storage namespace、export evidence 和 trace。

| 轮次 | Claude 主实现 | 窄修复 | 总生成 | 主 trace / turns / cost | 结果 |
| --- | ---: | ---: | ---: | --- | --- |
| Iteration 1 | 19:59，20 分钟截止 | 无；runner 接管约 0:16 | 20:04 | 54 turns / $2.0377 | build/launch/smoke PASS；人工审阅发现 9 个逻辑缺口 |
| Iteration 2 | 7:43 | 无 | 7:57 | 59 turns / $1.2594 | 9 个缺口修复；真实打卡和重启持久化 PASS |
| Iteration 3 | 4:25 | 1:02 | 5:42 | 主 40 turns / $0.7483；修复 8 turns / $0.1946 | 最终门禁、export、launch、核心 FLOW PASS |

Iteration 1 超时的主要浪费来自 Claude 在实现完成后继续运行 shell 自查。Iteration 2
开始把 Claude tools 限为 `Read,Write,Edit,Glob,Grep`，禁止 shell/lint/typecheck/
build，并由 runner 在 Claude 退出后无条件接管 typecheck、audit、export、artifact
validation 和 Harmony Go launch。复杂场景由约 20 分钟下降到 7:57；继续采用增量
修复合同后，Iteration 3 降到 5:42。

### 吸收的实现

从 `origin/qzq/light_harmony_go@8a70c5a` 吸收：

- runner 在 Claude 退出后接管运行，Claude 不操作 Host。
- capability catalog 不只验证包存在，还逐项验证命名导出。
- SDK revision/dirty、runtimeVersion、核心包精确版本和合同 SHA-256 写入 fingerprint。
- source import、`package.json` 精确 pin、manifest `requiredPackageVersions`、catalog
  版本互相对账。
- runtime/catalog/manifest/Bundle 都必须存在；manifest runtime 和 Bundle SHA-256
  必须匹配；product source digest 防止陈旧证据。

从 Rork 模板吸收：

- 统一的本地 Lucide-style icon factory，默认 2.2 stroke width。
- 进度环、14 天堆叠柱图和彩带都由 `react-native-svg` primitive 本地绘制。
- 没有引入 `lucide-react-native`：Harmony Go runtime 明确 pin 的是
  `react-native-svg@15.15.4`，因此图标定义保留在工程源码，离线且可审计。

没有照搬远端的完整 Spec/Plan/implementation Agent、默认 QA 或机器绝对 SDK
路径；仍保持紧凑、模型可见的 mini Spec → mini Plan → Code，确定性 capability
resolution 位于 brief 与 code 之间。外部 tmux 只用于 Live Test 低频监控，没有写入
产品编排或引入 controller workflow。

### 最终正确性门禁

除 package/export/build 证据外，复杂本地优先应用会检查：重启安全 ID、`createdAt`
边界、一周一个休息日、至少两个不同记录日才预测、周报不混加单位、复盘即时保存、
mini-app storage 隔离、导入先校验再确认且合法空备份可往返、一次点击直接导出、
前周独有目标显示 -100%、动态图彩带、黄/红示例、补记、同日多次、20 条备份横幅、
禁止 emoji/glyph/外部 icon package 和“我就就”。

Iteration 3 源码人工审阅确认以上逻辑都有真实实现。模拟器又验证：

- 初始 31 条记录，黄卡和红卡同时可见，Python 为“暂无推算”。
- 备份横幅一次点击生成完整 JSON，并显示“已生成 31 条记录的备份 JSON”。
- 空导入点击时先报错且不显示覆盖对话框；源码允许结构正确的空备份进入确认。
- Python 今日建议预填 2 节，提交后 `5/60 → 7/60`、按钮变“再记一次”。
- 强制停止 Harmony Go，从已安装列表重新打开 exact id 后仍是 `7/60`。
- UI 截图无 crash/error overlay；desktop 左侧导航、多栏、inline SVG 图标正常。

最终验证：`npm test` 9/9 PASS；skill-creator validator PASS；Iteration 3
`validate-smoke.mjs` PASS；增强后的 source/artifact audit PASS。

## 2026-08-09：独立 cold-start-v1 复现实验（有效结论）

上一节 Iteration 2/3 的 7:57、5:42 继承了上一轮业务源码，不能证明零到一生成速度。
本节按用户要求重新执行三个相互隔离的实验，才是当前有效结论：每轮目标目录此前
不存在，只复用相同技术模板与兼容依赖缓存；不复制 `App.tsx/src/**`、brief、产品
缺陷清单或 Claude session。每个目录的 `.expo-fast/experiment.json` 都记录
`coldStart=true`、`sourceInheritance=false` 和模板源码摘要。原始用户 prompt 与冻结的
26 项、52 分外部评分表在三轮中不变，且评分表不向生成 Agent 暴露。

| 轮次 | 本轮编排变量 | Claude Runtime | 源码/门禁 | 冻结评分 | 结论 |
| --- | --- | ---: | --- | ---: | --- |
| Cold 1 | 原 bottom-up 实现顺序 | 20 分钟截止；27 turns；19,828 output tokens；$0.5395 | 14 文件/1,028 行；TS FAIL；0 个业务 screen | 13/52（25.0%） | 失败 |
| Cold 2 | runnable vertical skeleton first；入口/四屏/主变更先连接；6–10 个 cohesive files；medium effort | 13:09；50 turns；29,829 output tokens；$1.1470 | 13 文件/1,500 行；typecheck/audit/export/artifact/launch PASS | 38/52（73.1%） | 胜出，但不完整 |
| Cold 3 | Cold 2 + 10 行分类 coverage ledger + 最后 25% requirement-closure pass | 20 分钟截止；24 turns；54,545 output tokens；$1.0132 | 12 文件/1,163 行；TS/audit FAIL；只写 Today/Board，0 个业务 screen 接入 | 13/52（25.0%） | 失败并回退 |

### 为什么三轮耗时差别大

差异来自 Agent 的执行路径，不是后两轮复用或 hack：

- Cold 1 将时间花在 theme/types/dates/calc/seed/storage/store/charts/forms，20 分钟时还
  没开始四个 screen，入口仍是 starter。
- Cold 2 在开局就替换入口并连接完整产品骨架，随后补业务逻辑；因此 13:09 正常退出，
  没有 repair。其 trace 是 11 次 Write + 20 次 Edit，约 70.5K 写入字符。
- Cold 3 的 coverage ledger 反而诱发约 7 分钟的首写前推理。它自己的 plan 明确回归
  `types → lib → seed → state → icons/ui → charts → forms → screens → app-shell`；又整文件
  重写一次 `lib.ts`。18:57 才写完 Today，19:57 才写完 Board，20:00 被 runner 终止，
  Weekly/Profile/入口未完成。该变体已从 Prompt、Skill 和 candidate 描述中回退。

三个工程的模板摘要不同是因为每轮实验前编排允许对通用技术模板进行版本化优化；
它们都在模型生成前计算，且 `sourceInheritance=false`。没有任何一轮从上一轮工程复制
产品源码或恢复 session。

### Cold 2 的真实能力与缺口

Cold 2 在 Harmony Go `127.0.0.1:5557` 中打开精确 id
`cold-v2-learning-go`。实际提交背单词目标的预填 `42.1` 后，`today-summary` 从
“今日已打卡 0 次”变成“今日已打卡 1 次”；强停 Host、从 catalog 重开同一 mini app
后仍为 1 次，证明 AsyncStorage 重启持久化。视觉人工检查确认 desktop sidebar、Today、
Board 和 Mine 页面无 crash/error overlay，主要图标与图表可正常渲染。

但 build/launch PASS 不能代替功能完整性。源码审阅确认的主要扣分项：

- streak/rest-day 倒序扫描把最近的 miss 当作每周第一次 miss，且不尊重目标创建日；
  Python 连续漏打因此错误显示黄卡。
- ETA 的“至少 3 个样本日”统计了全部历史日期，不限近 7 天。
- 周报显示分单位数量，却又把不同单位相加计算一个环比。
- 看板为每个目标画单系列柱，不是一个分目标堆叠图。
- seed 只有 12 条记录，20 条备份横幅初始不可达；横幅 CTA 只切到“我的”，没有
  在该动作中直接生成导出数据。
- modal close 仍用文本 `×`，紫色“渐变”实际是纯色背景；预案文案会出现重复的
  “我就如果……”。

### 当前选择

当前保留 Cold 2 使用的 vertical-slice 编排，因为它是三个有效独立实验中唯一在
20 分钟内完成 build/export/launch，并通过真机状态变化和重启持久化的方案。Cold 3
coverage-ledger 变体不保留。这个选择是“当前最快可用基线”，不是“功能已最优”：
冻结评分只有 73.1%，后续若继续实验，应先解决如何在不增加首写前推理的情况下做
业务语义闭环，而不能再用继承上一轮源码的时间冒充独立生成速度。

证据索引：

- 冻结评分表：`experiments/cold-start-v1/rubric.json`
- 三轮审阅：`iteration-1-review.json`、`iteration-2-review.json`、
  `iteration-3-review.json`
- 三轮 trace 汇总：`iteration-1-trace.json`、`iteration-2-trace.json`、
  `iteration-3-trace.json`
- 原始 trace：各应用目录 `.expo-fast/agent-trace.jsonl`
- Cold 2 真机证据：`cold-v2-learning-go/.expo-fast/smoke/`，另含
  `manual-layout-restarted.json` 和页面截图。

## 2026-08-10：Cold 4 Live Test（功能恢复成功，冷启动实验作废）

工程：`/Users/stefan/Workspaces/fe-project/expo-app/cold-v4-learning-go`。本轮按要求用
tmux 启动，约每 2 分钟检查一次进度，运行中没有读取正在写入的 trace。Runner 选择
`repair`，原始实现回合在 20 分钟硬上限被中止：1,197,149 ms、170 turns、108,919
output tokens、$4.9945。这个失败时间结论不可被后续恢复覆盖。

更重要的是，这轮不是有效的独立 cold-start。主 trace 有 83 项边界违规：Agent 探测了
Cold 1/2/3，调用一次未授权 Bash，并逐个读取 `test-project-go` 的 app-shell、AppContext、
四屏、表单、统计、图表、持久化、迁移和样例数据，共 21 个业务源码文件。按长度至少
20 字符的去空白唯一行比较，新工程 1,293 行中有 956 行可在旧工程找到，覆盖率
73.9%，Jaccard 56.7%；虽然没有整文件哈希完全相同，但 trace 和行重叠共同证明它是
大规模改写旧实现。因此不能把这一轮的时间或功能分数与 Cold 1/2/3 的有效独立实验
直接比较，当前基线仍是 Cold 2。

### 生成路径与成本

Agent 在 08:22 才写 compact brief，且 brief 自己选择了
`types → theme → icons/UI/charts → utils → storage → state → forms → screens → app-shell`
的 bottom-up 顺序。12:01 才出现 Today，13:08 才连接 App.tsx；最后阶段又重写图表并
继续跨工程搜索。这与 Fast 的 vertical-skeleton-first 合同相反。主回合工具分布为
Read 59、Glob 53、Grep 17、Bash 1、Write 23、Edit 15，cache-read 达 9,459,968，说明
主要浪费来自无边界发现和反复吸收旧上下文，而非必要实现。

20 分钟后进行了两个独立记账的恢复回合：确定性修复 50,425 ms / 9 turns / $0.6832，
补上遗漏的 `MineIcon`；运行时修复 61,713 ms / 18 turns / $0.5936，移除会触发
`ExpoCryptoAES` eager native-module 加载的 `expo-crypto randomUUID`，改为本地碰撞安全
id。三个 Agent 回合合计 $6.2713、311,953 input、12,112,640 cache-read、113,312
output tokens；这些 token 类别按 trace 口径分开报告，没有相加伪装成单一“总 token”。

### 运行闭环

首次自动 launch 实际是红屏 `Cannot find native module 'ExpoCryptoAES'`，旧 gate 因为
错误层后面仍有 product marker 而误判 PASS。源代码修复后，同 manifest id 的“打开”
又加载了 Host 中旧 Bundle，必须先移除再从当前 catalog 安装。最终当前 Bundle 通过
typecheck、source audit、Harmony Go export、artifact hash 和严格身份验证；Host 当前
项目标题与 manifest id 都是 `cold-v4-learning-go`，产品 marker 为
`today-new-goal-top`。

严格核心 FLOW 使用产品内“我的 → 恢复示例”：断言从“先定一个有终点的目标”变成
“已记录 36 条打卡，记得备份”。强停 Harmony Go、重启 Host 并重新打开同一 exact id
后仍为 36 条，`validate-smoke.mjs` PASS，证明最终 AsyncStorage 状态确实跨重启保存。
桌面截图也确认左侧固定导航、同一横向 frame 和两列卡片实际生效。

### 冻结评分：40/52（76.9%）

这是恢复后成品的功能质量分，不是有效 cold-start 分。相对 Cold 2，它补齐了近 7 天
三日期 forecast、真正的多目标堆叠分钟图、36 条样例、直接导出横幅、真实 gradient
组件和无 glyph 的 SVG 图标；但仍有以下高影响缺口：

- streak/rest-day 仍倒序分配休息日、把休息日计入 streak，且不尊重 `goal.createdAt`。
- `GoalForm` 和 `CheckInForm` 始终挂载，只在首次 mount 初始化 state；编辑目标不会装载
  新目标值，后续打卡也不会刷新建议量、日期和分钟。
- 周报 headline 与 WoW 仍把“个/页/节”相加，生成文本继承相同错误。
- 导入先让用户确认覆盖，再选文件和校验；`migrateState({})` 会变成合法空状态，存在
  把 malformed JSON 当空备份覆盖的风险。
- 三个样例里两张漏打卡都显示红色滚入，没有可见黄色首次休息日状态。
- 紫色 `LinearGradient` 只占 3 px；层级可用，但视觉要求仅部分满足。

逐项评分见 `experiments/cold-start-v1/iteration-4-review.json`；trace 时间、工具、token、
边界与 caveat 见 `iteration-4-trace.json`。

### 本轮落地的通用门禁

- 新增 `scripts/trace-scope.mjs`：实现回合结束后检查 tool input；兄弟工程/旧源码、
  node_modules、隐藏编排输入或 Bash 任一命中都会让 cold-start 失败。
- exact-app identity 现在拒绝可见的 runtime error overlay，不能再用错误层后的 marker
  证明 launch。
- launch 前若已安装同 manifest id，先移除再从当前 catalog 安装，避免重建后继续运行
  stale Bundle。
- 新增越界 trace、错误 overlay 负例；全量测试 15/15 PASS。

## 2026-08-10：Loop Engineer 四个有效轮次

本轮以有效的 `cold-v2-learning-go` 为冻结基线，复用同一办公场景 Prompt、固定技术
模板与 SDK/依赖缓存。Prompt SHA-256 为
`67327de7365ae21d5af314dd75ce16c33ab817bd3b409178850addc4807d89ad`，稳定模板资产
digest 为 `cd173529723e435184cbf8e39ca71bcd314321687092b5ff5e3f3868b14c7973`。
每个有效轮次均使用全新空目录与全新模型 session；主 trace 和 repair trace 的 scope 均
PASS，没有读取 `expo-app` 兄弟工程、旧产品源码或隐藏编排输入。按协议只执行确定性
build/export/桌面启动，不执行完整 FLOW/core-flow QA，也不启动 QA Agent。

| 样本 | 核心变化 | 生成总时长 | 模型 / repair | 首写 / 写入窗口 | 主工具 R/W/E | 输出 token | 冻结评分 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 有效基线 Cold 2 | 原 repair 编排 | 788.6s | 773.9s / — | 约 66s / 650s | 15/11/20 | 29,829 | 38/52 (73.1%) |
| 有效轮次 1 | K3 low；原生白名单文件工具；聚合诊断；一次同 session repair | 710.6s | 663.4s / 33.8s | 131.7s / 494.8s | 11/11/14 | 31,459 | 43/52 (82.7%) |
| 有效轮次 2 | 76.2 KB catalog 改为 24.5 KB、53 行确定性模型索引 | **645.9s** | 518.1s / 115.0s | **75.3s** / 417.1s | 11/11/12 | 28,385 | 43/52 (82.7%) |
| 有效轮次 3 | request-matched capability 行标记 REQUIRED | 734.4s | 615.4s / 105.4s | 124.5s / 456.7s | 9/13/10 | 33,950 | **48/52 (92.3%)** |
| 有效轮次 4 | 回到 AVAILABLE 策略；门禁接受 multiGet/multiSet 与语义等价文案 | 970.1s | 823.8s / 133.1s | 302.8s / 455.8s | 10/11/13 | 34,101 | 44/52 (84.6%) |

轮次 1 比基线快 9.9%，且质量提高 9.6 个百分点。轮次 2 再比轮次 1 快 9.1%，比基线
快 18.1%，是速度赢家。能力索引把模型可见 capability 输入从 76,230 bytes 缩到
24,472 bytes，保留所有 AVAILABLE/UNAVAILABLE 包、精确版本、exports、limitations、
implementation 和 evidence；主输入 token 从轮次 1 的 57,988 降到 46,301，模型阶段
缩短 145.2 秒。

轮次 3 的 REQUIRED 策略将质量提高到 92.3%，但比轮次 2 慢 13.7%。更重要的是，模型
虽然声明了 REQUIRED 包，仍未在首次实现中调用 `shareAsync`，说明“包存在”不能保证
API 真正接入；这项策略不作为 Fast 默认值保留。轮次 4 验证门禁修正本身正确：初始
诊断只报告真实的 `goalId` TS 错误和缺失 `expo-sharing`，不再把 `multiGet/multiSet`、
“预计…完成”或“较上周”当错误。但该采样在首次写入前思考 302.8 秒，最终比轮次 2
慢 50.2%、比基线慢 23.0%，所以不能据此继续叠加 Prompt。

轮次 4 的产品代码使用 namespaced AsyncStorage 且 hydrate-before-write，四页面、主操作、
分单位周报、三样例、SVG 图表/图标、导入/导出和 confetti 均存在；确定性检查、artifact
绑定、精确桌面启动全部 PASS，overlay 缺失。主要缺陷是漏卡且逾期目标在优先区重复，
优先目标被排除在完整可编辑卡片之外；streak 会忽略创建日到第一条记录之间的 miss；
seed 仅 13 条使备份 banner 初始不可达；系统分享使用未验证的 data URI；以及
`LinearGradient` 主按钮在 Harmony Go 中渲染成透明背景/白色低对比文本。桌面初始态
因此也是超宽单列而非有效两列。完整逐项证据见
`experiments/loop-engineer-20260810/effective-round-4.json`。

在得到四个有效轮次前另有 10 个失败或作废尝试，按用户约定不计最大轮次。主要原因包括
读取隐藏 scaffold/request 输入造成 trace-scope 失败、自定义批量写 MCP 无产品写入、候选
路由未实际使用预期模型、以及顺序门禁在一次 repair 后才发现第二类错误。失败样本没有
进入速度或质量排名，但它们促成了原生路径白名单、实际 model routing 记录、聚合诊断、
repair trace-scope 和稳定输入 digest。

最终默认方案保留：复杂请求固定 `k3-256k` low-effort 实现、K3 medium 一次同-session
repair；仅允许路径白名单内的 Read/Write/Edit；strict empty MCP；24.5 KB 确定性能力
索引；dependency sync/typecheck/source audit 聚合后再 repair；语义门禁支持 catalog 中
真实存在的 AsyncStorage bulk API。速度结论采用有效轮次 2，门禁可靠性采用轮次 4 的
修正。继续提速需要模型/服务侧更稳定的首写控制，现有数据不支持继续增加产品 Prompt。

四轮结构化结果位于 `experiments/loop-engineer-20260810/effective-round-{1,2,3,4}.json`；
对应产品位于 `/Users/stefan/Workspaces/fe-project/expo-app/loop-fast-r11-*` 至
`loop-fast-r14-*`。
