# Expo Harmony Fast Runner

`runner/` 是 Genius 仓库中的 Expo Harmony Go 冷启动生成编排。它从一份产品需求创建全新 Expo 工程，让模型实现产品，随后执行依赖解析、类型检查、源码与产物审计，并通过预装的 Harmony Go 壳启动验证。固定 SDK 池构建 unsigned HAP 仅作为显式启用的兼容能力。

当前运行时不再依赖 `SKILL.md`。生成模型收到的产品约束由 `scripts/run-livetest.mjs` 与 `AGENTS.md` 组成；技术模板、运行合同和能力解析均是 runner 自身资源。

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
       -> scripts/execution-policy.mjs 主/repair 模型与 effort 的统一解析
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
- `execution-policy.mjs` 是 model/effort 解析的唯一入口；`config/execution.json` 只提供主回合与 repair 回合的默认值，命令行参数可逐次覆盖。
- `harmony-go-runtime.mjs` 是壳身份的唯一入口：优先读取 `EXPO_HARMONY_GO_BUNDLE_NAME`，其次读取 `EXPO_HARMONY_GO_HAP` 内嵌 `module.json`，最后使用当前 SDK 默认值 `com.example.myapplication1.ide`。安装、启动、强停、前台检查和 smoke 身份校验共享该结果。
- `templates/expo-harmony/` 是冷启动技术模板；`docs/runtime-contract.md` 是当前 Harmony Go 运行合同。
- `EXPERIMENT-REPORT.md` 与 `HANDOFF.md` 保留历史实验与决策背景；当前使用方式和职责以本 README 为准。

`npm run catalog -- /absolute/path/to/prepared-project` 可为目标工程刷新 catalog 和 SDK fingerprint。正常 Live Test 不需要手动调用它。

## 执行流程

一次完整运行依次完成：

1. 从技术模板准备空工程，生成能力 catalog、SDK fingerprint 和紧凑能力索引。
2. 固定 Harmony Go runtime 核心依赖，并从兼容缓存或 npm 安装基线依赖。
3. 运行主模型回合，只允许在目标工程边界内读写产品文件。
4. 解析并同步模型选择的精确能力依赖，执行 typecheck、trace-scope 和 source audit。
5. 若确定性诊断失败，使用同一会话执行聚合 repair，再完整复验；单次运行最多执行 100 轮 repair，达到上限后保留最后诊断并终止。
6. 通过 SDK Harmony CLI 导出 Bundle/catalog，执行 artifact audit。
7. 将 Bundle 发布到共享 Gateway，由设备池分配预装 Harmony Go 壳并验证当前应用身份与交互证据。
8. 只有显式传入 `--hap true` 时，才在固定 pool 中额外构建每任务 unsigned HAP。

HAP 失败会被记录为独立的 partial failure，不会抹掉此前已经通过的生成、审计或 Harmony Go 证据。

Runner 只有一套执行策略，不再接受 `--candidate`，也不会根据需求长度或关键词自动分流。主回合由 `--model`、`--effort` 控制，repair 回合由 `--repair-model`、`--repair-effort` 控制；未传入时读取 `config/execution.json`。若只传主回合参数，repair 会继承对应的外部覆盖值。`--timeout` 控制主回合，`--repair-timeout` 控制每一轮 repair；模型/进程失败、单轮超时、用户停止或系统限制仍会终止执行。

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

`manifest.json` 单独存在不代表端到端成功；应以 `result.json`、各项 gate 和运行时交互证据共同判断。`result.json.execution` 记录本次实际使用的主/repair 模型、effort 和 `repairLimit: 100`。`result.json.revisions` 记录首轮和每次 follow-up，初始 `generationMs`/`totalMs` 不会被后续操作覆盖；后续耗时写入 revision、`operations`/`resumes` 与 `lastOperationMs`。

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
