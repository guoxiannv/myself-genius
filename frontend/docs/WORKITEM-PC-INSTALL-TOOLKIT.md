# Work Item: PC 安装工具包（方案一自动化）

> 关联方案文档：[鸿蒙PC应用安装方案.md](鸿蒙PC应用安装方案.md) · 方案一
>
> 状态：待实现
>
> 优先级：P1

---

## 1. 目标

在现有安装页中新增一条"PC 安装工具包"渠道，与现有 ExpoGo 预览安装共存。用户下载一个 zip 工具包，解压后运行 `install.sh`，输入无线调试端口号即可完成安装。无需手动查找 hdc 路径、手打命令。

### 用户操作流程（目标）

| 步骤 | 操作 | 说明 |
|:---:|------|------|
| 1 | 设置 → 开发者选项 → 开启"无线调试" | 一次性，记下端口号 |
| 2 | 安装页点击"下载安装工具包" | 下载 zip 文件 |
| 3 | 双击解压 zip | 系统自带解压 |
| 4 | 终端运行 `sh install.sh` | 输入端口号，回车，完成 |

---

## 2. 背景

### 现有安装渠道

| 渠道 | 适用设备 | 状态 |
|------|----------|------|
| 手机扫码安装（store:// DeepLink） | HarmonyOS 手机 | 已实现 |
| PC 安装 - ExpoGo 预览 | HarmonyOS PC | 已实现（ExpoInstallMenu.tsx） |
| **PC 安装 - 工具包安装** | HarmonyOS PC | **本次新增** |

### 方案一的核心约束

1. `hdc install` 需要 `internaltesting` 签名的 HAP（现有签名流程已满足）
2. 无线调试端口动态分配，无法自动获取，需用户手动输入
3. 鸿蒙 PC 系统自带 hdc，但普通用户不知道如何使用

### 签名文件现状

`deploy/signing/` 目录已有 11 个 `internaltesting` Release Profile（`.p7b`）+ 证书（`.cer`）+ 密钥库（`.p12`）。当前流水线产出的 release 签名 HAP 可直接用于 `hdc install`，无需额外 debug 签名。

### hdc 二进制现状

- DevEco SDK 中的 hdc 为 macOS arm64 (Mach-O)，不能用于鸿蒙 PC (Linux aarch64)
- 鸿蒙 PC 系统自带 hdc，但路径未确认
- 真实 MateBook 的 hdc 二进制暂未提取

**本次实现策略**：工具包不打包 hdc 二进制，`install.sh` 运行时自动查找系统 hdc。后续拿到 aarch64 hdc 二进制后再补入工具包作为兜底。

---

## 3. 工具包结构

```
GeniusInstallKit-{应用名}-{版本}.zip
├── app.hap              # internaltesting 签名的 HAP（复用现有流水线产出）
├── install.sh           # 一键安装脚本（服务端生成，内嵌 bundleName）
└── README.txt           # 操作说明
```

> `hdc` 二进制暂不打包，后续阶段补入。

---

## 4. 实现任务

### Task 1：hpack_packager.py 新增工具包生成

**文件**：`frontend/scripts/hpack_packager.py`

在 `package_prebuilt_hap` 签名完成后，将 signed HAP + 生成的 install.sh + README.txt 打成 zip，发布到 `static/hpack/<remote_dir>/GeniusInstallKit.zip`。

**install.sh 脚本逻辑**：

```bash
#!/bin/sh
# 1. 自动查找 hdc：PATH → 常见系统路径 → 报错提示
# 2. 提示用户输入无线调试端口号
# 3. hdc tconn 127.0.0.1:<端口>
# 4. hdc install -r app.hap
# 5. 输出成功/失败信息
```

**README.txt 内容**：
- 开启无线调试的步骤指引
- 运行 install.sh 的步骤
- 常见问题排查

**hpack-result.json 新增字段**：
- `toolkit_url`：工具包下载 URL
- `toolkit_path`：工具包本地路径

### Task 2：API 暴露工具包下载信息

**文件**：`frontend/app.py`

在 run 状态 API 的 artifacts 响应中，增加 `toolkit_url` 和 `toolkit_ready` 字段，供前端读取。

### Task 3：前端 UI 新增下载入口

**文件**：`frontend/web/src/components/detail/ExpoInstallMenu.tsx`

在 PC 安装面板（`PcInstallContent`）中，与现有 ExpoGo 方式共存：

```
安装到 PC
├── 方式一：ExpoGo 预览安装（现有）    ← 适合快速预览
└── 方式二：下载工具包安装（新增）    ← 适合正式安装到本机
     └── [下载安装工具包] 按钮 → GeniusInstallKit.zip
```

**文件**：`frontend/web/src/lib/types.ts`

在 `RunArtifacts` 类型中增加 `toolkit_url` 和 `toolkit_ready` 字段。

### Task 4：安装页 HTML 模板增加 PC 工具包入口

**文件**：`frontend/scripts/hpack_packager.py` → `write_prebuilt_install_page`

在生成的 `index.html` 安装页中，除了现有的"安装应用"按钮（手机用），增加一个"PC 安装"区块，展示工具包下载链接和简要操作指引。

---

## 5. 不在本次范围

| 排除项 | 原因 |
|--------|------|
| 打包 hdc 二进制 | 暂未获取到 Linux aarch64 hdc，后续补入 |
| debug 签名 HAP 构建 | 现有 internaltesting release 签名已可用于 hdc install |
| AGC 邀请测试集成（方案二） | 独立 work item |
| 自动获取无线调试端口 | 设备缺少 ss/netstat，技术上不可行 |

---

## 6. 验收标准

1. 构建流水线签名完成后，自动生成 `GeniusInstallKit-{应用名}-{版本}.zip`
2. zip 包含 `app.hap`（internaltesting 签名）、`install.sh`（可执行）、`README.txt`
3. `install.sh` 能自动查找系统 hdc，提示输入端口号，执行安装
4. 安装页 UI 显示"下载安装工具包"按钮，点击下载 zip
5. 工具包 URL 通过 API 返回，前端可正确展示下载状态
6. 与现有 ExpoGo PC 安装方式共存，互不影响

---

## 7. 后续阶段（依赖外部资源）

| 阶段 | 前置条件 | 内容 |
|------|----------|------|
| 补入 hdc 二进制 | 从真实 MateBook 提取 aarch64 hdc | 工具包增加 `hdc` 文件，install.sh 优先用包内 hdc |
| debug 签名支持 | 获取 debug profile (.p7b) | 新增 debug 构建通道，产出 debug 签名 HAP |
