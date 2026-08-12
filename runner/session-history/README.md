# Codex Session History

此目录由 `export-codex-session` Skill 导出。每个任务同时保存：

- `.txt`：格式化、便于阅读的完整 transcript。
- `.jsonl`：Codex 本地 rollout 原始记录，包含工具调用与更完整的执行上下文。

## 当前主任务

- `current-019fe235-a0ae-7402-8431-603d3017c29a.txt`
- `current-019fe235-a0ae-7402-8431-603d3017c29a.jsonl`

该任务包含：远端编排对比、warm-start 三轮质疑、独立 cold-start 协议重构、Cold 1–3
实验、冻结评分、trace 审阅、Cold 3 回退，以及模拟器当前项目身份误判调查。

## 历史参考任务

### 优化 Expo ArkPilot 生成编排 (2)

任务 ID：`019fe05b-99ea-7141-ac3e-68797c7998ba`

- `reference-019fe05b-99ea-7141-ac3e-68797c7998ba.txt`
- `reference-019fe05b-99ea-7141-ac3e-68797c7998ba.jsonl`

包含 ExpoHarmonyFast 最初三候选、番茄钟/记账 Live Test、mini Spec/Plan、runtime
catalog、HDC core-flow gate、模板与 SDK cache 讨论。

### 优化 Expo ArkPilot 生成编排

任务 ID：`019fdd6f-f77e-7f31-94f7-273eb963bcc3`

- `reference-019fdd6f-f77e-7f31-94f7-273eb963bcc3.txt`
- `reference-019fdd6f-f77e-7f31-94f7-273eb963bcc3.jsonl`

包含更早的 ArkPilot 编排分析与迭代背景。

## 说明

这些记录可能包含已经被后续实验推翻的阶段性结论。下一位 Agent 应以 `HANDOFF.md`、
`EXPERIMENT-REPORT.md` 最后的 cold-start 章节和 `experiments/cold-start-v1` 冻结审阅
为当前事实源；原始 session 用于追溯推理、命令、修改和失败样本。

原始 `.txt` / `.jsonl` 仅保存在本机，不进入 Git 仓库；它们可能包含凭据和机器本地
执行上下文。仓库只保留本索引，必要时由有权限的维护者在本机查阅原始档案。
