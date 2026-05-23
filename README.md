# Personal Context Layer v0

极简 context layer：所有来源统一写入 `ContextRecord`，SQLite 保存，按 goal 生成 context pack。

## 设计

- `ContextRecord`: stable envelope + flexible `payload`
- `ContextArtifact`: 截图/PDF/HTML/audio 等大文件引用
- `ContextSchema`: versioned schema registry，方便动态演化 schema
- `ContextConnector`: runtime connector registry，方便 browser/screenpipe/git/notes/agent 等来源动态接入

核心思路：数据库 schema 尽量稳定，具体来源差异放进 `schema.name + schema.version + payload`。

产品原则：

```text
Raw context persists.
Memory is compiled.
Plugins attend differently.
Actions require provenance and permission.
```

## API

- `POST /context/ingest`
- `GET /context/recent`
- `POST /context/search`
- `POST /context/pack`
- `POST /context/artifacts`
- `POST /context/schemas`
- `POST /context/connectors`
- `GET /context/connectors`

## 快速运行：standalone HTTP

不依赖 iii engine，方便 browser extension 先接入：

```bash
pnpm install
pnpm run http
```

默认地址：`http://localhost:3111`。

## 运行 iii worker

```bash
pnpm run dev
```

需要本地 iii engine 在 `ws://localhost:49134`，或设置：

```bash
III_ENGINE_URL=ws://host:port pnpm run dev
```

## 本地 smoke test

```bash
pnpm run test:ingest
pnpm run local-project:once
pnpm run agent-discovery:example
pnpm run tweet-save:example
pnpm run screenpipe:recent
pnpm run test:pack
pnpm run test:pack:v2
pnpm run correlate:recent
pnpm run ai-session:locate
pnpm run thread -- list
pnpm run episode:summary -- <thread_id>
```

## Browser Extension

`browser-extension/` 是 Chrome MV3 草稿：点击扩展按钮后采集当前页面 title/url/正文/选中文本/scroll depth/dwell time，并写入 `/context/ingest`。

Chrome 加载方式：

1. 打开 `chrome://extensions`
2. 开启 Developer mode
3. Load unpacked
4. 选择 `browser-extension/`

## 已有 connector 草稿

- `browser-extension/`: 当前页面 context，是 web semantic sensor
- Screenpipe connector：计划接入，属于 ambient sensor，负责 screen/OCR/accessibility/audio/UI events
- `scripts/local-project-once.ts`: 当前 git repo / branch / status / diff / README / AGENTS
- `scripts/screenshot-once.ts`: macOS screenshot artifact + active app/window metadata
- Codex / Claude Code importer：计划接入，属于 reasoning/session sensor
- Obsidian / Notion / local notes：计划接入，属于 explicit knowledge sensor
- `scripts/agent-discovery-example.ts`: agent 主动发现信息的候选 context
- `scripts/tweet-save-example.ts`: agent 主动保存和当前 WorkThread 相关的 tweet/post/article
- `scripts/screenpipe-recent.ts`: 从 Screenpipe local API (`localhost:3030`) 拉取 recent activity 引用和文本片段

Connector 可以在运行时注册。它声明自己会产生哪些 schema、默认 privacy、是否允许 network/external reader/external LLM。





## AI Session Locator

`ai-session:locate` 用来按 `project_path + time_window` 定位 Codex / Claude Code session。它不是 importer：默认不导入完整 transcript，只输出 metadata/reference。

```bash
pnpm run ai-session:locate -- --project /Users/junjie/info --minutes 240
AI_SESSION_PROJECT=/Users/junjie/info AI_SESSION_MINUTES=240 pnpm run ai-session:locate
pnpm run thread -- list
pnpm run episode:summary -- <thread_id>
```

可选写入 locator result：

```bash
pnpm run ai-session:locate -- --project /Users/junjie/info --minutes 240 --write
```

写入的是：

```text
observation.ai_session_locator_result
```

包含 session id、time range、cwd、files touched、commands、source_uri、confidence、reasons；不包含完整 transcript。

ContextPack v2 也可以按需融合 AI session evidence：

```bash
CONTEXT_PACK_AI_SESSIONS=1 AI_SESSION_PROJECT=/Users/junjie/info pnpm run test:pack:v2
```


## WorkThread / Episode v0

`correlate:recent --write` 现在会同时写入：

- `episode.candidate_thread` ContextRecord
- `work_threads` 表里的 candidate WorkThread

常用命令：

```bash
pnpm run thread -- list
pnpm run thread -- list candidate
pnpm run thread -- accept <thread_id> "New title"
pnpm run thread -- reject <thread_id>
pnpm run thread -- rename <thread_id> "Better title"
```

基于 thread 构建 deterministic episode summary：

```bash
pnpm run episode:summary -- <thread_id>
pnpm run episode:summary -- <thread_id> --write
```

`--write` 会写入：

```text
episode.project_work
```

ContextPack v2 现在也支持 `thread_id`，会优先纳入该 thread 的 evidence records。

## WorkThread correlation v1

第一版 correlation 是 deterministic evidence graph，不默认调用 LLM：

```bash
pnpm run correlate:recent
pnpm run ai-session:locate
pnpm run thread -- list
pnpm run episode:summary -- <thread_id>
CORRELATE_LIMIT=120 CORRELATE_MIN_SCORE=0.45 pnpm run correlate:recent
pnpm run ai-session:locate
pnpm run thread -- list
pnpm run episode:summary -- <thread_id>
```

默认只输出候选 WorkThread，不修改原始 records。确认合理后可以写入候选 episode：

```bash
pnpm run correlate:recent -- --write
```

当前规则信号：

- same repo / project / path
- file path overlap
- same URL / domain
- same session
- keyword overlap
- near timestamp
- same app

默认先排除 social/tweet-save 这类 feed 噪声；需要纳入时设置：

```bash
CORRELATE_INCLUDE_SOCIAL=1 pnpm run correlate:recent
pnpm run ai-session:locate
pnpm run thread -- list
pnpm run episode:summary -- <thread_id>
```

输出包括 `confidence`、`records`、`keywords`、`domains`、`apps` 和可解释 `reasons`。LLM 后续只应该用于命名、总结、split/merge 建议和模糊判断，而不是替代底层事实边。

## ContextPack v2

`/context/pack` 现在支持时间窗口和按需 Screenpipe evidence：

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

行为：

- 先从本地 `ContextRecord` 搜索 goal 相关记录。
- 再取同一时间窗口内的 recent records。
- 如果启用 `include_screenpipe`，则按需调用 Screenpipe `/search`。 
- Screenpipe raw media 仍留在 Screenpipe，本项目只把结果作为 pack-time evidence 合并，不默认持久化。
- `pack.sources` 和 markdown 中保留 provenance。

CLI 示例：

```bash
pnpm run test:pack:v2
pnpm run correlate:recent
pnpm run ai-session:locate
pnpm run thread -- list
pnpm run episode:summary -- <thread_id>
CONTEXT_PACK_SCREENPIPE=1 SCREENPIPE_API_KEY=... pnpm run test:pack:v2
pnpm run correlate:recent
pnpm run ai-session:locate
pnpm run thread -- list
pnpm run episode:summary -- <thread_id>
```

## Screenpipe 接入

Screenpipe 不作为被复制的数据库，而作为本地 perception store：

```text
Screenpipe 保存 raw screenshots/audio/accessibility/OCR/input events。
本项目保存 normalized ContextRecord、source references、relations、MemoryView。
```

快速导入最近 Screenpipe activity：

```bash
pnpm run screenpipe:recent
SCREENPIPE_LIMIT=50 SCREENPIPE_CONTENT_TYPE=accessibility pnpm run screenpipe:recent
SCREENPIPE_QUERY=screenpipe pnpm run screenpipe:recent
```

默认读取 `http://localhost:3030`，可用 `SCREENPIPE_URL` 覆盖。如果 Screenpipe 开启 API auth，需要设置 `SCREENPIPE_API_KEY`。

## Runtime Tick v0

`runtime:tick` 是第一版后台运行单元：把之前手动的 `screenpipe → workspace → git/project → AI sessions → correlation → WorkThread` 串成一次 deterministic tick。

```bash
pnpm run runtime:tick -- --project /Users/junjie/info --window 10
pnpm run runtime:tick -- --project /Users/junjie/info --window 10 --dry-run
pnpm run runtime:tick -- --project /Users/junjie/info --window 10 --no-screenpipe
pnpm run daemon -- --project /Users/junjie/info --interval 30 --window 10
pnpm run daemon -- --project /Users/junjie/info --interval 30 --window 10 --interpret
pnpm run runtime:status
pnpm run thread:interpret -- active
pnpm run thread:interpret -- <thread_id>
pnpm run thread -- evidence active
pnpm run thread -- evidence:write active
```

行为：

- 从最近 `ContextRecord` 和可选 Screenpipe activity 推断 active workspace。
- 对 active workspace 写入 `observation.local_project` 快照。
- 定位相关 Codex / Claude Code session，写入 `observation.ai_session_locator_result` metadata 引用。
- 构建候选 WorkThread，写入 `episode.candidate_thread` 和 `work_threads`。
- 不复制 Screenpipe raw media，也不导入完整 AI transcript。

HTTP 入口：

```bash
curl -X POST http://localhost:3111/runtime/tick \
  -H "Content-Type: application/json" \
  -d '{"project":"/Users/junjie/info","window_minutes":10}'

curl http://localhost:3111/runtime/status

curl -X POST http://localhost:3111/thread/interpret \
  -H "Content-Type: application/json" \
  -d '{"thread_id":"active"}'

curl "http://localhost:3111/thread/evidence?thread_id=active"
```

Daemon 会维护 `runtime_state`：

- `last_tick`: 最近一次 tick 的 workspace、top thread、节流状态和 evidence 统计。
- `active_thread`: 当前最可能的 active WorkThread、confidence、project、last_seen_at。

默认有节流：project snapshot 120 秒一次，AI session scan 60 秒一次。可用 `--force` 强制本次 tick 全量执行。

Daemon 默认不调用 LLM。需要低频解释 active thread 时加：

```bash
pnpm run daemon -- --project /Users/junjie/info --interpret --interpret-interval 300
```

它会在 active thread 从未解释、解释过期或 evidence 明显增长时调用 Thread Interpreter。

## Thread Interpreter / LLM

Thread Interpreter 使用 OpenAI-compatible chat completion，把 deterministic WorkThread evidence 转成更自然的标题、摘要、next steps 和 tags。

默认优先本地 OpenAI-compatible endpoint：

```bash
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=qwen2.5:7b
```

外部 LLM 默认禁用；如需 OpenAI-compatible 云端模型：

```bash
ALLOW_EXTERNAL_LLM=1 LLM_BASE_URL=https://api.openai.com/v1 LLM_API_KEY=... LLM_MODEL=gpt-4.1-mini pnpm run thread:interpret -- active
```

解释结果会：

- 写入 `episode.thread_interpretation`
- 更新 `work_threads.metadata.display_title / llm_summary / llm_next_steps / llm_tags`
- 默认把 `work_threads.title` 更新为 LLM 标题

## Thread Evidence Map

WorkThread 不只是标题，而是相关 context/info/artifact 的 provenance index。可生成：

```bash
pnpm run thread -- evidence active
pnpm run thread -- evidence:write active
```

它会把 thread 关联到：

- `context://...` ContextRecord
- `file://...` 项目文件 / AI session JSONL pointer
- `git://...` 本地项目状态
- `screenpipe://frame/...` / `screenpipe://audio/...` Screenpipe raw media pointer
- `https://...` browser/source URL
- `runtime://work_threads/...` runtime 状态

结果写入 `work_threads.metadata.evidence_map` 和 `metadata.evidence_refs`，供后续 Memory Compiler / Agent 使用。

## Screenshot 说明

```bash
pnpm run screenshot:once
```

macOS 需要给 Terminal/iTerm/VS Code 授权 Screen Recording。截图默认作为 `ContextArtifact` 存在，record 只保存 active app、window title 和 artifact 引用。

## 设计文档

- [`docs/context-runtime-design.md`](docs/context-runtime-design.md): 当前实现设计
- [`docs/personal-context-ecology.md`](docs/personal-context-ecology.md): Paperboy / Screenpipe / plugin ecology 总体思想
