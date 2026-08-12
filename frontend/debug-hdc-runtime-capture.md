# Debug Session: hdc-runtime-capture

- Status: OPEN
- Goal: 验证 `scripts/hdc_runtime_capture.py` 是否能按预期自动发现 `.hap`、驱动设备切换 tab/滚动截图，并最终产出 GIF。

## Hypotheses

1. `hdc` 可执行文件未找到或不可运行，脚本会在初始化阶段失败。
2. 当前没有可用设备/模拟器，脚本会在 target 解析阶段失败。
3. 工作目录下没有可用 `.hap`，脚本会在 `find_latest_hap()` 阶段失败。
4. 配置文件中的动作序列可被成功执行，脚本会生成截图清单和 GIF。
5. Python 环境缺少 Pillow，即使截图成功也会在 GIF 生成阶段失败。

## Plan

1. 检查脚本依赖和可用配置。
2. 做一次最小化实际运行，收集 stdout/stderr 与产物目录。
3. 根据运行证据判断失败点或确认全链路可用。

## Evidence

- `python3 scripts/hdc_runtime_capture.py --help` 正常，命令行入口可用。
- `PIL` 可导入，GIF 合成依赖已安装。
- `resolve_hdc_binary()` 成功解析到 DevEco 自带的 `hdc` 工具。
- `list_targets()` 返回可用设备/模拟器地址，设备在线。
- 在默认 workspace 与 harmony-pilot 目录下都未找到 `.hap`，默认运行会在 `find_latest_hap()` 直接失败。
- 使用 `--hap /tmp/fake.hap --skip-install --skip-launch` 的最小化测试中，`swipe` 与 `keyEvent` 成功执行，但 `snapshot_display -f ...png` 返回"suffix must be .jpeg"，导致后续 `file recv` 拿不到文件，最终 GIF 生成失败。
- 构建完成后，workspace 下 `entry/build/default/outputs/default/entry-default-unsigned.hap` 可被检测到。
- 运行 `python3 scripts/hdc_runtime_capture.py --workspace <workspace> --target <device> --run-id manual-check-002` 时，会在 `infer_capture_plan()` 失败：未能从 `entry/src/main/ets/pages/Index.ets` 推断出 Tabs 定义。
- `Index.ets` 实际使用的是 `.tabBar(this.TabBuilder(...))` 与 `.tabBar(this.CenterTabBuilder())`，而不是旧正则依赖的 `this.TabBar(...)` / `this.CenterTabBar(...)` 形式。
- 因为 `main()` 先执行 `infer_capture_plan()`，所以这次运行还没进入 `install/launch/screenshot/MP4` 阶段。
- 修复 `infer_capture_plan()` 后，`python3 scripts/hdc_runtime_capture.py --workspace <workspace> --plan-only` 已成功输出自动推断 plan。
- 最新一次真实执行为 `--run-id manual-check-003`，输出目录是 `data/artifacts/videos/manual-check-003/`。
- `manual-check-003` 中的 `capture-manifest.json` 证明：HAP 安装成功、Ability 启动成功，但第一次 `bootstrap_0` 截图仍失败，原因仍是 `snapshot_display` 只接受 `.jpeg`，而当前代码写的是 `.png`。

## Interim Conclusion

1. 脚本的整体链路设计判断是对的：会尝试找 `.hap`、再做动作、再截图、最后生成 MP4。
2. 旧版本的一个阻塞点是 `.hap` 缺失，但构建成功后这个问题已解除。
3. 当前最新阻塞点变成"Tabs 自动推断失败"，根因是 `infer_capture_plan()` 的匹配规则没有覆盖 `TabBuilder/CenterTabBuilder` 写法。
4. 自动推断阻塞点已解除，当前主阻塞点重新回到截图兼容性：当前设备的 `snapshot_display` 仅接受 `.jpeg`。
5. `run_hdc()` 仅依据 return code 判断成功，但 `snapshot_display`/`file recv` 这类命令可能 return code 为 0 且 stdout 含错误，后续仍需补强判定。