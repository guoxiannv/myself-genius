# Genius

Genius 仓库用于统一管理 Web、Runner 和 SDK 三个部分。

## 目录说明

| 目录 | 用途 |
| --- | --- |
| `web/` | Web 前端相关代码、资源和配置。 |
| `runner/` | Runner 执行端相关代码、脚本和配置。 |
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

获取 SDK 跟踪分支 `dev/SupportOH` 的最新提交：

```bash
git submodule update --remote sdk
```

SDK 更新后，主仓库中的 submodule commit 引用也会发生变化，需要在主仓库中提交并推送：

```bash
git add sdk
git commit -m "Update SDK submodule"
git push
```

> 请先确保新的 SDK commit 已经推送到 `BitFun-Platform/devkit_sdk`，再提交主仓库中的 submodule 引用，避免其他协作者无法检出该版本。

## 分支命名规范

默认分支为 `main`。除 `main` 外，其他分支必须使用以下格式：

```text
web/<分支名>
runner/<分支名>
sdk/<分支名>
global/<分支名>
```

分支名使用小写英文、数字和连字符，名称应简短并能说明改动目的。例如：

```text
web/add-login-page
runner/fix-task-timeout
sdk/update-device-api
global/update-ci-config
```

其中 `global/` 用于同时影响多个目录或仓库级配置的改动，例如 CI、文档和公共配置。

## Issue 命名规范

Issue 标题使用 `[范围] 简短描述` 的格式，范围与目录保持一致：

```text
[web] 登录页面在移动端显示异常
[runner] 修复任务执行超时
[sdk] 增加设备状态接口
[global] 更新项目 CI 配置
```

- `[web]`：仅涉及 Web。
- `[runner]`：仅涉及 Runner。
- `[sdk]`：仅涉及 SDK。
- `[global]`：涉及多个部分或仓库级事项。

一个 Issue 如果涉及多个部分，优先使用 `[global]`，并在正文中列出受影响的目录。

## 当前进展

- 已建立 `web/`、`runner/` 和 `sdk/` 三个目录的基础结构。
- 已接入 `BitFun-Platform/devkit_sdk` submodule，并配置跟踪 `dev/SupportOH` 分支。
- 已启用 Issue 模板和标题规范校验 Workflow。
- 已在 `GeniusProjectTrack` 中创建并转换 Issue `#1`：`[global] 更新项目 README 进展说明`，本次 README 更新通过 Pull Request 合并。
