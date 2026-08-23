# 扫码直装改动总结 & 工程化差距分析

本文档汇总 `harmony-pilot-remote-ui` 与 `harmony-pilot` 两个仓库为支持 **HPack 扫码直装 + Profile 池并发** 所做的改动，并列出距离工程化交付仍欠缺的部分。

更新时间：2026-06-11

---

## 一、端到端链路

```text
用户在 Remote UI 提交 Build
  → harmony-pilot tmux-runner（scaffold + Agent 开发 + hvigor 构建）
  → 检测到 entry-default-unsigned.hap
  → [可选] hdc 预览采集（GIF/MP4）
  → hpack_packager.py 签名 + 发布安装页到 static/hpack/
  → 详情页展示 store:// 安装二维码
  → 鸿蒙手机扫码直装
```

---

## 二、`harmony-pilot-remote-ui` 改动清单

### 1. 新增模块（扫码直装逻辑从 app.py 抽出）

| 路径 | 作用 |
|------|------|
| `scan_install/config.py` | 加载 `deploy/server.env` / `.env.local`，集中 HPack、Profile 池等配置 |
| `scan_install/profile_pool.py` | Profile 池 acquire/release、注入 `ARKPILOT_BUNDLE_NAME`、状态 API 载荷 |
| `scan_install/hpack.py` | HPack 打包轮询、静态分发、`store://` URL、安装事件摘要 |
| `scan_install/time_utils.py` | ISO 时间工具 |

`app.py` 保留 HTTP 路由、tmux/capture 主流程，通过薄 wrapper 调用上述模块。

### 2. 新增脚本与部署模板

| 文件 | 作用 |
|------|------|
| `scripts/hpack_packager.py` | bundleName 校验 → `hpack pr` → 发布安装页 → 输出 `hpack-result.json` |
| `scripts/profile_pool_manager.py` | Profile 池：acquire/release/validate；从 `.p7b` 解析 bundleName |
| `scripts/preflight_verify.py` | 启动前检查：依赖、工具链、Profile 池、HPack 配置 |
| `scripts/run_dev.sh` / `run_backend.sh` / `run_tunnel.sh` | 一键或分步启动 app + tunnel |
| `scripts/sync_deploy_signing_assets.sh` | 同步 cer/p12/p7b 到 `deploy/signing/` |
| `deploy/server.env.example` | 服务器主配置模板 |
| `deploy/profile-pool.example.json` | Profile 池结构示例 |
| `deploy/signing/.gitkeep` | 签名目录占位 |
| `.env.example` | 可选本地覆盖说明 |

### 3. 修改文件

| 文件 | 主要改动 |
|------|----------|
| **`app.py`** | 集成 HPack 分发与 Profile 池；`wait_for_hap_and_package`；静态路由 `/hpack/`、`/install/`；HEAD 返回正确 `Content-Length`；`/api/profile-pool` |
| **`static/app.js`** | QR 三态：等待 HAP / 签名中 / Install Ready |
| **`templates/detail.html`** | 「扫码安装」面板 |
| **`README.md`** | 运行方式、HPack、Tunnel、Profile 池 |
| **`.gitignore`** | 忽略 `deploy/server.env`、签名材料、`static/hpack/*` 等 |

### 4. 本地配置（不入库）

| 文件 | 内容 |
|------|------|
| `deploy/server.env` | 路径、签名密码、Tunnel token |
| `deploy/profile-pool.json` | Profile slot 与相对签名路径 |
| `deploy/signing/*.cer/p7b/p12` | 签名私钥材料 |
| `.env.local` | 可选本机覆盖 |

### 5. 运行时产物（不入库）

```text
static/hpack/<remote_dir>/          # HPack 安装页、signed HAP、manifest
data/artifacts/hpack/<run_id>/      # hpack-result.json
data/logs/<run_id>.hpack.log        # 签名日志
deploy/profile-pool-state.json      # Profile 租约状态
```

---

## 三、`harmony-pilot` 配套改动（单独仓库提交）

| 文件 | 作用 |
|------|------|
| `scripts/lib/config.mjs` | 文档路径改相对路径 + env 覆盖 |
| `skills/create-harmony-project/scripts/create_project.py` | 支持 `ARKPILOT_BUNDLE_NAME`、hvigorw wrapper |
| `skills/create-atomic-service/scripts/create_project.py` | 同上 |
| 相关 `SKILL.md` | 文档补充 env 变量 |

Remote UI Profile 池注入的 bundleName **必须**经 harmony-pilot scaffold 写入 `app.json5`，否则签名校验会失败。

---

## 四、配置说明

主配置入口是 **`deploy/server.env`**，不是 `.env.local`：

```bash
cp deploy/server.env.example deploy/server.env
cp deploy/profile-pool.example.json deploy/profile-pool.json
# 签名文件放入 deploy/signing/，编辑 deploy/server.env
python3 scripts/preflight_verify.py
scripts/run_dev.sh
```

Profile 池存在时自动启用（`HP_PROFILE_POOL_ENABLED=auto`），每 run 可隔离 workspace（`demo/<run_id>/`）。

---

## 五、提交建议

**应提交：**

```text
.gitignore README.md app.py static/app.js templates/detail.html
scan_install/ scripts/hpack_packager.py scripts/profile_pool_manager.py
scripts/preflight_verify.py scripts/run_*.sh scripts/sync_deploy_signing_assets.sh
deploy/server.env.example deploy/profile-pool.example.json deploy/signing/.gitkeep
docs/CHANGELOG-SCAN-INSTALL.md .env.example
```

**不要提交：** `deploy/server.env`、`deploy/profile-pool.json`、`deploy/signing/*`（除 `.gitkeep`）、`.env.local`、`static/hpack/*`

**提交前清理：**

```bash
rm -f data/signing-pool-state.json   # 旧路径残留
python3 scripts/profile_pool_manager.py validate
python3 scripts/preflight_verify.py
```

---

## 六、服务器部署 Checklist

1. 克隆 `harmony-pilot-remote-ui` 与 `harmony-pilot`
2. 按第四节配置 `deploy/server.env` 与 Profile 池
3. 安装 DevEco 工具链（Java、hvigorw、hpack、hdc）
4. `python3 scripts/preflight_verify.py` → `scripts/run_dev.sh`
5. Cloudflare：Tunnel → `127.0.0.1:8080`；Access 对 `/static/hpack/*` **Bypass**

---

## 七、离「工程化」还差什么

### 必须补（上线 / 团队使用前）

| 缺口 | 建议 |
|------|------|
| **harmony-pilot 未提交** | scaffold 需支持 `ARKPILOT_BUNDLE_NAME` |
| **Cloudflare Access** | 安装路径 Bypass，避免手机拉 manifest 被登录拦截 |
| **进程托管** | launchd/systemd 托管 app + tunnel |
| **HPack 失败重试** | 详情页一键重签或自动重试 |

### 建议补（稳定性）

| 缺口 | 建议 |
|------|------|
| **自动化测试** | HPack、Profile 池、`do_HEAD`、install-qr 的 pytest |
| **Preflight 进 CI** | 语法检查 + preflight |
| **公网 URL 校验** | 打包后 HEAD 检查 manifest/HAP |
| **Range 请求** | 大 HAP 支持 `Range: bytes=` |

### 长期演进

多租户、对象存储分发、SQLite 状态、Secret 管理、失败原因 UI 展示等。

---

## 八、结论

**功能链路已打通**（Build → 签名 → 扫码直装 + Profile 池并发），代码已模块化到 `scan_install/` 便于 review。当前仍是 **本机 + Tunnel 验证形态**，harmony-pilot 配套提交与 Cloudflare 策略是上线前最优先的两项。
