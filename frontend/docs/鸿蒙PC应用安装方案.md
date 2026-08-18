# 鸿蒙 PC 应用远程安装方案

> 目标：非开发者用户在不插 USB 线的情况下，将已签名的 HAP 安装到鸿蒙 PC（消费级 MateBook）上。

---

## 背景

### 当前环境

| 项目 | 详情 |
|------|------|
| 设备 | 鸿蒙 MateBook（消费级，非擎云商用） |
| CPU 架构 | aarch64（ARM64） |
| Shell | `/bin/sh` |
| hdc 环境 | 设备上已自带 hdc（aarch64 原生，系统内置） |
| 可用网络工具 | 无 `ip`、`ss`、`netstat`、`bm` 命令 |
| 签名体系 | 已有 `internaltesting` Profile + `.cer` + `.p12` 签名流程 |

### 核心限制

1. **鸿蒙 PC 不支持 `store://enterprise/manifest` DeepLink**——这是手机端扫码安装的底层协议，PC 端无此能力
2. **消费级 MateBook 不支持双击 .hap 安装**——该功能仅限擎云商用系列 + 鸿蒙专业版/企业版
3. **无线调试端口是动态分配的**，无法通过脚本自动获取（缺少 `ss`/`netstat`），需要用户手动看一眼
4. **hdc list targets 不显示本机**——hdc daemon 不会把自己注册为可发现的目标，需要通过 `hdc tconn` 主动连接

---

## 方案一：鸿蒙 PC 本机终端 + 无线调试 + hdc 自连安装

### 原理

```
┌──────────────────────────────────────────────┐
│              鸿蒙 PC（同一台设备）              │
│                                              │
│  ① 设置 → 开发者选项 → 开启"无线调试"           │
│     → 系统启动 hdc daemon，监听动态端口 <PORT>  │
│     → 页面显示 IP:PORT（如 192.168.1.100:36521）│
│                                              │
│  ② 浏览器下载 HAP 到本地（如 ~/Downloads/）     │
│                                              │
│  ③ 打开终端，执行两行命令：                      │
│     $ hdc tconn 127.0.0.1:<PORT>              │
│     $ hdc install ~/Downloads/xxx.hap         │
│                                              │
│  ④ hdc client → hdc server → tcp/127.0.0.1   │
│     → hdc daemon → 安装完成                    │
└──────────────────────────────────────────────┘
```

**关键点：** 鸿蒙 PC 系统自带 aarch64 原生 hdc 二进制。开启无线调试后，系统内的 hdc daemon 开始监听一个动态端口。在同一个终端里用 `hdc tconn 127.0.0.1:<PORT>` 让 hdc client/server 通过本地回环连接到自己的 daemon，然后 `hdc install` 即可安装。全程不依赖任何外部设备。

### 用户操作流程

| 步骤 | 操作 | 耗时 | 频率 |
|------|------|:---:|:---:|
| 1 | 鸿蒙 PC：设置 → 系统 → 开发者选项 → 开启"无线调试" | 30秒 | 一次性 |
| 2 | 记下屏幕上显示的**端口号**（如 `192.168.1.100:36521`，只需要冒号后面的 `36521`） | 5秒 | 每次安装 |
| 3 | 浏览器下载 HAP 文件到本地 | 10秒 | 每次安装 |
| 4 | 打开终端，执行两行命令 | 15秒 | 每次安装 |

终端命令：

```bash
# 通过本地回环连接自己的无线调试端口
hdc tconn 127.0.0.1:36521

# 安装 HAP（根据实际下载路径调整）
hdc install -r ~/Downloads/你的应用.hap
```

看到 `Connect OK` 和 `AppMod finish` 即表示安装成功。

### 可选：一键安装命令

如果觉得每次手打麻烦，可以封装成一个 shell 脚本。用户在终端执行：

```bash
# 一行命令安装（需替换端口号和 HAP 路径）
hdc tconn 127.0.0.1:36521 && hdc install -r ~/Downloads/你的应用.hap
```

甚至可以做成一个脚本，让用户只输入端口号：

```bash
#!/bin/sh
# install.sh - 鸿蒙 PC 本机一键安装
# 用法: sh install.sh <端口号>

PORT=$1
HAP_FILE="$HOME/Downloads/你的应用.hap"

if [ -z "$PORT" ]; then
    echo "用法: sh install.sh <端口号>"
    echo ""
    echo "获取端口号："
    echo "  设置 → 系统 → 开发者选项 → 无线调试"
    echo "  屏幕上显示 IP:端口（如 192.168.1.100:36521）"
    echo "  端口号就是冒号后面的数字"
    echo ""
    exit 1
fi

echo "正在连接 127.0.0.1:$PORT ..."
hdc tconn "127.0.0.1:$PORT" || {
    echo "连接失败！请检查端口号是否正确，无线调试是否已开启"
    exit 1
}

echo "连接成功！正在安装..."
hdc install -r "$HAP_FILE" && echo "安装完成！" || echo "安装失败，请检查 HAP 签名"
```

### 签名要求

- **必须使用 debug 签名**，`hdc install` 不支持 release 签名的 HAP
- 如果设备上已安装过 release 签名版本的同名应用，需先卸载再安装 debug 版本
- 卸载命令：`hdc uninstall <bundleName>`

### 优缺点

| 优点 | 缺点 |
|------|------|
| 全程在鸿蒙 PC 上完成，不依赖任何外部设备 | 需要开启开发者模式 |
| 无用户数限制 | 用户需手动输入端口号（目前无法自动获取） |
| 无有效期限制 | 需打开终端执行命令 |
| 不依赖华为 AGC 平台 | 必须使用 debug 签名 |
| 操作简单，只需两行命令 | — |

---

## 方案二：AGC AppTest 邀请测试分发

> **注意：** AGC 界面在 2025-2026 年经历了重大改版。"内部测试"已更名为 **AppTest 邀请测试**，导航路径也完全变化。下文均使用最新版界面路径。

### 原理

```
┌──────────────┐     ┌─────────────────┐     ┌──────────────┐
│  开发者       │     │  AppGallery     │     │  用户         │
│              │     │  Connect        │     │              │
│  上传已签名   │ ──► │  创建邀请测试版本  │     │              │
│  的 HAP      │     │  生成分享链接     │ ──► │  浏览器打开链接 │
│              │     │                 │     │  跳转AppTest   │
│              │     │                 │     │  点击安装      │
│              │     │                 │     │  完成          │
└──────────────┘     └─────────────────┘     └──────────────┘
```

利用华为 AppGallery Connect 的 **AppTest 邀请测试**通道，将已签名的 HAP 上传到 AGC 后台，生成分享链接。用户点击链接后，系统唤起 AppTest 客户端完成安装 [1]。

### 用户操作流程

| 步骤 | 操作 | 耗时 |
|------|------|:---:|
| 1 | 浏览器打开开发者分享的安装链接 | 2秒 |
| 2 | 页面跳转，点击"开始测试"（首次需同意加入测试群组） | 2秒 |
| 3 | 进入测试应用详情页，点击"安装" | 2秒 |
| 4 | 等待下载安装完成，桌面出现图标 | 自动 |

**全程无需开发者模式、不需要 hdc、不需要打开终端。** 用户需要安装 AppTest 客户端（首次会自动引导安装）。

### 开发者操作流程（最新 AGC 界面）

#### 第一步：创建测试群组

1. 登录 [AppGallery Connect](https://developer.huawei.com/consumer/cn/service/josp/agc/index.html)
2. 选择 **"APP与元服务"**（不是"我的项目"）
3. 在应用列表的 **"HarmonyOS"** 页签，点击应用名称 → 进入 **"分发"** 页面
4. 左侧导航栏选择 **"应用测试/元服务测试" → "测试用户"**
5. 选择 **"外部测试用户群组"**（或"内部测试用户群组"），点击 **"创建测试群组"**
6. 填写群组名称，点击"创建"
7. 在群组管理页面点击"添加测试用户"，输入华为账号（邮箱格式）

#### 第二步：创建测试版本

1. 左侧导航栏选择 **"应用测试/元服务测试" → "测试版本"**
2. 点击右上角 **"创建测试版本"**
3. 上传已签名的 HAP（使用 `internaltesting` Profile 签名）
4. 填写版本信息：
   - 测试类型：选择 **"邀请测试"**（或"公开测试"）
   - 测试描述：版本更新说明
   - 测试时间：设置开始/结束时间
   - 测试用户：勾选第一步创建的测试群组
5. 点击 **"提交审核"**
6. 审核通过后，系统自动生成 **分享链接**
7. 将分享链接发送给用户

#### 分享链接的几种形式

| 方式 | 说明 | 适用场景 |
|------|------|---------|
| **公开链接**（推荐） | 无需拼接邀请码，用户点击即可加入测试群组 | 内部团队分发 |
| 分享链接 + 邀请码 | 需拼接 `&invitationCode=xxx`，控制邀请范围 | 需要限制用户数的场景 |
| 邮件邀请 | 系统自动发邮件给测试群组中的用户 | 正式测试流程 |

**推荐使用公开链接方式**：创建测试群组时生成公开链接，测试版本发布后用户直接点击链接即可参与测试，无需任何额外操作 [2]。

### 完整导航路径速查

```
AppGallery Connect 首页
  └─ 选择 "APP与元服务"（不是"我的项目"）
      └─ "HarmonyOS" 页签 → 点击应用名称
          └─ 进入 "分发" 页面
              └─ 左侧导航栏 "应用测试/元服务测试"
                  ├─ 测试版本    → 创建/管理测试版本
                  ├─ 测试用户    → 创建/管理测试群组
                  └─ 测试反馈    → 查看用户反馈
```

### 签名要求

- **必须使用 `internaltesting` Profile**（即 `app-distribution-type` 为 `internaltesting`）
- 与手机端扫码安装使用的是同一套签名证书（`.cer` + `.p7b` + `.p12`）
- 当前 HPack 签名流程（`hpack_packager.py`）产出的签名 HAP 可直接上传

#### APP 包签名与错误码 991

上传 `.app` 时，必须对 DevEco/Hvigor 生成的原始 `*-unsigned.app` **整体直接签名**：

```bash
cd /Users/huaweiide/Desktop/fe/code/harmony-hap-signer
python3 signer.py /path/to/application-unsigned.app
```

签名工具会读取外层 `pack.info` 选择匹配的 `internaltesting` Profile，直接调用 `hap-sign-tool sign-app`，然后调用官方 `verify-app` 验证签名块和摘要。只有验证通过的文件才会保留在 `output/`。

不要使用以下流程：

```text
拆开 unsigned.app → 单独签名/改名 HAP → 使用 ZIP 或打包工具重新组装 APP
```

HAP/APP 的签名块位于 ZIP 中央目录之前，签名后再次打包会移除或破坏签名块；手工组装还容易丢失 `pac.json`，或造成 `pack.info` 声明的 `entry-default.hap` 与实际文件名不一致。AGC 会把这种包判定为 **991：非法软件包**。

上传前可执行最终验证：

```bash
/Applications/DevEco-Studio.app/Contents/jbr/Contents/Home/bin/java \
  -jar /Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/lib/hap-sign-tool.jar \
  verify-app \
  -inFile /path/to/application-signed.app \
  -outCertChain /tmp/app-cert.cer \
  -outProfile /tmp/app-profile.p7b
```

必须同时看到：

- `Find Hap Signing Block success`
- `Digest verify result: true`
- `verify-app success`
- 进程退出码为 `0`

### 自动化：通过 AGC REST API 实现构建 → 上传 → 分发全流水线

**可以完全自动化，不需要手动登录 AGC 后台操作。** 华为 AppGallery Connect 提供了完整的 REST API 体系，支持通过 API 完成从上传软件包到提交测试版本审核的全流程。配套的 Python 实现脚本见 `agc_auto_publish.py`。

#### 一次性前置准备

**步骤 1：创建 Service Account（推荐方式）**

1. 登录 AGC → "用户与访问" → "API密钥" → "Connect API" → "Service Account" 页签 → "创建"
2. 填写名称，选择"项目级"，选择项目和角色（建议"APP管理员"）
3. 创建成功后自动下载 `*private.json` 凭据文件，保存到 `~/.agc/service_account.json`

该凭据文件包含：
```json
{
  "project_id": "*****",
  "key_id": "*****",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "sub_account": "*****",
  "token_uri": "https://oauth-login.cloud.huawei.com/oauth2/v3/token"
}
```

**步骤 2：获取 appId**

在 AGC → "APP与元服务" → 点击应用名称 → 左侧导航栏"应用信息" → 复制"APP ID"。

**步骤 3：创建测试群组并获取 groupId**

在 AGC → "应用测试/元服务测试" → "测试用户" → "外部测试用户群组" → 创建群组。进入群组管理页面，URL 中的 `groupId=xxx` 即为群组 ID。

**步骤 4：安装依赖**

```bash
pip install requests cryptography --break-system-packages
```

#### 全自动流水线（7 步）

```
已签名的 HAP/APP
    │
    ▼
① 清理残留版本（可选，避免审核上限）
    │
    ▼
② 获取 OBS 上传地址
   GET /api/publish/v2/upload-url/for-obs?appId={appId}
   返回: uploadUrl + objectId
    │
    ▼
③ 上传软件包到 OBS
   PUT {uploadUrl}（直接 PUT 二进制文件）
    │
    ▼
④ 创建测试版本
   POST /api/publish/v2/test/app/version
   Body: { releaseType: 6, testType: 3, testDesc: "..." }
   返回: versionId
    │
    ▼
⑤ 等待软件包异步解析完成（轮询，最多 10 分钟）
    │
    ▼
⑥ 绑定软件包到测试版本
   POST /api/publish/v2/test/version/pkg
   Body: { file: { fileName, objectId }, versionId }
   返回: pkgVersion
    │
    ▼
⑦ 更新测试版本（绑定群组）+ 提交审核
   PUT /api/publish/v2/test/app/version + POST .../submit
    │
    ▼
   审核通过 → 公开链接生效 → 用户点击安装
```

#### 使用方法

```bash
# 基本用法：只需 appId 和 HAP 文件
python3 agc_auto_publish.py --app-id 10****47 --hap ./app-signed.hap

# 指定群组和描述
python3 agc_auto_publish.py \
    --app-id 10****47 \
    --hap ./app-signed.hap \
    --group-id 761e********08 \
    --desc "v1.2.0 修复登录问题"

# 通过群组名自动查找（需先在 AGC 创建同名群组）
python3 agc_auto_publish.py \
    --app-id 10****47 \
    --hap ./app-signed.hap \
    --group-name "外部测试群"

# 跳过残留版本清理
python3 agc_auto_publish.py --app-id 10****47 --hap ./app-signed.hap --skip-cleanup

# JSON 格式输出（适合 CI/CD 集成）
python3 agc_auto_publish.py --app-id 10****47 --hap ./app-signed.hap --json
```

#### 鉴权方式

| 方式 | 说明 | 适用场景 |
|------|------|---------|
| **Service Account** | 使用 JWT 令牌（PS256 签名） | CI/CD 流水线，无人值守，推荐 |
| API Client | 使用 client_id + client_secret 换 access_token | 备用方案 |

脚本优先使用 Service Account，失败后自动 fallback 到 API Client。

#### 与现有 HPack 流程的集成

在 HPack 的 `PackFile.py` 回调中调用：

```python
import subprocess

def didPack(packInfo):
    """打包完成后自动上传到 AGC 邀请测试"""
    subprocess.run([
        "python3", "agc_auto_publish.py",
        "--app-id", "10****47",
        "--hap", packInfo["build_dir"] + "/app-signed.hap",
        "--desc", packInfo.get("desc", "Auto build"),
        "--group-id", "761e********08",
        "--json",
    ], check=True)
```

#### 重要注意事项

| 问题 | 说明 | 解决方案 |
|------|------|---------|
| **审核中上限** | 同时最多 2 个版本审核中 | 脚本自动清理 state=0 的残留版本 |
| **异步解析** | 上传后需等待服务端解析软件包 | 脚本自动轮询等待，最多 10 分钟 |
| **版本号递增** | 每次 VersionCode 必须大于之前版本 | 确保构建时版本号自增 |
| **内部群组免审** | 内部群组提交后几分钟自动通过 | 团队成员场景建议使用内部群组 |

### 与现有 HPack 流程的集成

当前 HPack 产出的安装页（`index.html`）中已有手机扫码二维码。可以在同一页面增加一个"PC 安装"按钮，指向 AGC 内部测试的分享链接，实现：

```
安装页面
├── 手机扫码安装  ← 现有功能（store:// DeepLink）
└── PC 安装      ← 新增按钮（指向 AGC 内部测试链接）
```

### 限制条件

| 限制项 | 说明 |
|--------|------|
| 测试用户数 | 最多 100 人 |
| Profile 有效期 | 90 天（需定期续签） |
| 版本号 | 新版本 VersionCode 必须大于旧版本 |
| 审核 | 首次上传需人工审核，后续版本通常自动通过 |
| 网络 | 安装时需要联网校验签名 |

### 优缺点

| 优点 | 缺点 |
|------|------|
| 用户零门槛，点链接即可 | 最多 100 个测试用户 |
| 不需要开发者模式 | Profile 有效期 90 天 |
| 不需要打开终端 | 依赖华为 AGC 平台 |
| 正式合规，无安全风险 | 首次上传需审核 |
| 手机 + PC 共用同一套签名 | 版本号必须递增 |

---

## 两种方案对比

| 维度 | 方案一：本机终端 + hdc 自连 | 方案二：AGC 内部测试 |
|------|:---|:---|
| 需要开发者模式 | **是** | **否** |
| 需要外部设备 | **否** | **否** |
| 用户操作 | 终端执行两行命令 | **极低（点链接）** |
| 签名类型 | debug 签名 | internaltesting 签名 |
| 用户数限制 | 无限制 | 最多 100 人 |
| 有效期 | 无限制 | 90 天 |
| 依赖外部平台 | 否 | 是（华为 AGC） |
| 合规性 | 开发调试用途 | 官方内测通道 |
| 自动化程度 | 可封装为一行命令 | 可集成到 HPack 构建流水线 |

---

## 推荐策略

**首选（最省心）：方案二 AGC 内部测试**

理由：用户零门槛，点链接即装。你已有 `internaltesting` 签名流程，HAP 直接上传即可。唯一的改造成本是在 HPack 安装页加一个"PC 安装"按钮。

**兜底（无限制）：方案一 本机终端 + hdc 自连**

理由：当测试用户超过 100 人、或 Profile 过期续签间隙，方案一作为兜底。只需用户开启开发者模式 + 无线调试，终端执行两行命令即可。无需任何外部设备。

**两者的安装页可以共存：**

```
安装页面
├── 手机扫码安装       ← 现有功能
├── PC 安装（推荐）    ← 方案二：指向 AGC 内部测试链接，点即装
└── PC 终端安装（备用） ← 方案一：展示命令 + 端口号填写引导
```

---

## 参考资料

1. [HarmonyOS 应用内部测试 - 华为官方文档](https://developer.huawei.com/consumer/cn/doc/app/agc-help-harmonyos-internaltest-0000001937800101)
2. [hdc 调试命令 - 华为官方文档](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/hdc)
3. [HPack - 鸿蒙内测分发工具](https://github.com/iHongRen/hpack)
4. [AGC Testing API 参考 - 华为官方文档](https://developer.huawei.com/consumer/cn/doc/AppGallery-connect-References/agcapi-test-api-reference-0000002271000709)
5. [AGC Publishing API 参考 - 华为官方文档](https://developer.huawei.com/consumer/cn/doc/AppGallery-connect-References/agcapi-publishing-api-reference-0000002271000713)
6. [AGC 获取服务端授权（Service Account）- 华为官方文档](https://developer.huawei.com/consumer/cn/doc/appgallery-connect-guides/agc-auth-obtain-apiauthorization-0000001374178549)
7. [AGC 创建测试群组 - 华为官方文档](https://developer.huawei.com/consumer/cn/doc/App/agc-help-appgallery-create-testgroup-0000002258071216)
8. [AGC 创建内部测试用户群组 - 华为官方文档](https://developer.huawei.com/consumer/cn/doc/doccenter-submission/agc-help-apptest-create-internalgroup-0000002486254204)
9. [AGC 邀请用户参与测试（公开链接）- 华为官方文档](https://developer.huawei.com/consumer/cn/doc/app/agc-help-apptest-invite-testuser-0000002258071224)
10. [AGC 自动化发布脚本 - agc_auto_publish.py](computer:///sessions/6a7d3187d477a8d7a903ef96/workspace/agc_auto_publish.py)
