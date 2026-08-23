# Genius 仓库开发约定

本文件约束 Genius 仓库自身的开发。生成的产品工程由 `runner/AGENTS.md` 单独约束，
两者互不适用。

## 配置归属

三份文件，各管一件事。任何一项配置只属于其中一份，不得出现第二处。

| 文件 | 内容 | 是否进版本库 |
| --- | --- | --- |
| `runner/config/execution.json` | 四个角色的模型、effort、上下文窗口、超时 | 是 |
| `runner/.local/llm.env` | 端点与凭据，仅此而已 | 否 |
| `runner/.env` | 本机路径与设备 | 否 |

- **代码里不出现模型名字面量。** 模型字符串原样透传到 `claude --model`，再原样发给
  `ANTHROPIC_BASE_URL` 指向的端点，因此哪些名字有效完全取决于端点，属于配置而非代码。
  结构性规则（例如某角色缺省时继承 main）留在代码里，配置用 `null` 表达。
- **缺字段就报错，不静默兜底。** `execution-policy.mjs` 校验合并后的结果，任一字段缺失
  即抛错。这同时让配置文件的升级失败得明确可见，而不是悄悄改变行为。
- **`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 与 `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING`
  归 `execution.json`。** 它们是模型属性而非凭据，由编排层按角色注入。`claude-isolated`
  会拒绝在 `llm.env` 里声明它们，`start-livetest` 会拒绝它们出现在环境里——因为 `llm.env`
  最后被 source，残留一份就会静默覆盖按角色注入的值且不报任何错。
- 新增任何环境变量时，同步更新 `runner/.env.example`；测试断言两者双向一致。

## 模型回合

- 产品约束经 `--append-system-prompt-file` 注入 system prompt，不依赖 CLAUDE.md 自动
  加载，也不依赖模型自觉去读。三个 spawn 均设 `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`：
  生成工程位于仓库内，否则会继承到每一级祖先目录的 CLAUDE.md。
- `runner/AGENTS.md` 会被逐字复制进每个生成工程，是产品提示词。**不要把协作规范写进去。**
- 除非任务明确要求调整生成行为，否则不要顺带修改模型 prompt。0→1 提示词由
  `tests/orchestrator.test.mjs` 的 SHA-256 断言保护；确需修改时更新哈希并在提交信息里
  说明原因。

## 启动路径

生成的启动路径预算是几毫秒，不得引入网络调用。模型可用性校验只读本地缓存，缓存由
`--refresh-models` 或 `setup-harmony-pool.sh` 带外刷新；缓存缺失时提示并继续，不阻塞运行。

## 分支与提交

分支：`frontend/*`、`runner/*`、`sdk/*`、`global/*`、`evaluation/*`。
Issue 与 PR 标题：`[范围] 简短描述`。一个 Issue 可关联多个 PR。
改动 runner 后运行 `cd runner && npm test`。
改动 frontend 后运行 `frontend/scripts/run_tests.sh`。
