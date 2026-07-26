# Metaflow mac

Native notch UI for the current Metaflow direct-assist slice.

```text
hold Right Option, release to send, or submit a typed prompt
  -> freeze current Accessibility context
  -> Doubao realtime ASR for voice
  -> POST /ambient/v1/assist
  -> resident Claude Code ACP conversation
  -> streaming Markdown answer in the notch
```

This path is intentionally thin. It does not create or retrieve Views, invoke
Automation, poll Delivery, submit Feedback, or register MCP tools. The daemon
keeps one Claude Code ACP process resident and maps each notch `conversation_id`
to its own resident session. Claude uses its native ACP tools and receives no
Metaflow MCP servers. Pi RPC remains available as a lazily started alternative.
The voice shortcut is configurable from the Metaflow menu; a custom key
combination also uses hold-to-talk.
The same Settings window selects the direct conversation harness and Pi
provider/model. Current harness choices are Pi RPC and Claude Code ACP.

## Configuration

The app reads process environment first, then `.env` files in this order:

1. `METAFLOW_ENV_FILE`
2. `.env` found from the current directory upward
3. `~/.config/metaflow/.env`
4. `~/.hermes/.env`
5. `~/agent/ambient/.env` during migration from the old Ambient app

Doubao ASR requires either `VOLCENGINE_ASR_APP_KEY`, or both
`VOLCENGINE_ASR_API_KEY` and `VOLCENGINE_ASR_APP_ID`. Missing configuration is
an explicit error; there is no Apple Speech fallback.

The daemon endpoint defaults to `http://localhost:3112` and can be changed with
`METAFLOW_AMBIENT_ENDPOINT`.

## Run

Start the TypeScript daemon. Direct assist uses Claude Code ACP by default:

```bash
CONTEXT_HTTP_PORT=3112 \
corepack pnpm ambient:daemon
```

Optionally configure the Pi alternative with `METAFLOW_PI_COMMAND`, `METAFLOW_PI_PROVIDER`,
`METAFLOW_PI_MODEL`, `METAFLOW_PI_THINKING`, and optional comma-separated
`METAFLOW_PI_TOOLS`. The selected Pi model must declare image input support in
the active Pi model catalog. MiniMax and other text-only models still receive
Accessibility text but are rejected when the request includes a screenshot;
there is no silent image drop. The direct notch path sends no MCP servers and
does not use Views or AgentTask output contracts.

Assistant responses use `swift-markdown-ui` for block-level CommonMark
rendering. Headings, paragraphs, lists, links, code, and tables therefore keep
their structure while streamed text updates the current message.
Text-only turns begin streaming after a short tool-detection buffer. If the
Agent invokes tools, the notch replaces provisional prose with a live bounded
tool timeline and shows the complete answer only when the turn finishes. Raw
tool arguments and results remain out of the UI stream.
Progress never opens a docked notch. Typed turns submitted while expanded can be
watched live; voice turns and manually docked in-progress turns remain docked
until terminal success or failure.

The conversation title in the expanded header opens locally persisted chat
history; the adjacent compose icon starts a new conversation. Each conversation
owns its messages, stream buffer, tool activity, and sending state, so a long
turn can continue while another conversation is opened or used. Request events
are always routed back by their frozen `conversation_id`; a background result
updates its history without stealing the visible conversation. On launch the
most recently updated conversation is selected. Voice uses that current default,
and starts a new conversation when the selected one is already working.
Conversation navigation uses an in-panel switcher rather than a separate native
popover window. Selection therefore does not wait for AppKit's popover-close
animation before swapping content. The switcher closes before the conversation
changes and lazily materializes message rows. Every assistant message caches its parsed
`MarkdownContent`, so selecting a long conversation does not reparse the full
history. Selection commits immediately, then top-anchored panel resizing runs on
the next main-loop turn so SwiftUI can diff the new conversation before AppKit
lays out the changed window height. Switching still adapts in both directions
between short and long histories without combining both expensive operations in
one click transaction. It swaps the conversation without a content transition
and uses static picker timestamps instead of a live relative-time timeline.
Streaming deltas are coalesced to at most one visible Markdown update every 50
ms, while completion always flushes the exact final answer immediately.
Selecting a conversation or submitting a new turn performs a one-shot scroll to
its latest user message after that row enters layout. No persistent scroll
binding can retain an id from another conversation, and streaming updates do not
override later manual scrolling. The default conversation viewport materializes
only that current turn. Earlier messages remain available through the explicit
history control at the top, so switching does not synchronously construct every
historical Markdown block.

Conversation history is durable UI data at
`~/Library/Application Support/Metaflow/conversations-v1.json`, independent of
the app bundle identifier. The store migrates current or legacy preference data
only when the stable file is absent, writes atomically, and fails on malformed
data instead of presenting an empty fallback.

Expanded/docked presentation commits the SwiftUI presentation and top-anchored
window frame synchronously. There is no timer, transition snapshot, or delayed
geometry owner that can leave an expanded empty panel behind a docked content
tree. Equal frames are skipped and streaming-only height changes are coalesced
to one update every 33 ms. Conversation replacement also keeps the existing
SwiftUI subtree identity instead of forcing a full teardown by conversation id.
The `NotchPresentation` and
`ConversationNavigation` OSLog categories record presentation commit time and
content-resize time plus conversation selection message count, target height,
and model-side elapsed time for local performance diagnosis.

Build, ad-hoc sign, install, and open the only canonical app:

```bash
corepack pnpm mac:run
```

The installed bundle is `~/Applications/Metaflow.app`. The raw SwiftPM
executable is not a valid microphone test because it does not bind `Info.plist`.
The bundle script embeds a stable designated requirement even for local ad-hoc
signing, so rebuilding the same bundle does not create a new TCC identity. A
real signing identity can be supplied with `METAFLOW_CODESIGN_IDENTITY`.

## Verification

```bash
swift test --package-path apps/mac
corepack pnpm mac:bundle
~/Applications/Metaflow.app/Contents/MacOS/metaflow-mac --permission-smoke
~/Applications/Metaflow.app/Contents/MacOS/metaflow-mac --asr-smoke
METAFLOW_SCREEN_SMOKE_OUTPUT=/tmp/metaflow-screen.jpg \
  ~/Applications/Metaflow.app/Contents/MacOS/metaflow-mac --screen-smoke
~/Applications/Metaflow.app/Contents/MacOS/metaflow-mac --ax-smoke --require-selected-text
```

`--permission-smoke` requires Accessibility and Microphone authorization.
`--asr-smoke` makes one real microphone and Doubao WebSocket request.
`--screen-smoke` captures and compresses one real current-display JPEG through
ScreenCaptureKit and fails explicitly when Screen Recording is unavailable.
`--ax-smoke --require-selected-text` fails distinctly for denied Accessibility,
missing frontmost application, or missing selected text.
