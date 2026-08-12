# 本地可交互预览

## 目标

构建任务完成后，右侧设备预览保持连接到本机 HarmonyOS 模拟器。用户可以直接在画面上点击、拖动或使用滚轮，操作会通过 HDC 作用于真实模拟器，随后右侧画面自动刷新。模拟器下方不再显示状态和快捷按钮行。

本地模式只需要现有开发机、HDC 和模拟器，不需要域名、额外服务器或 WebRTC 服务。

## 实现结构

```text
浏览器 DevicePreview
  ├─ GET  /api/runs/:runId/live/frame
  │      携带帧序号长轮询最新全分辨率 JPEG
  └─ POST /api/runs/:runId/live/input
         发送归一化坐标、手势或受限按键

Python RemoteUIHandler
  └─ LocalLivePreview
       ├─ 设备级优先队列和限流
       ├─ hdc shell uitest uiInput click/swipe/keyEvent
       ├─ hdc shell snapshot_display
       ├─ hdc file recv
       └─ run 级 JPEG 缓存、帧序号和条件通知

HarmonyOS 模拟器
```

### 点击到新画面的完整流程

1. 浏览器根据 `<img>` 的实际内容区域计算坐标，排除 `object-contain` 产生的黑边，再转换为 `0..1` 的归一化坐标。
2. `POST /live/input` 校验输入类型和坐标，不允许浏览器传入任意 HDC 或 shell 参数。
3. 输入进入对应 HDC target 的设备队列。输入任务优先于后台抓帧，避免截图长期占用设备。
4. 后端把归一化坐标换算为 JPEG 原始分辨率的像素坐标，执行 `uiInput click` 或 `uiInput swipe`。
5. 输入命令完成后，`/live/input` 立即返回，并把强制抓帧交给后台线程。后台线程继续通过同一个设备锁执行 `snapshot_display`、`file recv` 和 JPEG 缩放；远端临时文件也在请求关键路径外清理。
6. 新帧写入该 `runId` 的独立内存缓存，帧序号递增，并唤醒等待中的 `/live/frame` 长轮询。
7. `/live/input` 在 HDC 输入命令完成后立即返回 `frame_status=refreshing`，不再同步等待截图；后台截图完成后，已建立的长轮询会收到更大的 `frame_seq`。浏览器下载并成功解码新 JPEG 后，才替换当前 Object URL，避免半帧或空白闪烁。

交互后的第一帧会被后台任务立即抓取，不需要等待 1 秒的空闲刷新周期。`/live/input` 的响应与截图并行推进；JPEG 数据仍由已经建立的 `/live/frame` 长轮询获取。

### 帧流与并发策略

每个 `runId` 保存独立画面缓存、原始屏幕尺寸和递增帧序号，避免不同用户或运行之间串画面。指向同一设备的运行只共享设备级调度锁，截图与输入命令按设备串行执行，避免 HDC 命令交错。

公网页面会同时尝试 WebRTC DataChannel。HTTPS 只承担配置与 SDP 信令；ICE 成功后，JPEG 以 16KB 有序分片发送，点击通过同一 DataChannel 回传。浏览器上报选中的候选类型、UDP/TCP 与 RTT，并记录从点击到目标帧解码完成的时延。10 秒内无法打开通道、连接失败或中途断开时，页面自动恢复本节描述的 REST/JPEG 长轮询。

默认 STUN 是 `stun:stun.cloudflare.com:3478`，不配置 TURN，因此不会产生 TURN 流量费用；无法点对点连接的网络会使用 REST 回退。可通过 `HP_WEBRTC_STUN_URLS` 覆盖逗号分隔的 STUN 地址，`HP_WEBRTC_MAX_PEERS` 限制进程内并发 PeerConnection 数量。

当前固定参数定义在 `scan_install/live_preview.py`，暂时不是环境变量：

| 参数 | 当前值 | 作用 |
|---|---:|---|
| `FRAME_MAX_AGE_SEC` | `1.0s` | 空闲画面的最大缓存年龄 |
| `MAX_QUEUED_INPUTS` | `8` | 每台设备最多等待的输入数 |
| `INPUT_MIN_INTERVAL_SEC` | `0.06s` | 同一设备两次输入开始时间的最小间隔 |

队列已满时 `/live/input` 返回 `429`。截图任务发现有输入等待时会让输入先执行，降低连续长轮询下的点击尾延迟。

前端不是每 100ms 固定抓图，而是：

- 携带 `after=<当前帧序号>` 发起最长 1 秒的长轮询；
- 收到 fresh 帧后等待 25ms 再发下一次；后端会等待到共享帧需要刷新，因此不会按 25ms 实际抓图；
- 页面进入后台时中止长轮询并暂停抓帧，恢复可见后自动续接；
- stale 帧等待 500ms，接口错误等待 1 秒，避免模拟器异常时高频重试；
- 后端最多允许单次 `wait_ms=1500`；
- 新输入帧产生时通过条件变量立即唤醒长轮询。

抓帧失败时，后端会把失败时间视作一次刷新尝试，并在下一次 `FRAME_MAX_AGE_SEC` 到期后再尝试抓帧；长轮询会正常等到超时后才返回 stale 帧。这样既保留最近画面，也避免失败后立即返回导致浏览器形成紧密轮询。

每次抓帧先写入模拟器临时目录，再通过 `hdc file recv` 拉到本机临时文件。后端保留原始屏幕尺寸用于坐标换算，但向浏览器发送最大宽度 660px、质量 75 的 JPEG；远端临时文件异步清理。

### 失败回退

抓帧失败且内存中已有成功帧时，接口继续返回最近一帧：

- `X-Harmony-Preview-Status: stale`
- `X-Harmony-Preview-Sequence: <frame_seq>`

没有任何可用缓存时才返回 `502`。输入载荷无效返回 `400`，输入队列满返回 `429`，运行尚未完成自动安装与采集时返回 `409`。

运行记录使用临时文件完整写入后再原子替换，避免多个后台线程同时保存 run 状态时产生残缺 JSON，导致预览接口错误返回 `404`。

## 可用条件

1. 本机 DevEco Studio 和 HarmonyOS 模拟器正在运行。
2. `hdc list targets` 可识别到一个模拟器；若同时连接多个设备，在 `.env.local` 配置 `HP_HDC_TARGET=<target>`。
3. 该运行的自动安装与采集已完成，即接口返回的 `artifacts.live_ready` 为 `true`。

采集完成后不要关闭模拟器或结束应用进程，否则实时画面无法继续更新。原有 MP4 仍保留；在实时预览尚未就绪时，详情页可以继续展示已有媒体产物。实时预览已经启用但 HDC 临时抓帧失败时，页面优先保持最近一张成功 JPEG，而不是立即切换到 MP4。

## 接口

### `GET /api/runs/:runId/live/frame`

抓取模拟器当前 JPEG 画面。可传 `after=<frame_seq>&wait_ms=<0..1500>` 等待更新帧；响应通过 `X-Harmony-Preview-Sequence` 返回帧序号。接口遵循运行归属校验，只有创建该运行的访客或管理员可以读取。

响应包含 `X-Harmony-Preview-Width`、`X-Harmony-Preview-Height` 和 `X-Harmony-Preview-Bytes`。输入接口通过 JSON `timings` 和 `Server-Timing` 返回排队、HDC 输入及请求总耗时。

每次 `/live/input` 还会向 `data/logs/live-preview-latency.jsonl` 写入一条结构化记录，包括请求总耗时、操作类型、排队/HDC 输入耗时，以及 Cloudflare 转发的 `CF-Ray`、入口 `colo` 和国家代码。日志不记录点击坐标、Cookie 或用户输入内容。

实时查看点击日志：

```bash
tail -f data/logs/live-preview-latency.jsonl
```

### `POST /api/runs/:runId/live/input`

支持以下消息，坐标都是预览内容区域内的归一化值，范围为 `0` 到 `1`：

```json
{ "type": "tap", "point": { "x": 0.5, "y": 0.8 } }
```

```json
{
  "type": "swipe",
  "start": { "x": 0.5, "y": 0.8 },
  "end": { "x": 0.5, "y": 0.25 },
  "duration_ms": 360
}
```

```json
{ "type": "key", "key": "BACK" }
```

```json
{ "type": "scroll", "direction": "down" }
```

浏览器手势的 `duration_ms` 会结合实际屏幕像素距离转换为 HDC 所需的滑动速度。滚轮统一转换为屏幕中央的 swipe，避免不同系统版本对 `dircFling` 支持不一致。

按键接口仅允许 `BACK` 和 `HOME`；当前页面没有展示对应快捷按钮，但接口能力保留。后端不接受任意 HDC 或 shell 参数。

## 2026-07-30 点击时延实测

测试对象：

- run：`e90a8fb5ca44444f8957ea1d503fb2e2`
- 模拟器：`127.0.0.1:5555`
- JPEG：`1320 × 2856`
- 操作：通过 `/live/input` 交替点击计时器 Start/Pause
- 样本：12 次，间隔 100ms，全部返回 HTTP 200

`curl time_total` 结果：

| 指标 | 时延 |
|---|---:|
| 最小值 | `309.3ms` |
| 中位数 | `328.5ms` |
| 平均值 | `327.2ms` |
| P95 / 本次最大值 | `344.4ms` |
| 标准差 | `8.8ms` |

这项测量从 REST 请求发出开始，到 `/live/input` 返回结束，已经包含：

- 服务端鉴权和输入校验；
- 设备队列等待；
- HDC `uiInput click`；
- 点击后的 `snapshot_display`；
- `hdc file recv`；
- JPEG 读取、缓存和响应 JSON。

它不包含浏览器最后一次 `/live/frame` JPEG 传输和图片解码。由于新帧在 `/live/input` 返回前已经生成，同时会唤醒长轮询，本机页面通常只会再增加少量下载和解码时间。当前可将“点击到右侧出现新画面”的实际体感估算为约 `330–370ms`。

首次交互如果该 run 还没有屏幕尺寸缓存，会先额外抓取一帧，时延会高于上述稳态结果。HDC target 负载、同时打开的预览页数量和模拟器性能也会影响最终时延。

## 验证

在项目根目录执行：

```bash
python3 -m unittest discover -s tests -v
cd web && npm run build
```

关键测试对应关系：

| 能力 | 测试 |
|---|---|
| 输入载荷校验、坐标转换、JPEG 尺寸读取 | `tests/test_live_preview.py` |
| HDC 点击、速度换算、滚动与设备级串行化 | `tests/test_live_preview.py` |
| 实时画面和输入接口的运行归属保护 | `tests/test_live_preview_api.py` |
| 配置优先级、PID 忽略和安全重启脚本 | `tests/test_runtime_safety.py` |
| 前端 TypeScript 与生产构建 | `web` 的 `npm run build` |

## 当前边界

默认链路是 JPEG 帧流，不是连续 30fps 视频。视觉更新时延主要由公网传输、`uiInput`、`snapshot_display` 与 HDC 文件传输组成。若继续压缩时延，优先优化网络路径、截图和文件传输环节，而不是缩短 1 秒空闲帧龄；交互后的第一帧已经绕过空闲刷新周期。

本实现不提供连续视频；WebRTC DataChannel 是可选的低时延 JPEG/输入链路，REST 长轮询始终作为兼容回退。
