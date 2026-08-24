# Genius

Genius 仓库用于统一管理 Frontend、Runner 和 SDK 三个部分。

## 目录说明

| 目录 | 用途 |
| --- | --- |
| `frontend/` | Frontend 相关代码、资源和配置。 |
| `runner/` | Runner 执行端相关代码、脚本和配置。初始代码从 [`yuhuailiu/expo-arkpilot`](https://github.com/yuhuailiu/expo-arkpilot) 的 `expo-harmony-fast-round3-reproduction` 分支导入。 |
| `sdk/` | DevKit SDK。该目录是 Git submodule，关联 [`BitFun-Platform/devkit_sdk`](https://github.com/BitFun-Platform/devkit_sdk)，不是直接存放在本仓库中的普通目录。 |

## 获取 SDK

首次克隆本仓库时，推荐同时初始化 submodule：

```bash
git clone --recurse-submodules https://github.com/BitFun-Platform/Genius.git
```

如果已经克隆了仓库，可执行：

```bash
git submodule update --init --recursive
```

以上命令会检出 Genius 当前记录、并已经过配套验证的 SDK commit。普通部署不要执行 `git submodule update --remote sdk`，以免本机 SDK 偏离主仓库固定的版本。

当前 Harmony full-profile 版本由 SDK 的 `tools/harmony/full-profile.json` 固定。升级 `profileId`（例如从 v2 到 v3）会使已有构建池失效；升级后的 SDK 必须先推送到 `BitFun-Platform/devkit_sdk`，再更新本仓库的 submodule 指针，并为新 profile 创建新的 Pool 根目录。

### 维护者升级 SDK

只有在需要主动更新 Genius 的 SDK 指针时，才获取跟踪分支 `dev/SupportOH` 的最新提交：

```bash
git submodule update --remote sdk
```

SDK 更新后，主仓库中的 submodule commit 引用也会发生变化，需要在主仓库中提交并推送：

```bash
git add sdk
git commit -m "Update SDK submodule"
git push
```

## 初始化 Expo HAP 构建池

Expo Runner 在 bundle 导出和确定性校验之后，会通过 SDK 的固定 slot 池构建同时支持 `phone` 和 `2in1` 的 unsigned HAP，并将同一产物用于手机安装和 PC 模拟器预览。机器首次部署或 SDK full-profile 变化后，在仓库根目录执行：

```bash
cp runner/.env.example runner/.env
# 编辑 runner/.env 中的 Node、DevEco 与 Claude 路径
runner/setup-harmony-pool.sh
```

脚本会在需要时通过 Corepack 安装 SDK pool 准备流程所需的最小 workspace 依赖，然后在仓库根目录创建被 Git 忽略的 `harmony-pool/`，初始化四个 slot 并依次预热。可通过 `EXPO_HARMONY_POOL_ROOT` 和 `EXPO_HARMONY_POOL_SIZE` 覆盖路径与数量。预热完成后，每个生成任务由 Runner 提交一个 SDK pool job；SDK 负责排队、租约、缓存、Hvigor 构建和 HAP 产物校验。

默认四个 slot 的初始化磁盘预检门槛约为 `4 × 8 GiB + 20 GiB = 52 GiB`。这是 SDK 用于预留 slot 空间和系统剩余空间的安全门槛，不代表 Pool 最终一定占用 52 GiB。首次完整预热需要依次完成四次原生构建，可能持续几十分钟；后续命中 warm slot 的应用构建会明显更快。

初始化脚本还支持：

```bash
# 只创建 slot，不执行首次预热
runner/setup-harmony-pool.sh --no-warm

# 需要重新验证当前 SDK 时，强制重建已经 warm 的 slot
runner/setup-harmony-pool.sh --force
```

脚本结束前会输出 Pool 状态 JSON。默认配置初始化成功时应满足：

- `size` 为 `4`；
- `queuedJobs` 为空数组；
- `slot-01` 至 `slot-04` 的 `status` 均为 `idle`；
- 四个 slot 的 `warm` 均为 `true`。

如果只是 SDK commit 变化，重新执行脚本即可识别并预热旧 slot；如果 SDK 的 full-profile `profileId` 发生变化，需要为 `EXPO_HARMONY_POOL_ROOT` 配置一个新的空目录，不能复用旧 Pool。

## 本地验证 Expo 到 HAP

以下流程只启动本地 Frontend 和 Python API，不需要 Cloudflare、Profile、HPack 签名材料或 `frontend/deploy/server.env`。开始前请确保 `runner/.env` 已配置 Node.js 22.13+、DevEco Studio 和 Claude CLI，DevEco PC 模拟器已经启动，并且 `tmux` 可用。

在仓库根目录安装 Frontend 依赖：

```bash
python3 -m venv frontend/.venv
frontend/.venv/bin/python3 -m pip install -r frontend/requirements.txt
npm --prefix frontend/web ci
```

这是**起服务**要装的东西。跑 frontend 的测试不需要它们，入口和最小依赖见 [`frontend/README.md`](frontend/README.md) 的「测试」一节。

启动本地服务：

```bash
frontend/scripts/restart_local.sh --tmux
```

浏览器打开 `http://127.0.0.1:8180`，选择 `Expo`，输入“生成一个简单番茄闹钟APP”并提交。任务完成后不会自动占用 PC 模拟器。HAP 可用时，详情页显示“在 PC 模拟器中预览”按钮；用户点击后才进入共享设备池的 FIFO 队列并完成安装、启动和最大化。模拟器预览失败不影响原有安装入口。对应本地产物位于：

```text
expo-app/remote-ui-<run_id>/dist/harmony-go/bundle.js
expo-app/remote-ui-<run_id>/.expo-fast/hap/*.hap
expo-app/remote-ui-<run_id>/.expo-fast/hap/build-result.json
```

停止本地服务：

```bash
frontend/scripts/restart_local.sh --stop
```

> 请先确保新的 SDK commit 已经推送到 `BitFun-Platform/devkit_sdk`，再提交主仓库中的 submodule 引用，避免其他协作者无法检出该版本。

## 分支命名规范

默认分支为 `main`。除 `main` 外，其他分支必须使用以下格式：

```text
frontend/<分支名>
runner/<分支名>
sdk/<分支名>
global/<分支名>
evaluation/<分支名>
```

分支名使用小写英文、数字和连字符，名称应简短并能说明改动目的。例如：

```text
frontend/add-login-page
runner/fix-task-timeout
sdk/update-device-api
global/update-ci-config
evaluation/add-cold-start-rubric
```

其中 `global/` 用于同时影响多个目录或仓库级配置的改动，例如 CI、文档和公共配置；`evaluation/` 用于生成质量的评测与评分口径。

以上五个前缀由 `.github/workflows/validate-pull-request.yml` 强制校验，不匹配的分支名和 PR 标题会被拒绝。

## Issue 命名规范

Issue 标题使用 `[范围] 简短描述` 的格式，范围与目录保持一致：

```text
[frontend] 登录页面在移动端显示异常
[runner] 修复任务执行超时
[sdk] 增加设备状态接口
[global] 更新项目 CI 配置
[evaluation] 补充冷启动评分口径
```

- `[frontend]`：仅涉及 Frontend。
- `[runner]`：仅涉及 Runner。
- `[sdk]`：仅涉及 SDK。
- `[global]`：涉及多个部分或仓库级事项。
- `[evaluation]`：生成质量的评测与评分口径。

一个 Issue 如果涉及多个部分，优先使用 `[global]`，并在正文中列出受影响的目录。Issue 标题同样由 Workflow 校验，模板见 `.github/ISSUE_TEMPLATE/`。
