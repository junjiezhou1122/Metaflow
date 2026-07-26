# Feature: Workflow Crystallization（工作流结晶）

## 目标

Info Runtime 不应该一开始把所有场景都硬编码成规则，也不应该永远依赖 agent 从零探索。

我们采用 **Workflow Crystallization**：

```text
Agent 先探索未知路径
  -> 记录实际工具调用和结果
  -> 成功路径沉淀为可验证 workflow/recipe
  -> 下次同类任务优先 deterministic 执行
  -> deterministic 失败时回退给 agent 再探索
  -> 新成功路径继续更新 workflow
```

一句话：

> Agent 是 scout，workflow 是沉淀下来的路，runtime 是能执行和更新这些路的系统。

这个机制适用于 source acquisition、context retrieval、program routing、project workflow、daily summary、language learning 等多个层面。第一阶段先在 **Browser + Screenpipe** 这条 vertical slice 里落地。

---

## 为什么需要这个 feature

### 纯规则的问题

如果一开始写死：

```text
if youtube -> opencli
if pdf -> llamaparse
if github -> gh api
if docs page -> jina
```

系统会快速变复杂，并且规则会过期。

### 纯 agent 的问题

如果每次都让 agent 自己探索：

```text
请你想办法获取这个 URL 的内容
```

系统会慢、贵、不稳定，并且同样的成功经验不能复用。

### 工作流结晶的折中

```text
第一次灵活探索
后续固定复用
失败自动重新探索
成功路径持续沉淀
```

这符合 personal proactive agent 的长期形态：系统不是靠一次性配置变强，而是在使用中形成稳定工作流。

---

## 核心概念

### Raw Observation

事实输入，不包含智能判断。

当前第一阶段主要来自：

```text
observation.browser.saved
observation.browser.page_snapshot
observation.screenpipe.activity_summary
```

例子：

```json
{
  "schema": { "name": "observation.browser.saved", "version": 1 },
  "source": { "type": "browser", "connector": "chrome-extension" },
  "content": {
    "url": "https://www.youtube.com/watch?v=WRibE2nt8wM",
    "title": "Lecture 1: Introduction to Individual Decision-Making - YouTube",
    "note": "useful for agent runtime design"
  }
}
```

### View

所有加工结果都是 View，包括 attention、content、analysis、workflow trace、workflow recipe。

```text
raw information -> process -> view
```

Attention 不是特殊核心对象，只是 View 的一种。

### Workflow Trace

一次 agent/tool 实际执行过程的结构化记录。

```json
{
  "view_type": "workflow.trace",
  "content": {
    "task": "Acquire YouTube transcript",
    "source": {
      "type": "url",
      "url": "https://www.youtube.com/watch?v=WRibE2nt8wM"
    },
    "steps": [
      {
        "tool": "opencli",
        "command_template": "opencli youtube transcript {{url}} -f json",
        "status": "failed",
        "error": "Caption URL returned empty response"
      },
      {
        "tool": "opencli",
        "command_template": "opencli youtube transcript {{url}} --mode raw -f json",
        "status": "success",
        "produces": ["transcript"]
      }
    ]
  }
}
```

### Workflow Recipe

从成功 trace 中沉淀出来的可执行工作流。

```json
{
  "view_type": "workflow.recipe",
  "content": {
    "name": "Acquire YouTube video metadata and transcript",
    "match": {
      "source_type": "url",
      "domain": "youtube.com",
      "path_pattern": "/watch"
    },
    "steps": [
      {
        "kind": "command",
        "tool": "opencli",
        "args_template": ["youtube", "video", "{{url}}", "-f", "json"],
        "produces": ["metadata"]
      },
      {
        "kind": "command",
        "tool": "opencli",
        "args_template": ["youtube", "transcript", "{{url}}", "--mode", "raw", "-f", "json"],
        "produces": ["transcript"]
      }
    ],
    "validation": {
      "required_outputs": ["metadata.title"],
      "optional_outputs": ["transcript[0].text"],
      "min_text_length": 500
    },
    "state": "candidate",
    "confidence": 0.65,
    "success_count": 1,
    "failure_count": 0
  }
}
```

### Workflow Attempt

每次 recipe deterministic 执行的结果。

```json
{
  "view_type": "workflow.attempt",
  "content": {
    "recipe_id": "workflow.recipe:youtube-transcript",
    "source_url": "https://www.youtube.com/watch?v=...",
    "status": "success",
    "latency_ms": 3200,
    "output_views": ["source.content:..."]
  }
}
```

---

## 第一阶段：Browser + Screenpipe vertical slice

当前先不要一次性接入所有信息源。第一阶段只以两个主 sensor 打通产品闭环：

```text
Browser Extension
Screenpipe
```

其他信息源，如 git、GitHub issue、AI 会话记录、代码文件、外部网页搜索，先作为 agent/tool 按需获取。后续如果稳定有用，再通过 workflow crystallization 固化。

### Browser Extension 的职责

Browser Extension 是显式网页上下文 sensor。

它提供：

```text
current URL
title
DOM text
selected text
user note
explicit Save signal
```

它只写 raw observation，不直接 orchestrate agent。

### Screenpipe 的职责

Screenpipe 是 ambient activity sensor。

它提供：

```text
app dwell
window dwell
browser_url dwell
screen text / OCR / accessibility
UI events
audio transcript
frame/audio references
```

第一阶段优先写：

```text
observation.screenpipe.activity_summary
```

### 第一阶段闭环

```text
Browser Save / Screenpipe dwell
  -> observation.browser.saved / observation.screenpipe.activity_summary
  -> view.context.current
  -> source acquisition
  -> view.source.content
  -> agent analysis
  -> view.browser.analysis
  -> view.workthread.detected
  -> view.daily.summary
```

---

## Source acquisition 的结晶流程

Source acquisition 是第一阶段最适合落地 workflow crystallization 的地方。

### Runtime 执行顺序

```text
Need source content
  -> 查找 matching workflow.recipe
  -> 如果存在 active/candidate recipe：先 deterministic 执行
      -> 成功：写 view.source.content + workflow.attempt(success)，增强 recipe confidence
      -> 失败：写 workflow.attempt(failed)，降低 confidence，fallback agent
  -> 如果无 recipe 或 recipe 失败：交给 AgentTask 探索
      -> agent 成功：写 view.source.content + workflow.trace
      -> recipe compiler 从 trace 生成/更新 workflow.recipe
```

### Bootstrap tool ladder

系统可以有一组初始工具 ladder，但它只是 bootstrap，不是最终知识。

普通网页：

```text
1. Jina reader
2. Firecrawl scrape
3. Browser DOM / reader mode
4. Agent exploration
```

YouTube：

```text
1. opencli youtube video <url> -f json
2. opencli youtube transcript <url> --mode raw -f json
3. yt-dlp captions / browser extraction
4. Agent exploration
```

PDF：

```text
1. Jina reader
2. pdftotext / local parser
3. LlamaParse
4. Agent exploration
```

GitHub：

```text
1. gh api
2. GitHub REST
3. Browser/opencli extraction
4. Agent exploration
```

这些 ladder 后续也可以被 recipe 更新替换。

---

## Attention 也只是 View 的一种

用户主动 Save 是强 attention signal。

Screenpipe dwell 是隐式 attention signal。

但不要把 attention 做成固定规则，例如：

```text
dwell > 1min -> always analyze
```

更好的方式：

```text
browser save
screenpipe dwell
repeat visits
project relevance
workflow transition
user feedback
```

共同生成：

```text
view.context.current
或 view.attention.current
```

第一阶段可以先把 attention 放进 `view.context.current`，避免过早拆太多概念。

例子：

```json
{
  "view_type": "context.current",
  "content": {
    "time_range": { "start": "...", "end": "..." },
    "top_targets": [
      {
        "type": "project",
        "id": "/Users/junjie/info",
        "label": "Info Runtime",
        "score": 0.93,
        "evidence": ["Warp/info active 66m", "Browser Save: Screenpipe docs"]
      },
      {
        "type": "url",
        "id": "https://www.youtube.com/watch?v=WRibE2nt8wM",
        "label": "MIT Game Theory Lecture 1",
        "score": 0.82,
        "evidence": ["explicit Save", "YouTube dwell > 1m"]
      }
    ]
  }
}
```

---

## Memory 的位置

高 attention 不等于 memory。

区分三层：

```text
view.source.content   = 获取到的材料
view.browser.analysis = 当前分析理解
memory.*              = 长期稳定知识/偏好/项目原则
```

进入 memory 的条件应该更严格：

```text
用户明确说“记住”
多次重复出现
被项目实际使用
用户反馈 useful
形成长期偏好或项目决策
```

Workflow recipe 也不是普通 memory；它是可执行的 operational View。它可以长期存在，但需要 success/failure 更新 confidence。

---

## 状态和生命周期

Workflow recipe 不应该一次成功就永久有效。

建议状态：

```text
candidate  初次成功，低/中 confidence
active     多次成功，优先 deterministic 执行
deprecated 多次失败或工具过期
rejected   用户或系统明确否定
```

Confidence 更新：

```text
success -> success_count + 1, confidence up
failure -> failure_count + 1, confidence down
agent found better path -> old recipe deprecated or lowered priority
```

---

## Scope

Workflow recipe 必须有 scope。

```json
{
  "scope": {
    "global": true,
    "domain": "youtube.com",
    "project_path": "/Users/junjie/info",
    "plugin_id": "language-learning"
  }
}
```

例子：

```text
YouTube transcript recipe -> domain/global scoped
Info repo test command -> project scoped
Language learning material generation -> plugin/user scoped
```

---

## AgentTask 输出约定

为了让系统从 agent 探索中学习，AgentTask 应该可以返回 acquisition/workflow trace。

分析类输出仍然禁止 next action / task plan / diffs，但允许描述已执行的 read-only acquisition trace。

建议 shape：

```json
{
  "summary": "string",
  "analysis": "string",
  "key_points": ["string"],
  "confidence": 0.8,
  "workflow_trace": {
    "task": "Acquire source content",
    "steps": [
      {
        "tool": "opencli",
        "command_template": "opencli youtube transcript {{url}} --mode raw -f json",
        "status": "success",
        "produces": ["transcript"]
      }
    ]
  }
}
```

注意：trace 记录的是已经发生的工具执行，不是要求未来执行的 plan。

---

## 第一版实现建议

### 1. 文档先行

本文件作为 feature spec 维护。

### 2. 最小数据类型

先支持：

```text
view.workflow.trace
view.workflow.recipe
view.workflow.attempt
view.source.content
view.context.current
```

### 3. 最小 runtime

先只做 source acquisition：

```text
URL input
  -> recipe match
  -> deterministic execute if possible
  -> fallback AgentTask
  -> write trace/recipe/content Views
```

### 4. Browser + Screenpipe 接入

```text
Browser Save -> strong source acquisition trigger
Screenpipe dwell > threshold -> weak/source acquisition candidate
```

### 5. 不急着接 AI logs / GitHub / Calendar

这些先作为 AgentTask on-demand 工具。等某类路径稳定后，再通过 recipe 固化。

---

## 设计原则

1. **Everything starts flexible.** 先让 agent 探索。
2. **Useful paths crystallize.** 成功路径沉淀成 workflow recipe。
3. **Deterministic first when known.** 已知路径优先固定执行。
4. **Agent fallback when stale.** 固定路径失败时回到 agent。
5. **Views, not hidden state.** trace/recipe/attempt/content 都是可查询 View。
6. **Scope matters.** workflow 可 global/domain/project/plugin scoped。
7. **Success/failure updates confidence.** recipe 会演化，不是永久规则。
8. **Raw observations stay factual.** raw 只记录 sensor 事实。
9. **Agent owns tools; Info owns boundary.** Info 提供 task/context/output contract，外部 agent/tool runtime 自己探索。
10. **Do not over-generalize first.** 第一阶段只打通 Browser + Screenpipe vertical slice。

---

## 当前例子：YouTube transcript

实际发现：

```text
opencli youtube transcript <url> -f json
  -> failed: Caption URL returned empty response

opencli youtube transcript <url> --mode raw -f json
  -> success: returned auto-caption transcript segments
```

这应该沉淀为：

```text
workflow.recipe: youtube transcript acquisition
```

下次遇到 YouTube URL：

```text
先 deterministic 执行 opencli video + transcript --mode raw
失败再交给 AgentTask 探索其他方式
```

这就是工作流结晶的第一个真实案例。
