# 历史记录功能实现说明

## 需求背景

用户在首页提交 prompt 后，系统会生成一个 HarmonyOS App，并在详情页展示构建进度、真机预览、HAP 下载和扫码安装结果。历史记录功能的目标是把这些已经生成过的 App 汇总到一个“我的应用”页面，方便用户回看、筛选和重新进入详情页。

第一版不引入登录和数据库，直接复用现有 `data/runs/*.json`、`data/artifacts/videos/*`、`data/artifacts/hpack/*` 等本地记录。

## 本地数据来源

“我的应用”列表不是从远端服务或数据库读取的，而是由当前 remote-ui 后端在本机文件系统中扫描生成记录得到。

当前工程根目录：

```text
/Users/m2/Desktop/code/harmony-pilot-remote-ui
```

历史 run 记录目录：

```text
/Users/m2/Desktop/code/harmony-pilot-remote-ui/data/runs/
```

每个生成任务对应一个 JSON 文件：

```text
data/runs/<run_id>.json
```

这些 JSON 会被 `iter_run_records()` 读取，并反序列化为 `RunRecord`。列表页的基础信息来自这里，包括：

- `run_id`
- `prompt`
- `status`
- `variant`
- `session_name`
- `workspace`
- `created_at`
- `updated_at`
- `notes`

每个 run 生成出来的 HarmonyOS 工程目录来自 `RunRecord.workspace` 字段。当前推荐的隔离 workspace 结构通常是：

```text
/Users/m2/Desktop/code/harmony-pilot-remote-ui/workspace/<run_id>/
```

预览视频、截图和采集结果目录：

```text
/Users/m2/Desktop/code/harmony-pilot-remote-ui/data/artifacts/videos/<run_id>/
```

常见文件：

```text
data/artifacts/videos/<run_id>/capture-manifest.json
data/artifacts/videos/<run_id>/demo.mp4
data/artifacts/videos/<run_id>/screenshots/*.png
data/artifacts/videos/<run_id>/screenshots/*.jpeg
```

扫码安装/签名发布结果目录：

```text
/Users/m2/Desktop/code/harmony-pilot-remote-ui/data/artifacts/hpack/<run_id>/
```

常见文件：

```text
data/artifacts/hpack/<run_id>/hpack-result.json
```

后端 `GET /api/runs` 会综合以上目录生成列表摘要。它不会依赖浏览器本地存储，也不会要求用户先登录。



## 前端页面


新增页面：
![img_1.png](assets/myApp.png)

```text
web/src/pages/HistoryPage.tsx
```

路由：

```text
/runs
```

页面能力：

- 展示所有历史生成记录。
- 支持搜索 prompt。
- 支持按状态筛选：
  - 全部
  - 生成中
  - 已完成
  - 失败
- 支持最新/最早排序。
- 支持卡片视图和列表视图切换。
- 点击卡片或列表项进入对应详情页 `/runs/<run_id>`。
- 卡片状态标签放在卡片文字区域，不再压在图片上，避免截图背景影响可读性。

## 状态展示规则

后端历史列表接口会把原始 run 状态归一成更适合产品展示的状态：

| 展示状态 | 判断依据 |
| --- | --- |
| `complete` | HPack manifest 为 `ready`，或 capture manifest 为 `complete`，或 run/tmux 状态是 `complete/succeeded/ready/install_ready` |
| `failed` | run/tmux 状态是 `failed/error`，或 capture/hpack 状态是 `failed` |
| `queued` | run/tmux 状态是 `queued/waiting/waiting_hap` |
| `active` | 其他仍在生成过程中的状态 |

具体读取顺序如下：

1. 先读取 `data/runs/<run_id>.json` 中保存的 `record.status`，这是任务创建和后台进程启动时写入的基础状态。
2. 再读取对应 workspace 下的 tmux runner 状态：

   ```text
   <workspace>/.arkpilot/state/...
   ```

   如果能读到 tmux state 且里面有 `status`，优先使用 tmux state 的状态。

3. 如果 `record.status` 是 `running`，但 `process_pid` 已经不存在，则认为该 run 已失败。
4. 读取采集结果：

   ```text
   data/artifacts/videos/<run_id>/capture-manifest.json
   ```

   - `status == "complete"`：说明真机预览/截图采集完成，可以作为“已完成”的依据。
   - `status == "failed"`：说明预览采集失败，作为“失败”的依据。

5. 读取 HPack 发布结果：

   ```text
   data/artifacts/hpack/<run_id>/hpack-result.json
   ```

   - `status == "ready"`：说明签名包和扫码安装页已生成，优先判定为“已完成”。
   - `status == "failed"`：说明发布/签名失败，作为“失败”的依据。

最终展示状态的优先级：

1. **已完成**：HPack 为 `ready`，或 capture 为 `complete`，或 run/tmux 状态本身是成功类状态。
2. **失败**：run/tmux 是失败类状态，或 capture/hpack 是 `failed`。
3. **等待中**：run/tmux 是 `queued/waiting/waiting_hap`。当前 UI 内部保留这个桶，但筛选栏不展示“等待中”按钮。
4. **生成中**：其余状态统一视作还在生成过程中。

前端将这些状态映射成：

| 后端状态 | UI 分类 |
| --- | --- |
| `complete/succeeded/ready/install_ready` | 已完成 |
| `failed/error` | 失败 |
| `active/running/packaging/building` | 生成中 |
| `queued/waiting/waiting_hap` | 等待中内部桶，但当前筛选栏不展示等待中分类 |

## 图片展示规则

历史卡片的封面按以下优先级选择：

1. 已完成记录优先使用首张截图：

   ```text
   /api/runs/<run_id>/thumbnail
   ```

2. 如果老数据没有截图目录，但 `media_url` 本身是图片格式，则用 `media_url` 兜底。
3. 生成中或等待中的记录使用：

   ```text
   web/src/assets/images/generating.jpeg
   ```

4. 失败记录使用：

   ```text
   web/src/assets/images/generated-failed.jpeg
   ```

截图来源：

- 优先读取 `capture-manifest.json` 中的 `unique_screenshots` 和 `screenshots`。
- 如果 manifest 中没有可用路径，则读取：

  ```text
  data/artifacts/videos/<run_id>/screenshots/
  ```

## 后端接口

新增接口：

```text
GET /api/runs
GET /api/runs/<run_id>/thumbnail
HEAD /api/runs/<run_id>/thumbnail
```

`GET /api/runs` 返回结构：

```json
{
  "runs": [
    {
      "run_id": "string",
      "prompt": "string",
      "status": "active | complete | failed | queued",
      "variant": "string",
      "session_name": "string",
      "created_at": "string",
      "updated_at": "string",
      "notes": "string",
      "detail_url": "/runs/<run_id>",
      "has_media": true,
      "media_url": "/api/runs/<run_id>/media",
      "media_type": "mp4 | png | jpeg | ...",
      "has_thumbnail": true,
      "thumbnail_url": "/api/runs/<run_id>/thumbnail"
    }
  ],
  "total": 0,
  "counts": {
    "active": 0,
    "complete": 0,
    "failed": 0
  }
}
```

## 主要改动文件

后端：

```text
app.py
```

- 新增 `find_first_screenshot()`。
- 新增 `handle_list_runs()`。
- 新增 `handle_get_thumbnail()`。
- `do_GET` / `do_HEAD` 增加 `/api/runs` 和 `/api/runs/<run_id>/thumbnail` 路由。

前端：

```text
web/src/pages/HistoryPage.tsx
web/src/main.tsx
web/src/lib/api.ts
web/src/lib/types.ts
web/src/components/layout/TopBar.tsx
web/src/components/ui/StatusBadge.tsx
web/src/pages/HomePage.tsx
web/src/pages/DetailPage.tsx
```

- `HistoryPage.tsx`：新增“我的应用”页面、搜索、筛选、排序、视图切换和卡片/列表展示。
- `main.tsx`：注册 `/runs` 路由。
- `api.ts` / `types.ts`：新增 `getRuns()`、`RunSummary`、`RunListResponse`。
- `TopBar.tsx`：增加 `left` 插槽，让首页展示品牌，详情页和历史页展示返回按钮。
- `StatusBadge.tsx`：补充 `active/complete/queued` 等历史展示状态映射。
- `HomePage.tsx`：新增“我的应用”入口，并统一首页主按钮样式。
- `DetailPage.tsx`：新增返回按钮和“我的应用”入口，移除实时推送状态胶囊，统一“新建构建”主按钮样式。

资源：

```text
web/src/assets/images/generating.jpeg
web/src/assets/images/generated-failed.jpeg
web/src/assets/images/app-placeholder.png
```

这些图片统一放在 `web/src/assets/images/`，由 Vite 资产管线处理。`app-placeholder.png` 是早期占位图，当前卡片逻辑已经优先使用生成中/失败默认图和成功截图。

## 验证方式

前端构建：

```bash
cd web
npm run build
```

后端语法检查：

```bash
python3 -m py_compile app.py
```

本地验证：

```bash
scripts/restart_local.sh --foreground
```

访问：

```text
http://127.0.0.1:8180/runs
```

接口验证：

```bash
curl -fsS http://127.0.0.1:8180/api/runs
curl -I http://127.0.0.1:8180/api/runs/<run_id>/thumbnail
```
