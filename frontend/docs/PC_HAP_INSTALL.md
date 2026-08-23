# HarmonyOS PC 一键安装实现说明

更新时间：2026-08-21

## 目标

让普通用户下载签名后的 HAP 整包并安装到 HarmonyOS PC，不要求安装 DevEco Studio、不要求使用终端或 HDC，也不要求开启开发者选项。

最终用户只需要两步：

1. 在目标 HarmonyOS PC 的华为浏览器中打开应用安装页。
2. 点击“一键安装到鸿蒙PC”，按系统安装器提示确认。

## 实现方案

构建侧生成一个同时支持手机和 PC 的 release HAP：

```json
{
  "deviceTypes": ["phone", "2in1"]
}
```

HPack 使用现有证书、Profile 和私钥对 HAP 及安装清单签名。当前界面直接暴露签名 HAP 下载；保留的旧版安装页使用系统企业安装协议：

```text
store://enterprise/manifest?url=<经过 URL 编码的 HTTPS manifest 地址>
```

旧版链接由 HarmonyOS 系统安装器下载并校验 manifest、HAP、哈希和签名。当前旧版入口默认隐藏；HAP 整包安装不依赖 ExpoGo 或持续连接开发服务器。

## 华为官方文档

- [构建 Deeplink 实现下载应用（指定设备发布）](https://developer.huawei.com/consumer/cn/doc/app/agc-help-internal-test-release-app-0000002260691994)：定义 `store://enterprise/manifest?url=...`、manifest 字段、HAP 下载、HTTPS、HEAD、分片下载和点击触发规则。
- [In-house 应用发布指导和常见问题分析](https://developer.huawei.com/consumer/cn/doc/harmonyos-faqs/faqs-appgallery-80)：说明企业内部发布所需的组织证书/Profile及申请条件。
- [应用如何上架分发到多端（手机、PC、平板）](https://developer.huawei.com/consumer/cn/doc/harmonyos-faqs/faqs-appgallery-27)：说明 `deviceTypes` 的 `phone`、`tablet`、`2in1` 以及 PC 适配要求。

官方 DeepLink 约束（本项目必须遵守）：

- 仅支持页面中的用户点击行为触发；不支持地址栏直接输入，也不支持 HTML 自动拉起。
- 官方文档写明仅支持华为浏览器拉起，因此不能承诺任意第三方浏览器都可安装。
- manifest 和 HAP 的下载链接必须是 HTTPS，域名不能使用 IP 地址。
- manifest 和安装包需要支持 HEAD 返回文件大小，并支持分片下载。

## 代码改动

- `scripts/hpack_packager.py`
  - Expo 预构建 HAP 在发布前同时校验 `phone` 与 `2in1`。
  - 通用工程签名前把 `deviceTypes` 规范为 `phone + 2in1`，重新构建后再次校验。
  - 发布页生成手机/PC 共用的签名 HAP，并保留安装链接兼容产物。
- `web/src/components/detail/ExpoInstallMenu.tsx`
  - “安装到 PC”默认展示当前 HAP 整包下载入口。
  - 旧版系统安装链接、安装页以及 ExpoGo + 外网预览入口仍保留在代码中，但默认隐藏；需要回滚时可在前端构建前设置 `VITE_SHOW_LEGACY_PC_INSTALL=true`。
  - 明确告知用户不需要开发工具或开发者选项。
- `tests/python/test_hpack_packager.py`
  - 覆盖 PC device type 缺失、双端 manifest 和安装页文案。

## 普通用户操作说明

1. 生成任务完成后，点击页面右上角“安装”→“安装到 PC”。
2. 等待页面显示安装按钮。
3. 确认当前页面是在目标 HarmonyOS PC 的华为浏览器中打开的，并确认设备 ID 已加入安装包 Profile 白名单。
4. 点击“一键安装到鸿蒙PC”，在系统安装器中确认。

不需要解压 ZIP、打开终端、输入端口号或开启无线调试。

## 分发与签名限制

“不要求用户是开发者”指安装操作不依赖开发者工具和开发者模式；它不能绕过 HarmonyOS 的应用签名与分发安全策略。

当前项目使用 `internaltesting` Profile 时：

- 只有 Profile 中已登记 UDID 的 PC 才能安装；
- 未登记设备可能出现应用验证失败（例如 10019）；
- 更换 Profile 或签名后，已安装的同 bundleName 应用可能需要先卸载；
- Profile、证书或安装清单过期后，需要重新签名发布。

如果目标是让任意普通用户安装，推荐把应用正式上架 AppGallery。组织内批量分发则应使用华为提供的合规企业分发方案，并按该方案配置证书、Profile 和设备范围。

## 部署要求

- 安装页、manifest、图标和 HAP 必须通过公网 HTTPS 访问。
- 使用隐藏的旧版安装链接时，必须由华为浏览器页面中的用户点击触发。
- `deployDomain` 必须与实际下载域名一致。
- 反向代理或 Cloudflare 不能拦截 HarmonyOS 安装器拉取 manifest/HAP；相关静态路径需要免登录访问。
- HAP 的签名证书必须与 Profile 中的分发证书匹配。
- 生成结果中的 `checks.index`、`checks.manifest` 和 `checks.hap` 应全部通过。

## 验收清单

1. 构建结果的 HAP `deviceTypes` 同时包含 `phone`、`2in1`。
2. 签名 manifest 的模块 `deviceTypes` 同时包含 `phone`、`2in1`。
3. 在已登记的 HarmonyOS PC 浏览器打开安装页，点击按钮能唤起系统安装器。
4. 无 DevEco Studio、无 HDC、未开启开发者选项时可完成安装。
5. 安装后断开网页与开发服务器，应用仍可独立启动。
6. 使用未登记设备测试时，系统应拒绝安装而不是降级到开发者侧载。

## 故障排查

| 现象 | 优先检查 |
| --- | --- |
| 点击按钮没有反应 | 是否在 HarmonyOS PC 的华为浏览器中打开；是否确实点击了页面按钮；浏览器是否允许唤起 `store://` |
| 提示设备不在范围或 10019 | PC UDID 是否已经写入当前 `internaltesting` Profile |
| 提示签名或应用验证失败 | HAP 证书、Profile 分发证书、manifest 签名证书是否一致 |
| 提示设备类型不支持 | HAP 和 manifest 是否都包含 `2in1` |
| manifest/HAP 下载失败 | HTTPS、域名、Cloudflare Access、Content-Type 与公网可访问性 |
| 提示与已安装应用签名不一致 | 卸载旧签名版本，或使用与旧版本一致的签名重新发布 |
