# Guest 与 Root 访问控制

## 目标

系统只区分两类访问者：

| 角色 | 身份方式 | 可见范围 |
| --- | --- | --- |
| Guest | 浏览器匿名 Cookie | 该浏览器创建的应用 |
| Root | 管理员密码登录 | 全部应用，包括旧记录 |

这不是完整的多用户账户系统。Guest 清除 Cookie 或更换浏览器后会成为新的匿名访客。

## Guest 隔离

首次创建应用时，后端生成随机 `harmony_pilot_visitor` Cookie，并将值保存为 run 的 `owner_id`。Cookie 使用 `HttpOnly`、`SameSite=Lax`、一年有效期；通过 HTTPS 反向代理访问时会额外设置 `Secure`。

`GET /api/runs` 对 Guest 仅返回 `owner_id` 匹配的记录。详情、进度、SSE、提问、媒体、缩略图、二维码和签名槽释放接口使用同一所有权校验；不匹配时返回 `404`。

历史 run 没有 `owner_id`，Guest 不会看到它们；Root 可以看到全部历史数据。

## Root 登录

Root 登录接口：

```text
GET  /api/auth/me
POST /api/auth/login
POST /api/auth/logout
```

Root 密码不会以明文保存在配置中。运行下列命令，输入密码两次：

```sh
cd /path/to/Genius/frontend
python3 scripts/generate_root_auth_config.py
```

将输出的两行配置写入未提交的 `deploy/server.env`：

```env
HP_ROOT_PASSWORD_HASH=pbkdf2_sha256$...
HP_AUTH_SIGNING_SECRET=...
```

密码哈希使用标准库 `hashlib.pbkdf2_hmac` 的 PBKDF2-HMAC-SHA256，并由生成脚本使用 600,000 次迭代。登录成功后，服务端发放有效期 8 小时的 `harmony_pilot_root` Cookie；Cookie 中的会话内容由 `HP_AUTH_SIGNING_SECRET` 进行 HMAC-SHA256 签名。退出登录会清除该 Cookie，轮换签名密钥会使全部 Root 会话失效。

同一 IP 连续 10 分钟内失败 5 次后，登录接口会暂时拒绝新的尝试。IP 仅用于登录限流，不用于用户身份识别。

## HAP 扫码下载

直接下载 HAP 仍然需要 Guest owner 或 Root 权限。为保留手机扫码安装，HAP 二维码带有随机 `share_token`：

```text
/api/runs/<run_id>/hap?share=<share_token>
```

持有此二维码或链接的人可以下载该 HAP，这属于安装分享能力，不会获得 run 的详情、列表或管理员权限。

## 运维注意事项

- 未配置 `HP_ROOT_PASSWORD_HASH` 或 `HP_AUTH_SIGNING_SECRET` 时，管理员登录入口不显示。
- 修改 `deploy/server.env` 后必须重启 remote-ui 后端。
- `deploy/server.env` 已被 Git 忽略；不得提交密码哈希、签名密钥或任何真实密码。
- 该方案适合单管理员。需要多个管理员、密码重置、审计或账号管理时，应迁移到正式用户表和认证服务。
