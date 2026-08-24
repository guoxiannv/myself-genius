# Expo Harmony Fast Runner

`runner/` 是 Genius 仓库中的 Expo Harmony Go 冷启动生成编排。它从一份产品需求创建全新 Expo 工程，让模型实现产品，随后执行依赖解析、类型检查、源码与产物审计，并通过预装的 Harmony Go 壳启动验证。固定 SDK 池构建 unsigned HAP 仅作为显式启用的兼容能力。

当前运行时不再依赖 `SKILL.md`。生成模型收到的产品约束由 `scripts/run-livetest.mjs` 与 `CONTRACT.md` 组成；技术模板、运行合同和能力解析均是 runner 自身资源。

## 快速开始

要求 Node.js 22.13 或更高版本、可用的 Claude Code 命令，以及同仓的 Expo Harmony SDK。启动预览时还需配置 DevEco Studio 和已安装 Harmony Go 壳的设备；只有显式启用每任务 HAP 时才需要 HAP 构建池。

```sh
cd runner
cp .env.example .env
npm test
./start-livetest.sh --prompt "帮我做一个离线应用……"
```

`.env` 只保存本机路径。相对路径统一以 `runner/` 为基准，主要配置包括生成工程根目录、Node、SDK、可选 `node_modules` 缓存、DevEco Studio、Claude Code 和预览设备池。完整参数可运行：

```sh
./start-livetest.sh --help
```

常用调用方式：

```sh
./start-livetest.sh --name my-app
./start-livetest.sh --refresh-models                                  # 刷新事实表，换端点或换模型后跑一次
./start-livetest.sh --prompt-file ./prompts/ledger.md --model k3-256k --effort low
./start-livetest.sh --project /absolute/path/my-app --foreground
./start-livetest.sh --prompt "……" --no-launch --no-hap
./start-livetest.sh --project /absolute/path/my-app --prompt-file /absolute/path/original.md --follow-up-file /absolute/path/change.md
./start-livetest.sh --project /absolute/path/my-app --prompt-file /absolute/path/original.md --rebuild --no-launch
./start-livetest.sh --project /absolute/path/my-app --prompt-file /absolute/path/original.md --preview-only
```

目标目录必须为空或尚不存在。默认使用 tmux，并将会话输出保存到 `runner/.expo-fast/session-logs/`；`--foreground` 可直接在当前终端运行。

## 当前架构

```text
start-livetest.sh
  -> scripts/start-livetest.mjs       参数、环境、目标目录与 tmux
  -> scripts/run-livetest.mjs         唯一的端到端状态机与模型回合
       -> scripts/execution-policy.mjs 四个角色的模型、effort、策略与超时的统一解析
       -> scripts/model-facts.mjs      端点与 harness 的实测事实（只读，不出网）
       -> scripts/preflight-models.mjs 启动前把配置和事实对上
       -> scripts/app-icon.mjs        Brief 后独立生成并安装分层应用图标
       -> scripts/verification.mjs     check/build 的唯一确定性验证服务
       -> scripts/agent-tools-server.mjs 仅向续跑/修复 Agent 暴露受控 check/build
       -> scripts/fast-harmony.mjs     模板准备、能力 catalog 与能力解析
       -> scripts/dependencies.mjs     依赖 seed、sync 与 Harmony Go export
       -> scripts/trace-scope.mjs      模型读取/写入边界审计
       -> scripts/verify-product.mjs   产品源码与构建产物审计
       -> scripts/validate-smoke.mjs   运行时身份与交互证据验证
       -> scripts/harmony-go-runtime.mjs 壳 HAP 路径与 bundleName 的唯一解析入口
       -> scripts/hap-build.mjs        固定 SDK pool 中的 HAP 构建
follow-up-control.sh
  -> scripts/follow-up-control.mjs     Expo follow-up FIFO、状态、恢复与中断
```

职责边界：

- `fast-harmony.mjs` 只负责 `catalog`、`prepare`、`resolve-capabilities`，不安装依赖、不导出产物。
- `dependencies.mjs` 是依赖生命周期的唯一入口，负责 SDK runtime pin、缓存校验与补齐、能力依赖同步、SDK Harmony CLI overlay 和 `export-go`。
- `run-livetest.mjs` 负责调用顺序、状态、模型与 repair 回合、门禁、启动验证和最终结果，不复制底层实现。
- `verification.mjs` 是依赖同步、typecheck、source audit、export 和 artifact audit 的唯一组合入口；外层最终门禁和 Agent 受控工具调用同一实现。
- `agent-tools-server.mjs` 只提供绑定当前工程的 `check`、`build`，不接受路径或 shell 命令。初始 0→1 回合不会连接这两个工具。
- `follow-up-control.mjs` 持久化 FIFO 与用户操作，通过原 Claude session 启动增量回合；用户正文经文件/标准输入传递，不进入 argv。worker 在 Agent 与最终确定性 gate 完成后立即释放队列，不等待设备租约。
- `execution-policy.mjs` 是四个角色（main / repair / design / appIcon）解析的唯一入口；`config/execution.json` 提供模型、effort、策略与超时，命令行参数可逐次覆盖。
- `model-facts.mjs` 只读 `.local/models-cache.json`——探针实测出来的事实表。**上下文窗口从这里取，不写在配置里**，所以角色换了模型，窗口自动跟着换。它不 import 仓库里的任何东西，这正是 `execution-policy` 和 `preflight-models` 能读同一份事实而互不依赖的原因。
- `app-icon.mjs` 在 `brief.json` 可用后启动独立、无工具、无会话持久化的模型进程，使用产品/主流程/验收语义生成分层 SVG 并转为 1024×1024 PNG；任何失败都保留模板默认图标，不阻断产品生成。
- `harmony-go-runtime.mjs` 是壳身份的唯一入口：优先读取 `EXPO_HARMONY_GO_BUNDLE_NAME`，其次读取 `EXPO_HARMONY_GO_HAP` 内嵌 `module.json`，最后使用当前 SDK 默认值 `com.example.myapplication1.ide`。安装、启动、强停、前台检查和 smoke 身份校验共享该结果。
- `templates/expo-harmony/` 是冷启动技术模板；`docs/runtime-contract.md` 是当前 Harmony Go 运行合同。
- `EXPERIMENT-REPORT.md` 与 `HANDOFF.md` 保留历史实验与决策背景；当前使用方式和职责以本 README 为准。

`npm run catalog -- /absolute/path/to/prepared-project` 可为目标工程刷新 catalog 和 SDK fingerprint。正常 Live Test 不需要手动调用它。

## 执行流程

一次完整运行依次完成：

1. 收到 prompt 后立即启动独立的 low-effort HTML 设计回合（默认 45 秒、硬上限 55 秒），同时准备技术模板、能力索引和依赖；失败或超时自动降级。
2. 将合格设计稿保存为 `.expo-fast/design.html`，主实现读取它并转译为原生布局与本地 Lucide 路径图标。
3. 运行主模型回合，只允许在目标工程边界内读写产品文件；`brief.json` 出现后，另一个独立模型进程并行生成应用图标。
4. 解析并同步模型选择的精确能力依赖，执行 typecheck、trace-scope 和 source audit。
5. 若确定性诊断失败，使用同一会话执行聚合 repair，再完整复验；轮数上限由 `config/execution.json` 的 `repair.limit` 决定，达到上限后保留最后诊断并终止。
6. 通过 SDK Harmony CLI 导出 Bundle/catalog，执行 artifact audit。
7. 将 Bundle 发布到共享 Gateway，由设备池分配预装 Harmony Go 壳并验证当前应用身份与交互证据。
8. 只有显式传入 `--hap true` 时，才在固定 pool 中额外构建每任务 unsigned HAP。

HAP 失败会被记录为独立的 partial failure，不会抹掉此前已经通过的生成、审计或 Harmony Go 证据。

Runner 只有一套执行策略，不再接受 `--candidate`，也不会根据需求长度或关键词自动分流。主回合由 `--model`、`--effort` 控制，repair 回合由 `--repair-model`、`--repair-effort` 控制；未传入时读取 `config/execution.json`。若只传主回合参数，repair 会继承对应的外部覆盖值。`--timeout` 控制主回合，`--repair-timeout` 控制每一轮 repair；模型/进程失败、单轮超时、用户停止或系统限制仍会终止执行。

**`--model` 只需要给模型名，窗口会自己跟上。** 上下文窗口是模型的属性，从事实表按解析后的模型取，所以覆盖模型不会留下上一个模型的窗口。代价是：**换到一个探针没测过的模型时，不设窗口**——Claude Code 会自己说它按假定的 200k 压缩，启动前也会点名是哪个角色。跑一次 `--refresh-models` 就能补上。

## 事实表与探针

配置写「我们要什么」，事实表记「端点和 Claude Code 实际是什么」，启动前把两者对上。事实表是 `.local/models-cache.json`，不进版本库，由带外探针刷新；**运行路径只读它，不联网**。

探针分两级，因为成本差几个数量级：

```sh
./start-livetest.sh --refresh-models        # 便宜：模型列表、上下文窗口、thinking 能否关
node scripts/probe-turn-timing.mjs   --model <name> --samples 5   # 贵：真实 design 回合
node scripts/probe-effort-scale.mjs  --model <name>               # 贵：每个模型 12 个回合
node scripts/probe-hardcoded-knobs.mjs                            # 免费：全程 loopback，不出网
```

`--refresh-models` 必须一直便宜——`setup-harmony-pool.sh` 每次建池都会调它。**两个贵探针都不设默认模型**：要花钱的测量必须由人点名。它们不会覆盖彼此的结果，便宜的刷新也不会抹掉贵探针测出来的行。

判据只认**可观测的差异**：带与不带，有没有区别。**能在请求侧观测就别只看输出**——输出是随机的，回包 `usage` 里的计数不是。「请求没报错」不算，「请求体里有这个字段」也不算，「厂商文档这么说」也不算：文档描述的是厂商自家端点，`ANTHROPIC_BASE_URL` 指向的是中转。测不出差异的项记成 `unverifiable`，不记成有效——细则见仓库根 `AGENTS.md` 的「配置的对错」。

事实表缺失时**提示并继续**，不阻塞运行：把「忘了刷新」变成启动失败，是拿一个常见的假错误换一个罕见的真错误。

## 生成后的增量修改

首轮完成后可以继续使用同一个 Agent session：

- `--follow-up-file` 执行一次用户修改。Agent 可主动调用绑定当前工程的 `expo_fast.check` 和 `expo_fast.build`；结束后外层仍完整复验。Remote UI 的状态轮询随后发布最新 Bundle，设备租约不阻塞 FIFO。
- `--rebuild` 不调用模型，只重新验证、导出，并按参数决定是否重建 HAP 或启动预览；与 `--hap true` 组合时会强制 SDK pool 产出新 HAP，不复用旧的 ready 结果。
- `--preview-only` 不调用模型也不重复确定性构建，只重新发布已有导出并启动预览。旧 `--resume` 仅作为 `--rebuild` 的兼容别名。
- `follow-up-control.sh` 提供 `status|enqueue|update|remove|interrupt`。Remote UI 通过它管理 FIFO；每轮 trace 保存在 `.expo-fast/revisions/NNN-follow-up/`。

为了保护 0→1 基线，首轮的产品 prompt、空 MCP 配置以及 `Read/Write/Edit` 工具集合保持原样。受控自检只在 follow-up 和 repair 回合启用。follow-up 默认更新 Bundle，不等待设备，也不把 HAP/签名放入交互关键路径；Remote UI 轮询完成状态后发布 Bundle，用户请求手机安装包时再显式重建最新 HAP。

## 运行证据

每个生成工程的 `.expo-fast/` 是单次运行的权威证据目录，核心文件包括：

```text
.expo-fast/
  state.json                         外部可观测状态
  request.md
  experiment.json
  capability-catalog.json
  model-capability-index.txt
  sdk-fingerprint.json
  scaffold-package.json
  capability-selection.json
  module-cache.json
  brief.json
  design.html
  design-trace.jsonl
  app-icon/
    result.json
    background.svg
    foreground.svg
    icon.svg
  agent-trace.jsonl
  agent-repair-trace*.jsonl
  trace-scope-audit*.json
  typecheck.log
  source-audit.json
  build-evidence.json
  runtime.json
  manifest.json
  smoke/
  hap/
  result.json
  revisions/
    001-follow-up/
      agent-trace.jsonl
      agent-repair-trace*.jsonl
      trace-scope-audit*.json
```

`manifest.json` 单独存在不代表端到端成功；应以 `result.json`、各项 gate 和运行时交互证据共同判断。`result.json.execution` 记录本次实际使用的主/repair 模型、effort 和生效的 `repairLimit`。`result.json.revisions` 记录首轮和每次 follow-up，初始 `generationMs`/`totalMs` 不会被后续操作覆盖；后续耗时写入 revision、`operations`/`resumes` 与 `lastOperationMs`。

生成成功后，Expo 工程中的源资产位于 `assets/app-icon/`：`app.json#expo.icon` 指向合成 PNG，`app.json#expo.harmony.icon` 声明前景和背景层。HAP prebuild 时由 SDK 将分层资源写入 AppScope 与 entry module，并同步更新应用图标和主 EntryAbility 图标；Runner 不携带原生 config plugin，启动窗口图标仍由 splash 独立控制，固定 SDK pool 也不保存产品图标源码。首次 Harmony Go export 会在主实现完成后汇合并行图标任务，SDK 将图标作为带 URL、大小和 SHA-256 的 manifest asset 与 `bundle.js` 一起发布；Harmony Go 的远端 catalog 和离线已安装列表都会显示图标。图标任务状态与耗时记录在 `.expo-fast/app-icon/result.json` 和最终 metrics 中。可通过 `.env` 中的 `EXPO_FAST_APP_ICON_*` 参数单独关闭、换模型或调整超时。

## 开发与验证

```sh
cd runner
npm test
node --check scripts/run-livetest.mjs
node --check scripts/fast-harmony.mjs
node --check scripts/dependencies.mjs
node --check scripts/follow-up-control.mjs
node --check scripts/agent-tools-server.mjs
```

重构 runner 时需保持三项不变量：冷启动工程不继承产品源码；能力和依赖版本必须由当前 SDK 合同精确决定；除非任务明确要求调整生成行为，否则不要顺带修改模型 prompt。
