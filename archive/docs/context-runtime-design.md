# Personal Context Runtime 设计思想

## 一句话总结

我们要做的不是一个普通的知识库，而是一个 **本地优先的 Personal Context Runtime**：让浏览器、Screenpipe、项目文件、Git、Codex/Claude、订阅源、agent 探索结果等 context 自动流入，再通过动态 routing / iii pipes 转成 AI agents 可用的上下文。

核心目标：

> 不是让用户整理知识，而是让用户的真实工作流自动沉淀成 AI 可用的上下文。

当前设计进一步收敛为四句话：

```text
Raw context persists.
Memory is compiled.
Plugins attend differently.
Actions require provenance and permission.
```

---

## 1. 核心原则

### 1.1 先 Capture，再理解

当前阶段不要急着判断什么重要。先记录事实，再做派生理解。

先记录：

- 用户浏览了什么网页
- 屏幕上发生了什么
- 当前 repo 是什么
- Git diff / log 是什么
- Codex / Claude 聊了什么
- terminal 跑了什么
- agent 主动发现了什么资料

后面再派生：

- 当前 focus
- 项目总结
- TODO
- 决策
- session summary
- long-term memory

原则：

```text
Raw observation first, interpretation later.
```

真实使用时，一条 context 不需要在进入系统时就被完全理解。它只需要保留足够的事实、来源、时间、权限和弱关联，之后再被不同插件重新解释。

例如同一个 tweet / blog / Codex 片段，后续可能同时变成：

- 产品设计 insight
- language learning 语料
- research queue item
- project memory
- daily summary evidence

---

### 1.2 不 reinvent the wheel

底层感知不重做。Screenpipe 已经覆盖了很多系统级 capture 能力。

Screenpipe 负责：

- screen
- audio
- OCR
- accessibility
- app/window
- browser URL
- 本地时间线与搜索

我们负责：

- 统一 context schema
- 项目/agent 语义层
- dynamic routing
- context pack
- 给 Codex / Claude / agents 喂上下文

定位：

```text
Screenpipe captures everything.
We decide what matters for agents.
```

---

### 1.3 所有信息统一成 ContextRecord

无论来源是什么，都进入统一结构：

```ts
type ContextRecord = {
  id?: string

  schema: {
    name: string
    version: number
  }

  source: {
    type: string
    id?: string
    connector?: string
  }

  scope?: {
    user?: string
    project?: string
    repo?: string
    app?: string
    session?: string
    domain?: string
  }

  time?: {
    observed_at?: string
    captured_at?: string
  }

  content?: {
    title?: string
    text?: string
    url?: string
    path?: string
  }

  acquisition?: {
    mode?: "passive" | "manual" | "sync" | "agent" | "derived"
    actor?: "user" | "agent" | "connector" | "system"
    task_id?: string
    reason?: string
    query?: string
  }

  signal?: {
    importance?: number
    confidence?: number
    status?: "inbox" | "candidate" | "accepted" | "archived" | "rejected"
  }

  privacy?: {
    level?: "public" | "workspace" | "private" | "secret"
    retention?: "ephemeral" | "normal" | "archive" | "do_not_store"
    allow_embedding?: boolean
    allow_llm_summary?: boolean
    allow_external_llm?: boolean
    allow_external_reader?: boolean
  }

  relations?: {
    derived_from?: string[]
    supersedes?: string[]
    related_to?: string[]
    thread_memberships?: Array<{
      thread_id: string
      confidence: number
      reasons?: string[]
    }>
  }

  validity?: {
    valid_from?: string
    valid_until?: string
    stale_after?: string
  }

  memory?: {
    kind?: "observation" | "episode" | "fact" | "preference" | "todo" | "decision" | "procedure" | "memory_view"
    stability?: "ephemeral" | "session" | "project" | "long_term"
  }

  payload?: Record<string, unknown>
}
```

数据库 schema 保持稳定，具体扩展放进：

```text
schema.name + schema.version + payload
```

这样未来新增来源不需要频繁改数据库结构。

---

## 2. Browser 设计思想

### 2.1 Browser 是 sensor，不是 judge

Browser extension 不应该提前判断“这个页面值不值得保存”。

它应该记录事件流：

```text
observation.browser_page_visit
observation.browser_page_heartbeat
observation.browser_page_snapshot
observation.browser_page_saved
observation.browser_search_query
observation.browser_text_selected
```

后端再决定：

- 是否重要
- 是否读过
- 是否 summarize
- 是否进入长期 memory
- 是否触发 agent

---

### 2.2 Browser event stream

#### `observation.browser_page_visit`

每个页面访问都记录。

记录：

- URL
- title
- domain
- visit_id
- tab_id
- window_id
- opened_at
- transition_reason
- metadata

#### `observation.browser_page_heartbeat`

活跃页面定时记录。

记录：

- visit_id
- dwell_seconds
- active_seconds
- scroll_depth
- scroll_events
- selection_count
- selected_text_length
- visible

#### `observation.browser_page_snapshot`

页面内容快照。

记录：

- visible text
- canonical_url
- selected_text
- scroll_depth
- dwell_seconds
- metadata

#### `observation.browser_page_saved`

用户手动保存，权重最高。

记录：

- full visible text
- selected text
- scroll / dwell signal
- metadata
- manual save reason

---

### 2.3 Jina Reader 是 enrichment，不是替代 browser

`r.jina.ai` 适合公开网页正文抽取。

流程：

```text
browser snapshot / manual save
  ↓
Jina reader enrichment
  ↓
extraction.reader_snapshot
```

但它不能替代 browser，因为它不知道：

- 登录态内容
- 当前 tab
- 停留时间
- scroll depth
- selected text
- 用户真实浏览状态

因此：

```text
Browser knows what user actually viewed.
Jina gets clean public content.
Context Layer combines both.
```

---

## 3. Screenpipe 的角色

Screenpipe 作为底层全局感知层，不重复造轮子。

它补齐：

- 你刚才屏幕上看了什么
- 当前 app/window 是什么
- 浏览器里实际显示了什么
- 会议/音频里说了什么
- OCR/accessibility 文本
- 跨应用活动时间线

在我们的系统里，Screenpipe 是一个 connector：

```json
{
  "schema": {
    "name": "observation.screenpipe_activity",
    "version": 1
  },
  "source": {
    "type": "screenpipe",
    "connector": "local-api"
  },
  "content": {
    "title": "Cursor - context layer",
    "text": "OCR/accessibility/audio transcript...",
    "url": "browser URL if any"
  },
  "payload": {
    "app_name": "Cursor",
    "window_name": "...",
    "content_type": "ocr | audio | accessibility | input",
    "screenpipe_id": "...",
    "timestamp": "..."
  }
}
```

---


## 4. Connector Registry 与 Schema Growth

Connector 不应该写死在系统里。Browser extension、Screenpipe、Codex importer、Obsidian/Notion、Git、tweet-save-agent 都只是不同类型的 context source。

因此系统需要一个 registry：

```text
POST /context/connectors
GET  /context/connectors
POST /context/schemas
POST /context/ingest
```

Connector 注册时声明：

- `id` / `name` / `type`
- 会产生哪些 `schema.name + version`
- 默认 `scope`
- 默认 `privacy`
- 是否允许 network / external reader / external LLM
- 最大可处理隐私级别

示例：agent 驱动的 tweet save connector。

```json
{
  "id": "tweet-save-agent",
  "name": "Tweet Save Agent",
  "type": "agent",
  "schemas_produced": [
    { "name": "observation.social_post_saved", "version": 1 }
  ],
  "default_privacy": {
    "level": "public",
    "retention": "normal",
    "allow_embedding": true,
    "allow_llm_summary": true,
    "allow_external_reader": true,
    "allow_external_llm": false
  },
  "permissions": {
    "allow_network": true,
    "allow_external_reader": true,
    "allow_external_llm": false,
    "max_privacy_level": "public"
  }
}
```

Agent 保存一条 tweet 时，record 需要明确它不是用户手动保存，而是 agent 根据当前 context 判断相关：

```json
{
  "schema": { "name": "observation.social_post_saved", "version": 1 },
  "source": { "type": "social", "connector": "tweet-save-agent" },
  "acquisition": {
    "mode": "agent",
    "actor": "agent",
    "reason": "Relevant to active work thread: personal-context-runtime",
    "query": "personal AI memory context runtime"
  },
  "signal": { "importance": 0.6, "confidence": 0.75, "status": "candidate" },
  "relations": {
    "thread_memberships": [
      {
        "thread_id": "personal-context-runtime",
        "confidence": 0.72,
        "reasons": ["keyword overlap", "agent search goal", "same design session"]
      }
    ]
  }
}
```


### 4.1 Screenpipe 引入边界

Screenpipe 已经拥有 screen/audio/accessibility/OCR/input/timeline/search/MCP/pipes，因此我们不重复造这些底层能力。

我们的接入策略是：

```text
Screenpipe keeps raw perception.
~/info imports references, snippets, summaries, and relations.
```

第一版 connector 只做三件事：

1. 注册 `screenpipe-local-api` connector。
2. 调用 `GET /health` 和 `GET /search` 拉最近 activity。
3. 转成 `observation.screenpipe_activity`，保留 `screenpipe_source_id` 和原始 API result。

不做：

- 不复制所有 screenshot/audio。
- 不直接读 `~/.screenpipe/db.sqlite`。
- 不重做 OCR / accessibility / Whisper。
- 不在 ingest 时强行理解所有 activity。

后续 ContextPack 可以按需查 Screenpipe：

```text
/context/pack(goal, time_window)
  -> query screenpipe /activity-summary 或 /search
  -> include compact evidence + provenance
```

这里的关键不是 tweet 本身，而是它的 provenance：

```text
谁保存的？为什么保存？置信度多少？属于哪个 thread？允许被哪些插件使用？
```

Schema 也应该从这种真实使用里长出来。先有 `payload`，当某类 payload 频繁出现并被多个插件依赖时，再提升成注册 schema。

---

## 5. iii Pipes 与 Dynamic Routing

ContextRecord 进入后，不只是存储，还可以触发 workflow。

示例：

```text
browser_page_saved
→ reader_enrich
→ extraction.reader_snapshot

screenpipe_activity
→ infer_current_focus
→ focus.current

codex_session_end
→ extract_project_memory
→ memory.project

project_session_end
→ generate_project_summary
→ summary.project_session
```

这就是系统真正强的地方：

```text
Right context → Right agent → Right time → Right action
```



## 5.1 Plugin / Skill / View 的边界

后续系统不要把所有能力都写进 core。更清晰的边界是：

```text
Skill = agent runtime 内部如何做某件事
Program = Info runtime 什么时候发起一个用户价值循环
Plugin = 打包和安装形态，不是核心对象
View = program/compiler/agent task 产出的可复用数据结果
```

例如 PDF / YouTube 这类能力，本身通常可以由 agent + skill 完成：

```text
用户问：帮我总结这个 PDF
外部 agent runtime 自己选择 PDF/search/summary skill
当前对话里回答
```

但如果希望它成为持续的个人上下文能力，Info 侧应该包装成 Program 或可安装 plugin，并优先通过通用 AgentTask 边界交给外部 agent runtime：

```text
pdf-research-plugin
  trigger: 发现浏览器访问 .pdf
  submits: AgentTask(context_pack + output_contract)
  external agent runtime owns PDF/search/summary skills
  produces: extraction.pdf_text / paper.summary Views
  writes: ContextStore + RuntimeEvent provenance

注意：这是可安装 plugin 示例，不是默认 runtime 主路径。默认 Browser Ambient 只走 AgentTask + deterministic fallback。
```

也就是说：

```text
Skill 是外部 agent runtime 的执行配方。
Program 是 Info 里的用户价值循环。
Plugin 是产品化、可安装、可配置、可追踪的 packaging。
```

这支持社区生态：

```text
Core Runtime 只定义协议和数据面。
社区提供各种 context plugins。
用户按需安装/启用。
```

例子：

```text
coding-context-plugin
  -> ContextView(work_thread)
  -> ContextView(coding_project_context)

youtube-context-plugin
  -> extraction.video_transcript
  -> video.summary

pdf-research-plugin  // installed/enabled plugin
  -> extraction.pdf_text
  -> paper.summary

meeting-context-plugin
  -> meeting.summary
  -> task.action_items
```

`coding_project_context` 这种东西很有价值，但不应该是所有用户都必须拥有的 core 概念。它更像 coding 用户安装的专属 view compiler plugin。UI 可以按 project 展示它：

```text
/Users/junjie/info
  active work thread
  current project state
  recent browser references
  recent AI sessions
  build/test status
  next actions
```

这样 agent 看到的不再是一堆 raw records，而是：

```text
当前项目 + 当前任务 + 代码状态 + 证据 + 下一步
```

---

## 6. Context Pack 是最终产品

最终不是给 AI 一堆 raw data，而是根据目标动态组装 context pack。

输入：

```json
{
  "goal": "继续实现 browser context layer",
  "scope": {
    "project": "personal-context-system"
  },
  "time_window_minutes": 60,
  "token_budget": 8000
}
```

输出应包含：

- 当前项目
- 最近屏幕活动
- 最近浏览网页
- Jina reader snapshot
- Git diff / log
- Codex / Claude 结论
- TODO / blocker / decisions
- 原始来源 provenance

消费者：

- Codex
- Claude
- ChatGPT
- browser agent
- research agent
- project agent
- tool builder agent

---


## 7. ContextPack v2：按需融合 Screenpipe

ContextPack v2 不再只是读取已经 ingest 的本地 records。它可以在 pack 构建时按需查询 perception backend。

请求示例：

```json
{
  "goal": "继续设计 personal context runtime",
  "limit": 20,
  "token_budget": 4000,
  "time_window": { "minutes": 240 },
  "include_screenpipe": true,
  "screenpipe": {
    "content_type": "all",
    "limit": 8
  }
}
```

构建流程：

```text
1. Search local ContextRecord by goal.
2. Add recent local records in the same time window.
3. If include_screenpipe=true, query Screenpipe /search.
4. Normalize Screenpipe results into transient ContextRecords.
5. Merge, rank by observed_at, clip by token_budget.
6. Return markdown + records + sources + diagnostics.
```

关键点：Screenpipe records 在 pack-time 默认是 transient evidence，不会自动写入我们的 DB。需要长期保存时再通过 `screenpipe:recent` 或更高层 pipe 显式 ingest。

这保持了分工：

```text
Screenpipe = raw perception store
~/info ContextPack = scoped semantic evidence assembly
```

---


## 8. Evidence Graph 与 WorkThread correlation v1

WorkThread 不应该直接从时间线切出来，而应该从多来源证据中浮现。第一版采用 deterministic correlation，不急着让 LLM 判断每条边。

原因：

- 底层关联需要稳定、可解释、可重复。
- 很多强信号不需要 LLM：same repo、same file、same URL、same session、near timestamp。
- LLM 更适合在候选结构之上做命名、总结、模糊判断、split/merge 建议。
- raw screen/audio/browser/project context 默认应本地处理，避免一开始就发送给外部模型。

第一版证据边：

```text
same_repo          +0.40
same_project       +0.35
file_path_overlap  +0.20~0.40
same_url           +0.30
same_domain        +0.15
same_session       +0.30
keyword_overlap    +0.05~0.25
near_timestamp     +0.05~0.15
same_app           +0.05
```

CLI：

```bash
pnpm run correlate:recent
pnpm run correlate:recent -- --write
```

默认只输出候选线程：

```json
{
  "thread_id": "candidate:info-screenpipe-context",
  "title": "Info: screenpipe / context / connector",
  "confidence": 0.72,
  "records": [
    { "id": "...", "score": 0.8, "reasons": ["same project", "keyword overlap"] }
  ],
  "keywords": ["screenpipe", "context", "connector"],
  "reasons": ["same project: info", "near timestamp: 4m"]
}
```

`--write` 会写入 `work_threads` materialized index，并刷新 `work_thread` ContextView。它不会改写原始 records，因此是可逆的。

AI Session Locator 可以作为强 anchor 按需加入 correlation：

```bash
CORRELATE_AI_SESSIONS=1 AI_SESSION_PROJECT=/Users/junjie/info pnpm run correlate:recent
```

这样 correlator 可以把：

```text
ai_session_locator_result + local_project + browser/screenpipe/git evidence
```

归并成更可靠的 candidate WorkThread。

后续可以增加：

```text
CandidateThread -> LLM naming / summary -> user accept/rename/merge/split -> learned policy
```

---

## 9. 项目结束 / Session 复盘当用户结束一段项目工作时，系统可以自动组合多种证据：

```text
Git files/log/diff
+ Claude Code / Codex runtime
+ Browser pages / Jina reader snapshots
+ Screenpipe screen/OCR/app timeline
+ terminal logs
+ GitHub issues/PR
+ manual notes
```

生成：

- 这段时间做了什么
- 改了哪些文件
- 为什么这么改
- 关键设计决策
- 尝试过什么，为什么改方向
- 当前状态
- open TODO
- 下一步建议

示例输出：

```md
# Project Session Summary

## Goal
Build a personal context runtime for AI agents.

## Time Window
2026-05-21 20:53 - 22:15

## What changed
...

## Key Decisions
...

## Evidence
- Git diff
- Browser events
- Screenpipe timeline
- Codex/Claude messages
- Terminal commands

## Open TODOs
...

## Suggested next context pack
...
```

这相当于个人研发黑匣子。

---

## 11. 自主探索与工具生成

当 context 足够丰富后，系统可以进一步变成 context-driven autonomous agent。

它可以根据用户真实工作流自动判断：

- 你现在在做什么
- 你缺什么信息
- 下一步可能需要什么
- 是否需要调研
- 是否需要创建工具
- 是否需要更新 project memory
- 是否需要提醒你

例如：

```text
系统观察到用户反复手动 curl /context/pack
→ 建议或自动生成 contextctl pack 命令

系统观察到每次 browser_page_saved 后都需要 Jina
→ 创建 route: browser_page_saved → pipe::reader_enrich

系统观察到 Codex session 结束后用户总要总结 TODO
→ 创建 route: codex_session_end → pipe::extract_project_memory
```

最终形态：

```text
Context Observer
→ Context Butler
→ Context Builder
```

---

## 12. 隐私架构

这个系统会非常了解用户，所以隐私不是附加功能，而是核心架构。

原则：

```text
Raw data local by default.
Sharing explicit by design.
```

默认策略：

- raw data local
- external sharing explicit
- secret do_not_store
- every record has privacy policy
- every derived output has provenance

必须支持：

- pause capture
- exclude app/domain/folder
- delete last N minutes
- local-only mode
- external policy gate
- secret scanner
- audit log

### Privacy policy 字段

```ts
privacy: {
  level: "public" | "workspace" | "private" | "secret"
  retention: "ephemeral" | "normal" | "archive" | "do_not_store"
  allow_embedding: boolean
  allow_llm_summary: boolean
  allow_external_llm: boolean
  allow_external_reader: boolean
}
```

### 默认级别

| 数据 | 默认级别 |
|---|---|
| 公开网页 | public/private |
| GitHub public repo | public |
| 本地项目文件 | private |
| Codex/Claude 聊天 | private |
| Screenpipe 屏幕/OCR | private/secret |
| 邮件/IM/密码/支付 | secret |
| token/cookie/password | do_not_store |

---

## 13. 总体架构图

```text
┌──────────────────────────────────────────────────────────────────┐
│                         User Digital Life                         │
│                                                                  │
│  Browser     Screen/Audio     Git/Files     AI Chats     Feeds   │
│  Webpages    Apps/OCR         Projects      Codex/Claude RSS/X   │
│  Notes       Saved Posts      Agent Search  Terminal     Papers  │
└─────┬────────────┬──────────────┬──────────────┬────────────┬────┘
      │            │              │              │            │
      ▼            ▼              ▼              ▼            ▼
┌──────────┐ ┌────────────┐ ┌───────────┐ ┌────────────┐ ┌──────────┐
│ Browser  │ │ Screenpipe │ │ Project   │ │ AI Chat    │ │ Agent /  │
│ Extension│ │ Connector  │ │ Connector │ │ Importer   │ │ Feed Conn│
│          │ │            │ │ Git/Files │ │ Codex/Clau │ │ TweetSave│
└────┬─────┘ └─────┬──────┘ └─────┬─────┘ └─────┬──────┘ └────┬─────┘
     │             │              │             │             │
     └─────────────┴──────────────┴─────────────┴─────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │       Connector Registry      │
                    │ POST /context/connectors      │
                    │ schema + permission manifest  │
                    └──────────────┬──────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │       Context Ingest         │
                    │      POST /context/ingest    │
                    └──────────────┬──────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │        ContextRecord         │
                    │ stable envelope + payload    │
                    │ schema + source + relations  │
                    │ privacy + provenance         │
                    └──────────────┬──────────────┘
                                   │
                 ┌─────────────────┴─────────────────┐
                 ▼                                   ▼
      ┌─────────────────────┐             ┌─────────────────────┐
      │ Local Context Store │             │   Artifact Store     │
      │ SQLite / Vector DB  │             │ screenshots/html/pdf │
      └──────────┬──────────┘             └──────────┬──────────┘
                 │                                   │
                 └─────────────────┬─────────────────┘
                                   ▼
                    ┌─────────────────────────────┐
                    │     Privacy / Policy Gate    │
                    │ secret scan / local-only     │
                    │ external sharing rules       │
                    └──────────────┬──────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │        iii Dynamic Pipes     │
                    │                             │
                    │ browser saved → Jina reader │
                    │ screenpipe → current focus  │
                    │ codex end → project memory  │
                    │ session end → summary       │
                    └──────────────┬──────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │       Derived Context        │
                    │ reader_snapshot              │
                    │ current_focus                │
                    │ project_memory               │
                    │ todo / decision / summary    │
                    └──────────────┬──────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │       Context Pack Builder   │
                    │ goal + scope + time window   │
                    │ source-aware + privacy-aware │
                    └──────────────┬──────────────┘
                                   │
                                   ▼
       ┌──────────────────────────────────────────────────────────┐
       │                    AI Agent Consumers                    │
       │                                                          │
       │   Codex      Claude      ChatGPT      Research Agent     │
       │   Debugger   Meeting     Project PM   Tool Builder       │
       └──────────────────────────────────────────────────────────┘
```

---

## 14. 最终形态

这个系统最终会变成：

```text
Personal Context OS
  + Agent Runtime
  + Dynamic Routing Layer
  + Self-evolving Tool Builder
```

它不是普通 RAG：

```text
普通 RAG:
用户问 → 搜索 → 回答
```

而是：

```text
Personal Context Runtime:
事件发生 → 理解 → 路由 → 自动准备/行动
```

核心价值：

> 让 AI agents 不再是盲的，而是始终能理解用户真实工作状态、当前目标、项目历史和下一步行动。

---

## 15. Personal Context Ecology 更新

后续设计总纲见：[`personal-context-ecology.md`](./personal-context-ecology.md)。

核心更新：

```text
ecology = general structures / pattern language / artifact ecology
~/info = personal context runtime implementation
Paperboy = one application scenario on top of this runtime
```

当前系统应该从普通 context layer 升级为：

```text
Capture / Observation
  -> ContextRecord Store
  -> Lightweight Correlation
  -> WorkThread / Episode
  -> App-specific MemoryView
  -> Scoped ContextPack
  -> Plugin Runtime
```

关键思想：

```text
Raw context 是事实层。
Memory 是面向应用目标的压缩视图。
Plugin = attention policy + memory compiler + action surface + permission manifest。
```

## 10. Runtime live workspace resolver

后台 runtime 不把 Screenpipe 当 scheduler，而是把它当 live signal source：

```text
every tick:
  1. query Screenpipe /activity-summary for app/window/browser_url/active minutes
  2. query Screenpipe /elements for lightweight UI text such as paths, package.json, src, git
  3. query /frames/{id}/context for only top 1-2 frames when element hits exist
  4. resolve active workspace from cwd/window/path/url/project hints
  5. use that workspace to locate git/file/AI session evidence
  6. maintain WorkThread and evidence map
```

重要分层：

- `observation.screenpipe_activity_summary`：活动窗口信号，可进入 thread evidence。
- `observation.screenpipe_activity`：Screenpipe search 的最近活动，可作为内容证据。
- `observation.screenpipe_workspace_signal`：只用于 workspace resolver 的低成本 UI/path 信号，默认不进入 WorkThread 内容候选，避免标题变成 `block/frame_id` 这种噪声。

Workspace resolver 当前使用的证据：

- explicit project hint
- runtime fallback workspace（低权重，只是先验）
- Screenpipe active window title matching project name
- `browser_url` 中的 file/path signal
- accessibility/OCR text 中的 `/Users/...`、`~/...`、文件路径
- payload 中的 `cwd/root/project_path/path/file/url/text`
- local project snapshot root
- AI session locator 的 project/time pointer

置信度设计：

```text
fallback       capped low  // 避免 process.cwd() 压过真实当前窗口
active_window  capped high // 当前窗口名和项目名匹配是强 live signal
path_text      capped mid  // OCR/accessibility path 可能重复或有识别错误
```

这样当用户同时开多个项目时，系统不是只按时间切，而是综合：当前窗口活跃时间、路径证据、repo/cwd、AI session pointer、git/file state。多个候选可以共存，active workspace 只是当前最佳判断。


### 10.1 WorkThread evidence filtering

Live workspace resolving 和 WorkThread 内容候选要分开：

```text
workspace signals answer: where am I working?
thread evidence answers: what is this work about?
```

因此 runtime 在 build WorkThread 前会过滤：

- `observation.screenpipe_workspace_signal`：只参与 resolver，不参与 thread title/content。
- different-workspace Screenpipe records：例如当前 active workspace 是 `~/info` 时，`Warp - ecology` / `Warp - primoria` 会被记录在 diagnostics 里，但不会污染当前 thread。
- active workspace 相关的 screenpipe records 会显式 related_to 当前 local project snapshot，用 deterministic evidence graph 连接，而不是靠泛化文件名如 `README.md`。

Diagnostics 中会输出：

```json
{
  "thread_input": {
    "total_records": 51,
    "thread_records": 4,
    "filtered_records": 47,
    "active_workspace": "/Users/junjie/info",
    "filtered_examples": [
      { "title": "Warp - ecology", "reason": "different-workspace" }
    ]
  }
}
```

这对应我们的原则：

```text
Evidence first, deterministic routing first, LLM interpretation later.
```



## 11. Code architecture update: Raw Context + ContextView + Broker

当前代码开始按新的思想收敛：

```text
Raw context is source of truth.
Everything else is a view.
Memory is a durable, purpose-specific compressed view.
Plugins define how to attend, compile, and act.
```

新增核心抽象：

```ts
type ContextView = {
  view_type: string;
  source_records?: string[];
  source_views?: string[];
  compiler?: { id: string; mode?: "deterministic" | "llm" | "hybrid" };
  purpose?: string;
  content?: Record<string, unknown>;
  confidence?: number;
  stability?: "ephemeral" | "session" | "project" | "long_term";
  lossiness?: "none" | "low" | "medium" | "high";
}
```

`ContextView` 统一承载：

- timeline / workspace / workthread display card
- episode / semantic / entity views
- plugin-specific memory views

重要边界：

- `ContextRecord` 是 raw observation envelope。
- `ContextView` 是 derived organization / compression。
- `MemoryView` 不再是特殊数据库，而是一类 durable `ContextView`。
- `WorkThread` 仍保留为 task-continuity view 的高频表，但 thread display 也会写成 `thread.display_card` view。

新增 `ContextBroker`：

```text
POST /context/query
pnpm run context:query -- --plugin language-learning --mode source --sources screenpipe --minutes 30
```

Broker 支持插件跳过 thread：

```text
Thread optional.
Provenance mandatory.
Permission boundary remains mandatory.
```

Thread Interpreter 也被重新收敛为 display compiler：

```json
{
  "display_title": "...",
  "brief": "...",
  "confidence": 0.85
}
```

它不再输出不可靠的 `tags` / `next_steps`。如果未来需要 open loops，必须 evidence-backed，由专门 plugin/view compiler 产生。

## 12. Plugin v0: language-learning

第一条 plugin 闭环已经落到代码：

```text
PluginManifest → ContextBroker query → deterministic compiler → ContextView memory
```

文件：

```text
plugins/language-learning/plugin.json
src/plugins.ts
src/context-broker.ts
src/language-learning.ts
scripts/plugin-language.ts
```

运行：

```bash
pnpm run plugin:language -- --days 7 --limit 100
```

它验证了一个重要原则：

```text
Language learning plugin does not require WorkThread.
```

它通过 manifest 声明 attention policy：

```text
sources: browser, screenpipe, ai_chat, reader, local_project
schemas: browser snapshots/saves/selections, screenpipe activity, ai_chat, reader snapshot
```

然后编译两个 `ContextView`：

```text
memory.language.vocabulary_exposure
memory.language.learning_pack
```

当前 v0 是本地 deterministic compiler，不使用外部 LLM，只做 recent English exposure 的词频、例句和 story prompt。后续可以把它升级为 hybrid compiler，但仍然要保持：

```text
source_records present
thread optional
external_llm gated by plugin permissions
```

### 12.1 Attention signals: selection/copy

Language learning 不只需要页面全文，还需要用户真实 attention signal。当前实现：

Browser extension content script：

```text
selectionchange → observation.browser_text_selected
copy            → observation.browser_text_copied
```

记录：

```text
selected_text
surrounding_text
url / canonical_url / title / domain
page_language
scroll_depth
viewport rect
tag
attention_signal / attention_weight
```

Screenpipe 侧也尝试拉取：

```text
/search?content_type=input → observation.screenpipe_input_event
```

分工：

```text
Screenpipe input event = action/time/app/window evidence
Browser extension      = precise selected/copied text + DOM context
```

Language plugin v0 对不同 schema 加权：

```text
browser_text_copied     highest
browser_text_selected   high
browser_page_saved      high
reader_snapshot         medium
screenpipe_input_event  medium
screenpipe_activity     lower
```

这体现了：

```text
Full markdown tells what the page contains.
Selection/copy tells what the user attended to.
```


### 12.2 Browser semantic signals: search, save reason, language quality

Browser extension 继续增强三类高价值信号：

```text
search query        → observation.browser_search_query
manual save reason  → payload.manual_save_reason
page language/quality → payload.text_quality
```

`browser_search_query` 解析常见搜索 URL：

```text
google q
bing q
duckduckgo q
baidu wd
perplexity q
github /search?q
youtube /results?search_query
```

manual save popup 现在允许用户输入：

```text
Why is this page useful?
```

保存进 `observation.browser_page_saved.payload.manual_save_reason`。

content script 也会估算文本质量：

```text
detected_language
english_ratio
word_count
char_count
sentence_count
repeated_ratio
quality_score
```

Language plugin 使用这些信号调权：

```text
search query = high intent
manual save reason = explicit user intent
text_quality = corpus quality filter/ranking signal
```

这让 language/research plugin 不只是知道“页面有什么”，也能知道：

```text
用户主动搜索了什么
用户为什么保存
这段文本是否适合做语料
```

## 13. Runtime Event Log 与 Observation Timeline View

现在系统里有两条不同但互补的时间线：

```text
ContextRecord timeline     = 用户/环境发生了什么
RuntimeEvent log           = 系统对这些 context 做了什么
```

### 13.1 Runtime Event Log

`RuntimeEvent` 是 append-only provenance log，不是用户记忆本身。

它记录系统动作，例如：

```text
record_ingested
context_query_completed
view_upserted
timeline_view_compiled
plugin_run_started
plugin_run_completed
runtime_tick_completed
thread_interpreted
```

用途：

- debug：为什么某个 memory/view 出现了？
- provenance：某个 plugin 用了哪些 records / views？
- replay：之后可以重跑某个 compiler 或 plugin。
- permission/audit：外部 LLM、外部 reader、插件动作都应该有事件痕迹。

但它不替代 raw observation：

```text
ContextRecord = source of truth about user/world.
RuntimeEvent  = source of truth about system behavior.
```

当前入口：

```bash
pnpm run runtime:events -- --limit 50
pnpm run runtime:events -- --type view_upserted
pnpm run runtime:events -- --plugin language-learning
```

HTTP：

```text
GET  /runtime/events
POST /runtime/events
```

iii worker：

```text
runtime::event_append
runtime::events
POST /runtime/events
POST /runtime/events/query
```

### 13.2 Observation Timeline View

`timeline.observations` 是基于 raw `ContextRecord` 编译出来的 `ContextView`。

它不是新的 raw data，而是一个导航视图：

```text
raw records in time window
  -> bucket by time
  -> summarize sources/schemas/sample titles
  -> preserve source_records back-links
```

用途：

- 快速看最近一段时间发生了什么。
- 给 daily summary / research / language plugin 提供候选上下文。
- 给 WorkThread split/merge 提供时间邻近证据。
- 给用户或 agent 定位“某个时间段我在干嘛”。

当前入口：

```bash
pnpm run timeline -- --minutes 1440 --limit 100 --dry-run
pnpm run timeline -- --minutes 1440 --limit 100
```

HTTP：

```text
POST /timeline/observations/compile
```

iii worker：

```text
timeline::observations_compile
POST /timeline/observations/compile
```

设计边界：

```text
Observation timeline is a view.
Runtime event log is provenance.
Neither replaces raw ContextRecord.
```

### 13.3 Broker can include provenance events

`ContextBroker` 现在不仅可以返回 records/views，也可以按需返回 runtime events：

```bash
pnpm run context:query -- --events --no-records --no-views --event-types timeline_view_compiled,plugin_run_completed --limit 10
```

这让 plugin/agent 能用同一个 broker API 查询：

```text
What raw evidence exists?       -> records
What derived views exist?       -> views
What did the system do with it? -> events
```

默认仍然不返回 events，因为 runtime event 是 provenance，不是大多数 plugin 的主语料。需要时显式开启：

```text
include_events: true
```

Plugin manifest 也可以限制能看的事件类型：

```text
permissions.allowed_event_types
```

### 13.4 Daemon-maintained timeline

Runtime daemon 现在可以周期性维护 observation timeline view：

```bash
pnpm run daemon -- --timeline --timeline-interval 300 --timeline-minutes 1440 --timeline-limit 200
```

这样 timeline 不需要用户手动编译。后台 tick 会：

```text
runtimeTick
  -> update active workspace/thread
  -> optional interpret active thread
  -> optional compile timeline.observations
  -> write runtime event provenance
```

这更符合当前产品方向：

```text
capture happens continuously
views are compiled continuously
plugins consume broker packs when needed
```
