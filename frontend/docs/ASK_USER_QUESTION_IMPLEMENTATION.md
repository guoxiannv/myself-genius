# AskUserQuestion Remote UI 实现说明

本文档说明当前 `AskUserQuestion` 能力在 `harmony-pilot` 后端插件仓库和 `harmony-pilot-remote-ui` 前端仓库里的实现方式、数据流、文件协议、接口、UI 展示和已知注意事项。

## 1. 目标

原始 Claude Code 的 `AskUserQuestion` 会在 tmux/终端里弹出原生选择界面。现在的目标是：

1. Agent 需要问用户问题时，仍然调用 Claude Code 的 `AskUserQuestion` tool。
2. 后端 hook 拦截这个 tool 调用，把问题写到当前 run 的 workspace。
3. remote-ui 后端读取这个问题，并通过 run 详情接口/SSE 推给前端。
4. 用户在 Web UI 上选择并提交答案。
5. remote-ui 后端把答案写回 workspace。
6. hook 等到答案后放行 `AskUserQuestion`，把 `answers` 注入回 tool input，让 Agent 继续执行。

核心原则：**用户问题必须出现在 Web UI，而不是终端里直接问。**

## 2. 涉及仓库和主要文件

### `harmony-pilot`

这个仓库负责 Claude Code 插件、hook 和 workflow prompt。

- `hooks/hooks.json`
  - 给 `PreToolUse` 增加 `AskUserQuestion` matcher。
  - 当 Claude 调用 `AskUserQuestion` 时执行自定义 hook。

- `hooks/ask-user-question-pretooluse.cjs`
  - 从 demo 拷贝来的 hook 主体。
  - 做了最小适配：默认 state 目录改成当前 workspace 下的 `.arkpilot/state/ask-user-question`。
  - 负责写 `request-*.json`、等待 `response-*.json`、最终返回 `permissionDecision: allow`。

- `scripts/lib/workflow-prompts.mjs`
  - 给 plan/design lane 加强约束：
    - vague 或需要用户澄清时必须调用 `AskUserQuestion`。
    - 禁止用普通终端文本问用户。
    - 明确给出 `AskUserQuestion` 的参数 shape，降低模型传错参数的概率。
  - 给非 plan/design lane 加禁止指令，避免多 lane 重复问用户。

- `skills/autopilot-html-tmux-design-uitree-*/SKILL.md`
  - 把原来的 “ask focused follow-up questions” 改成必须调用 `AskUserQuestion`。
  - 同步写明参数格式。

### `harmony-pilot-remote-ui`

这个仓库负责 Web 后端接口和 React UI 展示。

- `app.py`
  - 读取 workspace 下的 AskUserQuestion request/response 文件。
  - 根据 `active.json`、超时时间、response 文件把问题归类为 `pending` / `answered` / `stale`。
  - 在 run progress payload 里加 `questions` 字段。
  - 在 timeline 里加 `kind: "question"` 事件。
  - 新增读取问题和提交答案的 HTTP API。

- `web/src/components/detail/QuestionPanel.tsx`
  - 在详情页展示 pending question。
  - 支持单选、多选、Other、自定义输入。
  - 提交后调用后端 answer API。

- `web/src/pages/DetailPage.tsx`
  - 从 `data.questions.pending` 取 pending question。
  - 有问题时在构建进度上方展示 `QuestionPanel`。
  - 支持 `?ask=demo` 演示模式。

- `web/src/lib/types.ts`
  - 新增 `AskUserQuestionOption`、`AskUserQuestionItem`、`AskUserQuestionRequest`、`AskUserQuestionState`。
  - `RunProgress` 新增 `questions?: AskUserQuestionState`。

- `web/src/lib/api.ts`
  - 新增 `answerQuestion(runId, questionId, answers)`。

## 3. 整体链路

```text
Claude design lane
  |
  | calls AskUserQuestion tool
  v
harmony-pilot/hooks/ask-user-question-pretooluse.cjs
  |
  | writes request-<toolUseId>.json
  v
workspace/.arkpilot/state/ask-user-question/
  |
  | remote-ui app.py reads request files, active.json, response files
  v
GET /api/runs/:runId
GET /api/runs/:runId/questions
  |
  | frontend renders QuestionPanel
  v
User submits answers in Web UI
  |
  | POST /api/runs/:runId/questions/:questionId/answer
  v
workspace/.arkpilot/state/ask-user-question/response-<toolUseId>.json
  |
  | hook polling sees response file
  v
hook returns permissionDecision: allow + updatedInput.answers
  |
  v
Claude continues generation
```

## 4. 文件协议

所有问题和答案都落在当前 run 的 workspace：

```text
<workspace>/.arkpilot/state/ask-user-question/
```

### request 文件

hook 创建：

```text
request-<question_id>.json
```

同时 hook 会写入：

```text
active.json
```

`active.json` 内容与当前正在等待的 request 基本一致，用于告诉 remote-ui：哪个 AskUserQuestion 是当前 hook 进程正在等待的有效问题。后端会优先把 active request 放到 `pending` 最前面，避免历史残留 request 抢占 UI。

示例结构：

```json
{
  "toolUseId": "tool_xxx",
  "sessionId": "35e210c4-...",
  "transcriptPath": "...jsonl",
  "cwd": "/.../workspace/<run_id>",
  "permissionMode": "bypassPermissions",
  "hookEventName": "PreToolUse",
  "toolName": "AskUserQuestion",
  "createdAt": "2026-07-06T02:53:38.531Z",
  "toolInput": {
    "questions": [
      {
        "header": "App idea",
        "question": "What kind of HarmonyOS app do you want to build?",
        "options": [
          {
            "label": "Productivity / todo",
            "description": "Task management, notes, planners..."
          }
        ],
        "multiSelect": false
      }
    ]
  },
  "rawHookInput": {},
  "requestPath": ".../request-tool_xxx.json",
  "responsePath": ".../response-tool_xxx.json"
}
```

### response 文件

remote-ui 后端创建：

```text
response-<question_id>.json
```

示例结构：

```json
{
  "id": "tool_xxx",
  "toolUseId": "tool_xxx",
  "answers": {
    "What kind of HarmonyOS app do you want to build?": "Productivity / todo"
  },
  "answeredAt": "2026-07-06T03:10:10.569405+00:00",
  "answeredBy": "remote-ui"
}
```

### completed 文件

hook 收到 response 后创建：

```text
completed-<question_id>.json
```

用于标记这个 AskUserQuestion 已经被 hook 消费并回传给 Claude。

## 5. hook 具体行为

实现文件：

```text
/Users/m2/Desktop/code/harmony-pilot/hooks/ask-user-question-pretooluse.cjs
```

核心逻辑：

1. 读取 stdin 中 Claude Code 传入的 hook payload。
2. 如果 `input.tool_name !== "AskUserQuestion"`，直接输出 `{}` 放行。
3. 计算 state 目录：

```js
const workspaceDir =
  process.env.ARKPILOT_WORKSPACE_CWD ||
  process.env.CLAUDE_PROJECT_DIR ||
  process.cwd()

const stateDir =
  process.env.ASK_USER_WEB_HOOK_STATE_DIR ||
  process.env.ARKPILOT_ASK_USER_QUESTION_STATE_DIR ||
  path.join(workspaceDir, '.arkpilot', 'state', 'ask-user-question')
```

4. 根据 `tool_use_id` 生成安全 id。
5. 写：

```text
request-<id>.json
active.json
```

6. 轮询等待：

```text
response-<id>.json
```

默认：

```text
timeout: 600000ms = 10 分钟
poll interval: 300ms
```

7. 如果等到 response：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "AskUserQuestion was answered from the web hook UI",
    "updatedInput": {
      "...original tool input": "...",
      "answers": {}
    }
  }
}
```

8. 如果超时或 response 不合法：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason": "No web answer received before timeout"
  }
}
```

这个 fallback 会让 Claude Code 显示原生终端 AskUserQuestion UI。

## 6. remote-ui 后端实现

实现文件：

```text
/Users/m2/Desktop/code/harmony-pilot-remote-ui/app.py
```

### 目录定位

```python
def state_root(workspace: Path) -> Path:
    return workspace / ".arkpilot" / "state"

def ask_user_question_dir(workspace: Path) -> Path:
    return state_root(workspace) / "ask-user-question"
```

### 读取问题

`load_ask_user_questions(workspace)` 会：

1. 扫描：

```text
request-*.json
```

2. 对每个 request 找：

```text
response-<id>.json
completed-<id>.json
```

3. 组装成：

```json
{
  "pending": [],
  "answered": [],
  "stale": []
}
```

状态判断逻辑：

```text
有 response 文件 => answered
没有 response 文件，且是 active.json 指向的当前问题 => pending
没有 response 文件，没有 active.json，但未超时 => pending
没有 response 文件，已超时 => stale
没有 response 文件，且已有其他 active 问题 => stale
```

这样做是为了修复一个端到端验证中发现的问题：如果目录里残留了旧的未回答 request，前端过去会提交到旧 request 的 `response-*.json`，而当前 hook 等待的是另一个 request，于是用户点了“提交并继续”后 Agent 仍然不推进。现在旧 request 会被归为 `stale`，不会再进入 UI 的可提交队列。

超时时间由 remote-ui 后端用于状态归类：

```text
ASK_USER_WEB_HOOK_TIMEOUT_SEC || 600
```

hook 自身等待 response 的超时时间是毫秒：

```text
ASK_USER_WEB_HOOK_TIMEOUT_MS || 600000
```

两者默认都等价于 10 分钟，应保持一致。

排序规则：

```text
pending: active request 优先，其次按 request 文件时间从新到旧，最多返回 5 个
answered: 按 request 文件时间从旧到新，最多返回最近 10 个
stale: 按 request 文件时间从旧到新，最多返回最近 10 个
```

### run progress 集成

`build_progress_payload` 里会调用：

```python
questions = load_ask_user_questions(workspace)
```

然后：

1. 把 `questions` 放进 run payload：

```json
{
  "questions": {
    "pending": [],
    "answered": [],
    "stale": []
  }
}
```

2. 对 pending question 追加 timeline event：

```json
{
  "kind": "question",
  "summary": "等待用户回答 N 个问题。"
}
```

因为 run 详情页使用 SSE/polling 拉取 progress，所以 pending question 会自然推到前端。

### HTTP API

读取某个 run 的问题：

```http
GET /api/runs/:runId/questions
```

提交答案：

```http
POST /api/runs/:runId/questions/:questionId/answer
Content-Type: application/json

{
  "answers": {
    "question text": "answer"
  }
}
```

后端会校验：

1. run 是否存在。
2. question 是否还在 `pending`，不会允许提交 `answered` 或 `stale` 问题。
3. `answers` 是否为非空对象。

然后写：

```text
response-<questionId>.json
```

## 7. 前端实现

### 类型定义

文件：

```text
web/src/lib/types.ts
```

新增核心类型：

```ts
export interface AskUserQuestionOption {
  label: string
  description?: string
}

export interface AskUserQuestionItem {
  header?: string
  question: string
  options?: AskUserQuestionOption[]
  multiSelect?: boolean
}

export interface AskUserQuestionRequest {
  id: string
  toolUseId: string
  status: "pending" | "answered" | string
  audience?: "end_user" | "developer" | "auto_decidable" | "safety" | string
  toolInput: {
    questions?: AskUserQuestionItem[]
  }
  answers?: Record<string, string>
}

export interface AskUserQuestionState {
  pending: AskUserQuestionRequest[]
  answered: AskUserQuestionRequest[]
  stale?: AskUserQuestionRequest[]
}
```

后端返回的每个 question item 运行时还会带 `active` 和 `stale` 布尔字段，用于调试和状态识别；当前前端 UI 主要依赖 `questions.pending` 的排序结果，不直接使用这两个字段。

`RunProgress` 新增：

```ts
questions?: AskUserQuestionState
```

### API 封装

文件：

```text
web/src/lib/api.ts
```

新增：

```ts
answerQuestion: (runId, questionId, answers) =>
  request(`/api/runs/${runId}/questions/${questionId}/answer`, {
    method: "POST",
    body: JSON.stringify({ answers }),
  })
```

### 详情页挂载

文件：

```text
web/src/pages/DetailPage.tsx
```

逻辑：

```ts
const pendingQuestions = data?.questions?.pending?.length
  ? data.questions.pending
  : isDemo
    ? [DEMO_QUESTION]
    : []
```

只要有 pending question，就在构建进度卡片上方渲染：

```tsx
<QuestionPanel runId={runId} pending={pendingQuestions} />
```

`?ask=demo` 用于没有真实 AskUserQuestion 时预览 UI：

```text
/runs/<runId>?ask=demo
```

### QuestionPanel 行为

文件：

```text
web/src/components/detail/QuestionPanel.tsx
```

当前实现：

1. 只展示 `pending[0]`，也就是一次处理一个 AskUserQuestion request。由于后端已经把 active/newest request 排在前面，这个 request 应该就是当前 hook 正在等待的问题。
2. 一个 request 里可以包含多个 question。
3. 单选题默认选中第一个 option。
4. 多选题可以选择多个 option。
5. 每题都支持 `Other`，会用自定义文本覆盖或补充答案。
6. 提交时按 question 文本作为 key 组装：

```ts
answers[question.question] = "selected answer"
```

7. 调用：

```ts
api.answerQuestion(runId, request.id, answers)
```

8. 成功后显示“已提交回答”，并提示“已回传给 AI，正在继续生成...”。

## 8. workflow / skill 约束

为了避免模型在终端里直接问文字问题，做了两层约束。

### 初始 workflow prompt

文件：

```text
/Users/m2/Desktop/code/harmony-pilot/scripts/lib/workflow-prompts.mjs
```

plan/design lane 会附加：

```text
If the request is vague or you need any user clarification,
you MUST call the AskUserQuestion tool so the question appears
in the remote UI. Do not ask clarification questions as normal
terminal/chat text.
```

并写明参数格式：

```json
{
  "questions": [
    {
      "header": "Product",
      "question": "What kind of app should I generate?",
      "options": [
        {
          "label": "Utility",
          "description": "A practical tool app"
        }
      ],
      "multiSelect": false
    }
  ]
}
```

### design skill

这些文件也改了：

```text
skills/autopilot-html-tmux-design-uitree-pro/SKILL.md
skills/autopilot-html-tmux-design-uitree-balanced/SKILL.md
skills/autopilot-html-tmux-design-uitree-fast/SKILL.md
skills/autopilot-html-tmux-design-no-uitree-fast/SKILL.md
```

Stage 0 现在明确要求：

```text
If vague, call the AskUserQuestion tool...
Do not ask user-facing clarification questions as normal terminal/chat text...
```

### 非 plan/design lane

implementation、api-reference、visual-alignment 等非 plan prompt 会注入：

```text
Do NOT call AskUserQuestion or any user-facing question tool in this lane.
User preference questions are handled exclusively by the plan/design lane.
```

这是为了避免多 lane 并行时重复问用户。

## 9. 当前验证情况

用 run：

```text
611133f5e08a407e81687c1807be6a4b
```

验证到了这些点：

1. Claude 调用 `AskUserQuestion` 后，hook 能创建：

```text
.arkpilot/state/ask-user-question/request-*.json
```

2. remote-ui 接口能读到 pending question：

```http
GET /api/runs/611133f5e08a407e81687c1807be6a4b/questions
```

3. Web UI 可以展示问题。

4. Web UI 提交后后端会写：

```text
response-*.json
```

5. 如果在 hook timeout 之前提交，hook 会写：

```text
completed-*.json
```

并把答案回传给 Claude。

后续又验证了旧 request 残留场景：

1. 目录里存在多个 `request-*.json`。
2. 其中一个是 `active.json` 指向的当前问题。
3. 旧的未回答 request 会被归为 `stale`。
4. `QuestionPanel` 展示并提交当前 active request。
5. 提交后 hook 能消费正确的 `response-*.json`，Agent 继续执行。

## 10. 已知问题和注意事项

### 10.1 超时会 fallback 到终端

hook 默认只等 10 分钟：

```text
ASK_USER_WEB_HOOK_TIMEOUT_MS || 600000
```

如果用户在 10 分钟后才提交 UI 答案，hook 已经返回：

```json
"permissionDecision": "ask"
```

这时 Claude 会显示原生终端 AskUserQuestion UI。即使 UI 后来写了 response 文件，也已经不能被这一次 hook 消费。

建议：

1. 用户侧尽量在 10 分钟内提交。
2. 后续可以把 timeout 调长，比如 30 分钟。
3. 更理想的是由 remote-ui 提醒快超时，或者在 hook fallback 前更新 request 状态。

### 10.2 当前 hook 是轮询文件，不是 SSE

hook 运行在 Claude Code 的 PreToolUse 阶段，本质是一个命令进程。它通过文件轮询等待 UI 回答：

```text
request file -> response file
```

Web UI 到 remote-ui 后端可以用 SSE/polling 获取进度；但 hook 等答案这段目前是文件轮询。

### 10.3 active.json 用于识别当前等待的问题

hook 会写 `active.json`，正常收到 response 后会删除。remote-ui 会读取 `active.json` 来判断哪个 request 是当前正在等待的问题，并把它优先放入 `pending`。

超时 fallback 时当前 hook 没有删除 `active.json`。为了降低残留影响，remote-ui 同时会用 `createdAt/expiresAt` 或默认 10 分钟超时判断 request 是否过期。已经过期、或者被新的 active request 替代的问题会进入 `stale`，不会展示给用户提交。

### 10.4 当前 UI 一次只展示一个 pending request

`QuestionPanel` 使用：

```ts
const request = pending[0]
```

如果短时间内产生多个 pending request，UI 当前只展示后端排序后的第一个。后端排序会优先 active request，其次最新 request。后续如果希望同时展示多个 lane 的问题，可以扩展成队列或折叠列表。

### 10.5 模型仍可能传错 AskUserQuestion 参数

之前遇到过 `Invalid tool parameters`。所以现在已经在 workflow prompt 和 design skill 里补了明确 schema。后续如果还有类似问题，需要继续收敛 prompt 或在 hook 层做兼容/修复。

## 11. 本地验证步骤

启动服务：

```bash
cd /Users/m2/Desktop/code/harmony-pilot-remote-ui
scripts/restart_local.sh
```

当前更稳定的方式是用 tmux 托管：

```text
remote-ui-local-8180-8181
```

访问：

```text
http://127.0.0.1:8180/
```

问题接口：

```bash
curl -fsS http://127.0.0.1:8181/api/runs/<runId>/questions
```

手动提交答案：

```bash
curl -fsS \
  -X POST \
  http://127.0.0.1:8181/api/runs/<runId>/questions/<questionId>/answer \
  -H 'content-type: application/json' \
  -d '{"answers":{"问题文本":"答案文本"}}'
```

查看 workspace 文件：

```bash
find workspace/<runId>/.arkpilot/state/ask-user-question -maxdepth 1 -type f -print
```

## 12. 后续建议

1. 把 hook timeout 调长，减少用户稍慢提交时 fallback 到终端的概率。
2. 在 UI 上展示倒计时或“请尽快提交，超时后会回到终端问答”。
3. `QuestionPanel` 支持多个 pending request 队列。
4. hook fallback 时清理或显式标记 `active.json`，让 `stale` 判断更直接。
5. 在 hook 层兼容更宽松的 tool input，必要时把模型传错的结构修正成标准 `questions` shape。
6. 为 `GET /questions` 和 `POST /answer` 加单元测试或端到端文件协议测试。
