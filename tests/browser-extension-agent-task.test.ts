import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_RELATED_VIEW_TYPES, DEFAULT_VIEW_FILTERS, agentTasksEndpointFromSettings, buildBrowserAgentTaskRequest, buildViewFeedbackRequest, buildViewQueryFromTab, contextChatEndpointFromSettings, contextIngestEndpointFromSettings, contextViewUrlFromSettings, contextViewsEndpointFromSettings, feedbackEndpointFromSettings, feedbackTargetFromInput, formatAmbientViewResult, formatViewSubscriptionResult, selectedViewFromInput, selectedViewIdFromInput, viewIdsFromAgentTaskResponse, viewIdsFromProcessedIngestResponse, viewKeyPoints, viewSummaryText, writingAssistEndpointFromSettings } from "../archive/browser-extension-legacy/agent-task.js";

const LEGACY_EXTENSION_DIR = "archive/browser-extension-legacy";

test("Browser ambient save button posts an Observation into Program processing", () => {
  assert.equal(
    contextIngestEndpointFromSettings(
      { endpoint: "http://127.0.0.1:3111/context/ingest" },
      { process: true, cascadeViews: true },
    ),
    "http://127.0.0.1:3111/context/ingest?process=true&cascade_views=true",
  );

  const background = readFileSync(`${LEGACY_EXTENSION_DIR}/background.js`, "utf8");
  assert.match(background, /captureAmbientRequest[\s\S]+postRecord\(record, \{ process: true, cascadeViews: true \}\)/);
});

test("Browser extension can mark browser observations as allowed for external LLM runtimes", () => {
  const background = readFileSync(`${LEGACY_EXTENSION_DIR}/background.js`, "utf8");
  const popup = readFileSync(`${LEGACY_EXTENSION_DIR}/popup.html`, "utf8");
  const popupJs = readFileSync(`${LEGACY_EXTENSION_DIR}/popup.js`, "utf8");

  assert.match(background, /allowExternalLlm:\s*true/);
  assert.match(background, /agentRuntime:\s*"claude_code"/);
  assert.match(background, /allow_external_llm:\s*Boolean\(settings\.allowExternalLlm\)/);
  assert.match(popup, /id="allowExternalLlm"/);
  assert.match(popup, /id="agentRuntime"/);
  assert.match(popupJs, /\$\("allowExternalLlm"\)\.checked/);
});

test("Browser popup exposes Save Analyze Ask Claude Code live Views and feedback controls", () => {
  const popup = readFileSync(`${LEGACY_EXTENSION_DIR}/popup.html`, "utf8");
  const popupJs = readFileSync(`${LEGACY_EXTENSION_DIR}/popup.js`, "utf8");

  assert.match(popup, /Save &amp; Analyze|Save & Analyze/);
  assert.match(popup, /Ask Claude Code/);
  assert.match(popup, /Search all retrievable Views/);
  assert.match(popup, /Mark useful/);
  assert.match(popup, /Dismiss selected View/);
  assert.match(popup, /Summarize this page/);
  assert.match(popup, /current Info runtime work/);
  assert.match(popup, /Extract reusable ideas/);
  assert.doesNotMatch(popupJs, /save-current-page/);
  assert.match(popupJs, /ambient-current-page/);
  assert.match(popupJs, /submit-agent-task-current-page/);
  assert.match(popupJs, /poll-context-views/);
  assert.match(popupJs, /feedback-view/);
  assert.match(popupJs, /querySelectorAll\("\.quick"\)/);
});

test("Browser ambient can derive exact View URLs from the ingest endpoint", () => {
  assert.equal(
    contextViewUrlFromSettings({ endpoint: "http://127.0.0.1:3111/context/ingest" }, "analysis:browser:123"),
    "http://127.0.0.1:3111/context/views/analysis%3Abrowser%3A123",
  );
});

test("Browser ambient can derive the fast writing assist endpoint", () => {
  assert.equal(
    writingAssistEndpointFromSettings({ endpoint: "http://127.0.0.1:3111/context/ingest?process=true" }),
    "http://127.0.0.1:3111/writing/assist",
  );
});

test("Browser ambient can derive a cursor-based Views subscription endpoint", () => {
  assert.equal(
    contextViewsEndpointFromSettings(
      { endpoint: "http://127.0.0.1:3111/context/ingest" },
      {
        viewTypes: DEFAULT_RELATED_VIEW_TYPES,
        cursor: "2026-05-25T01:02:03.000Z",
        limit: 10,
        activeOnly: true,
      },
    ),
    "http://127.0.0.1:3111/context/views?limit=10&view_types=analysis.browser_agent_task%2Cproject.current_context%2Cthread.active_work%2Cbrief.project_next_state%2Cbrief.research%2Cadvice.writing_assist%2Cdraft.writing_continuation%2Cmemory.project.patterns&active_only=true&cursor=2026-05-25T01%3A02%3A03.000Z",
  );
});

test("Browser ambient can derive a query-based Views subscription endpoint", () => {
  assert.equal(
    contextViewsEndpointFromSettings(
      { endpoint: "http://127.0.0.1:3111/context/ingest" },
      {
        viewTypes: ["analysis.browser_agent_task"],
        query: "vectorized context routing",
        limit: 5,
        activeOnly: true,
      },
    ),
    "http://127.0.0.1:3111/context/views?limit=5&view_types=analysis.browser_agent_task&active_only=true&query=vectorized+context+routing",
  );
});

test("Browser popup can query all active View types without narrowing view_types", () => {
  assert.equal(DEFAULT_VIEW_FILTERS.all, undefined);
  assert.equal(
    contextViewsEndpointFromSettings(
      { endpoint: "http://127.0.0.1:3111/context/ingest" },
      {
        viewTypes: DEFAULT_VIEW_FILTERS.all,
        query: "anything searchable",
        limit: 12,
        activeOnly: true,
      },
    ),
    "http://127.0.0.1:3111/context/views?limit=12&active_only=true&query=anything+searchable",
  );
  assert.equal(
    contextViewsEndpointFromSettings(
      { endpoint: "http://127.0.0.1:3111/context/ingest" },
      { viewTypePrefix: "analysis.", limit: 60 },
    ),
    "http://127.0.0.1:3111/context/views?limit=60&view_type_prefix=analysis.&summary_only=true",
  );
});

test("Browser popup can narrow to writing assist Views", () => {
  const popup = readFileSync(`${LEGACY_EXTENSION_DIR}/popup.html`, "utf8");

  assert.deepEqual(DEFAULT_VIEW_FILTERS.writing, ["advice.writing_assist", "draft.writing_continuation"]);
  assert.match(popup, /value="writing">Writing assist/);
  assert.equal(
    contextViewsEndpointFromSettings(
      { endpoint: "http://127.0.0.1:3111/context/ingest" },
      {
        viewTypes: DEFAULT_VIEW_FILTERS.writing,
        limit: 6,
        activeOnly: true,
      },
    ),
    "http://127.0.0.1:3111/context/views?limit=6&view_types=advice.writing_assist%2Cdraft.writing_continuation&active_only=true",
  );
});

test("Browser ambient can query Views by source record id", () => {
  assert.equal(
    contextViewsEndpointFromSettings(
      { endpoint: "http://127.0.0.1:3111/context/ingest" },
      {
        viewTypes: ["advice.writing_assist", "draft.writing_continuation"],
        sourceRecordId: "record:writing-input",
        limit: 4,
        activeOnly: true,
      },
    ),
    "http://127.0.0.1:3111/context/views?limit=4&view_types=advice.writing_assist%2Cdraft.writing_continuation&active_only=true&source_record_id=record%3Awriting-input",
  );
});

test("Browser content script captures writing input and renders inline writing assist", () => {
  const background = readFileSync(`${LEGACY_EXTENSION_DIR}/background.js`, "utf8");
  const content = readFileSync(`${LEGACY_EXTENSION_DIR}/content.js`, "utf8");

  assert.match(content, /context\.capture\.writing_input/);
  assert.match(content, /document\.addEventListener\("input"/);
  assert.match(content, /document\.addEventListener\("focusin"/);
  assert.match(content, /document\.addEventListener\("keyup"/);
  assert.match(content, /document\.addEventListener\("compositionend"/);
  assert.match(content, /id = "info-writing-assist"/);
  assert.match(content, /showWritingIdle/);
  assert.match(content, /showWritingPending/);
  assert.match(content, /showWritingError/);
  assert.match(content, /editablePositionRect/);
  assert.match(content, /insertDraft/);
  assert.match(content, /submitWritingFeedback/);
  assert.match(content, /feedbackType:\s*"analysis\.useful"/);
  assert.match(content, /feedbackType:\s*"analysis\.dismissed"/);
  assert.match(content, /feedbackType:\s*"output\.edited"/);
  assert.match(content, /observeInsertedDraftEdit/);
  assert.match(content, /rememberInsertedDraftForEdit/);
  assert.match(content, /focusedWritingText/);
  assert.match(content, /full_text/);
  assert.match(content, /pollWritingAssist/);
  assert.match(content, /sourceRecordId/);
  assert.match(content, /WRITING_ASSIST_POLL_ATTEMPTS\s*=\s*45/);
  assert.match(content, /applicationId:\s*"editor\.inline_assist"/);
  assert.match(background, /observation\.editor\.text_changed/);
  assert.match(background, /postWritingAssistRecord\(record\)/);
  assert.match(background, /writingAssistEndpointFromSettings/);
  assert.match(background, /viewIdsFromProcessedIngestResponse\(posted\.body\)/);
  assert.match(background, /sourceRecordId:\s*message\.sourceRecordId/);
  assert.match(background, /applicationId:\s*message\.applicationId \|\| "browser\.popup"/);
});

test("Browser content script shows selection Explain Save toolbar", () => {
  const background = readFileSync(`${LEGACY_EXTENSION_DIR}/background.js`, "utf8");
  const content = readFileSync(`${LEGACY_EXTENSION_DIR}/content.js`, "utf8");

  assert.match(content, /id = "info-selection-toolbar"/);
  assert.match(content, /showSelectionToolbar/);
  assert.match(content, /selectionRect/);
  assert.match(content, /positionSelectionToolbar/);
  assert.match(content, /Explain/);
  assert.match(content, /Translate/);
  assert.match(content, /Save/);
  assert.match(content, /selectionActions/);
  assert.match(content, /selectionActions"\)/);
  assert.match(content, /context\.capture\.browser_attention/);
  assert.match(content, /sidepanel\.run\.selection_action/);
  assert.match(content, /showSelectionStatus\("Opening Chat\.\.\."\)/);
  assert.match(content, /Sent to Chat/);
  assert.match(content, /surrounding_text/);
  assert.match(background, /context\.explain\.selection/);
  assert.match(background, /async function explainSelection/);
  assert.match(background, /contextChatEndpointFromSettings/);
  assert.match(background, /sendBrowserAttention\(\{[\s\S]+explain_requested:\s*true/);
});

test("Chrome ACP extension carries browser observations and inline writing assist", () => {
  const manifest = readFileSync("apps/chrome-acp/packages/chrome-extension/manifest.json", "utf8");
  const background = readFileSync("apps/chrome-acp/packages/chrome-extension/src/background.ts", "utf8");
  const capture = readFileSync("apps/chrome-acp/packages/chrome-extension/src/lib/info-capture.ts", "utf8");
  const content = readFileSync("apps/chrome-acp/packages/chrome-extension/src/content.ts", "utf8");
  const build = readFileSync("apps/chrome-acp/packages/chrome-extension/build.ts", "utf8");

  assert.match(manifest, /"content_scripts"/);
  assert.match(manifest, /"dist\/content\.js"/);
  assert.match(manifest, /"storage"/);
  assert.match(manifest, /"debugger"/);
  assert.match(build, /path\.resolve\("src", "content\.ts"\)/);
  assert.match(background, /startInfoCapture\(\)/);
  assert.match(background, /handleInfoCaptureMessage/);
  assert.match(background, /sidepanel\.explain\.selection/);
  assert.match(background, /sidepanel\.run\.selection_action/);
  assert.match(background, /sidepanel\.consume-pending-prompt/);
  assert.match(capture, /observation\.browser_page_visit/);
  assert.match(capture, /observation\.browser_page_snapshot/);
  assert.match(capture, /observation\.browser_text_selected/);
  assert.match(capture, /observation\.browser_text_copied/);
  assert.match(capture, /observation\.editor\.text_changed/);
  assert.match(capture, /postRecord\(record, \{ process: true, cascadeViews: true \}\)/);
  assert.match(content, /context\.capture\.writing_input/);
  assert.match(content, /document\.addEventListener\("input"/);
  assert.match(content, /document\.addEventListener\("focusin"/);
  assert.match(content, /document\.addEventListener\("keyup"/);
  assert.match(content, /document\.addEventListener\("compositionend"/);
  assert.match(content, /id = "info-writing-assist"/);
  assert.match(content, /showWritingIdle/);
  assert.match(content, /showWritingPending/);
  assert.match(content, /showWritingError/);
  assert.match(content, /editablePositionRect/);
  assert.match(content, /Insert/);
  assert.match(content, /Dismiss/);
  assert.match(content, /feedbackType:\s*"analysis\.useful"/);
  assert.match(content, /feedbackType:\s*"analysis\.dismissed"/);
  assert.match(content, /feedbackType:\s*"output\.edited"/);
  assert.match(content, /focusedWritingText/);
  assert.match(content, /full_text/);
  assert.match(content, /pollWritingAssist/);
  assert.match(content, /sourceRecordId/);
  assert.match(content, /WRITING_ASSIST_POLL_ATTEMPTS\s*=\s*45/);
  assert.match(capture, /poll-context-views/);
  assert.match(capture, /postWritingAssistRecord\(record\)/);
  assert.match(capture, /writingAssistEndpoint/);
  assert.match(capture, /sourceRecordId:\s*message\.sourceRecordId/);
});

test("Chrome ACP exposes optional gated Browser Debugger tools", () => {
  const manifest = readFileSync("apps/chrome-acp/packages/chrome-extension/manifest.json", "utf8");
  const browserTool = readFileSync("apps/chrome-acp/packages/chrome-extension/src/tools/browser.ts", "utf8");
  const proxyTypes = readFileSync("apps/chrome-acp/packages/proxy-server/src/mcp/types.ts", "utf8");
  const proxyHandler = readFileSync("apps/chrome-acp/packages/proxy-server/src/mcp/handler.ts", "utf8");
  const sharedTypes = readFileSync("apps/chrome-acp/packages/shared/src/acp/types.ts", "utf8");

  assert.match(manifest, /"debugger"/);
  assert.match(sharedTypes, /BrowserDebuggerCommand/);
  assert.match(sharedTypes, /action:\s*[\s\S]*\|\s*"tabs"[\s\S]*\|\s*"read"[\s\S]*\|\s*"execute"[\s\S]*\|\s*"language_recent"[\s\S]*\|\s*"debugger"/);
  assert.match(proxyTypes, /BROWSER_DEBUGGER_TOOL/);
  assert.match(proxyTypes, /browser_debugger/);
  assert.match(proxyTypes, /capture_full_page/);
  assert.match(proxyTypes, /get_layout_tree/);
  assert.match(proxyTypes, /evaluate_js/);
  assert.match(proxyHandler, /browser_debugger:\s*"debugger"/);
  assert.match(proxyHandler, /formatDebuggerResult/);
  assert.match(browserTool, /DEBUGGER_SETTINGS_KEY/);
  assert.match(browserTool, /chrome\.debugger\.attach/);
  assert.match(browserTool, /chrome\.debugger\.sendCommand/);
  assert.match(browserTool, /Page\.captureScreenshot/);
  assert.match(browserTool, /DOMSnapshot\.captureSnapshot/);
  assert.match(browserTool, /Accessibility\.getFullAXTree/);
  assert.match(browserTool, /Runtime\.evaluate/);
  assert.match(browserTool, /Input\.dispatchMouseEvent/);
  assert.match(browserTool, /Page\.printToPDF/);
  assert.match(browserTool, /Advanced Browser Control is disabled/);
  assert.match(browserTool, /Domain is not allowlisted/);
  assert.match(browserTool, /blocked on sensitive domain/);
});

test("Chrome ACP content script shows selection Explain Save toolbar", () => {
  const capture = readFileSync("apps/chrome-acp/packages/chrome-extension/src/lib/info-capture.ts", "utf8");
  const content = readFileSync("apps/chrome-acp/packages/chrome-extension/src/content.ts", "utf8");

  assert.match(content, /id = "info-selection-toolbar"/);
  assert.match(content, /showSelectionToolbar/);
  assert.match(content, /selectionRect/);
  assert.match(content, /positionSelectionToolbar/);
  assert.match(content, /Explain/);
  assert.match(content, /Translate/);
  assert.match(content, /Save/);
  assert.match(content, /selectionActions/);
  assert.match(content, /selectionActions"\)/);
  assert.match(content, /context\.capture\.browser_attention/);
  assert.match(content, /sidepanel\.run\.selection_action/);
  assert.match(content, /showSelectionStatus\("Opening Chat\.\.\."\)/);
  assert.match(content, /Sent to Chat/);
  assert.match(content, /surrounding_text/);
  assert.match(capture, /context\.explain\.selection/);
  assert.match(capture, /async function explainSelection/);
  assert.match(capture, /contextChatEndpoint/);
  assert.match(capture, /sendBrowserAttention\(\{[\s\S]+explain_requested:\s*true/);
});

test("Chrome ACP sidepanel can consume selected text prompts into Chat", () => {
  const app = readFileSync("apps/chrome-acp/packages/chrome-extension/src/App.tsx", "utf8");
  const main = readFileSync("apps/chrome-acp/packages/shared/src/components/ACPMain.tsx", "utf8");
  const chat = readFileSync("apps/chrome-acp/packages/shared/src/components/ChatInterface.tsx", "utf8");

  assert.match(app, /sidepanel\.consume-pending-prompt/);
  assert.match(app, /Explain this selected text in plain language/);
  assert.match(app, /action\.prompt/);
  assert.match(app, /setActiveTabOverride\("chat"\)/);
  assert.match(main, /activeTabOverride/);
  assert.match(main, /incomingPrompt/);
  assert.match(chat, /incomingPrompt/);
  assert.match(chat, /onIncomingPromptConsumed/);
  assert.match(chat, /handleSubmit\(\{ text: prompt, files: \[\] \}\)/);
});

test("Chrome ACP Tasks and Language tabs render readable ambient state", () => {
  const tasks = readFileSync("apps/chrome-acp/packages/chrome-extension/src/components/TasksView.tsx", "utf8");
  const language = readFileSync("apps/chrome-acp/packages/chrome-extension/src/components/LanguageReviewView.tsx", "utf8");
  const content = readFileSync("apps/chrome-acp/packages/chrome-extension/src/content.ts", "utf8");
  const background = readFileSync("apps/chrome-acp/packages/chrome-extension/src/background.ts", "utf8");

  assert.match(tasks, /keyPointsOf/);
  assert.match(tasks, /detailRowsOf/);
  assert.match(tasks, /Raw view/);
  assert.match(tasks, /break-words/);
  assert.doesNotMatch(tasks, /break-all/);
  assert.match(language, /Recent caption segments/);
  assert.match(language, /language\.recent_caption_gaps/);
  assert.match(language, /loadRecentGaps/);
  assert.match(language, /Live now/);
  assert.match(language, /current_caption/);
  assert.match(language, /recentCaptionLines/);
  assert.match(language, /chrome\.storage\?\.onChanged\?\.addListener/);
  assert.match(content, /YT_RECENT_GAPS_KEY/);
  assert.match(content, /rememberRecentCaptionGap/);
  assert.match(content, /language\.caption_gap\.recent/);
  assert.match(content, /ytApplyCaptionState/);
  assert.match(content, /ytApplyPlaybackState/);
  assert.match(content, /ytFinishCaptionFragment/);
  assert.match(content, /ytSendGap/);
  assert.match(content, /current_caption:\s*ytReadCaptionText\(\)/);
  assert.match(content, /location\.hostname\.endsWith\("\.youtube\.com"\)/);
  assert.match(content, /Plain C is YouTube's native subtitle shortcut/);
  assert.match(content, /if \(!ytActive && ytIsWatchPage\(\)\) ytBind\(\)/);
  assert.match(background, /RECENT_CAPTION_GAPS_KEY/);
  assert.match(background, /language\.caption_gap\.recent/);
  assert.match(background, /fragmentKey/);
  assert.match(background, /chrome\.storage\?\.session\?\.set/);
});

test("Browser ambient builds a View query from current tab context", () => {
  assert.equal(
    buildViewQueryFromTab({
      title: "Agent Runtime Architecture Paper",
      url: "https://example.com/agent-runtime-paper.pdf?utm_source=test",
    }),
    "Agent Runtime Architecture Paper example.com /agent-runtime-paper.pdf",
  );
});

test("Browser popup can derive feedback endpoint and build a View feedback Observation request", () => {
  assert.equal(
    feedbackEndpointFromSettings({ endpoint: "http://127.0.0.1:3111/context/ingest" }),
    "http://127.0.0.1:3111/feedback?process=true",
  );
  assert.deepEqual(buildViewFeedbackRequest({
    viewId: "project:ctx",
    type: "analysis.dismissed",
    value: "dismissed",
    reason: "not useful now",
    payload: { surface: "popup" },
  }), {
    type: "analysis.dismissed",
    application_id: "browser.popup",
    view_id: "project:ctx",
    value: "dismissed",
    reason: "not useful now",
    payload: { surface: "popup" },
  });
  assert.deepEqual(buildViewFeedbackRequest({
    viewId: "writing:view",
    viewType: "draft.writing_continuation",
    type: "analysis.useful",
    value: "inserted",
    reason: "Inserted inline writing draft.",
    applicationId: "editor.inline_assist",
    payload: { surface: "writing_inline", action: "insert" },
  }), {
    type: "analysis.useful",
    application_id: "editor.inline_assist",
    view_id: "writing:view",
    value: "inserted",
    reason: "Inserted inline writing draft.",
    payload: {
      surface: "writing_inline",
      action: "insert",
      target_view_type: "draft.writing_continuation",
    },
  });
});

test("Browser popup can derive AgentTask endpoint and request Claude Code analysis for the current page", () => {
  assert.equal(
    agentTasksEndpointFromSettings({ endpoint: "http://127.0.0.1:3111/context/ingest" }, { cascadeViews: true }),
    "http://127.0.0.1:3111/agent-tasks?cascade_views=true",
  );
  assert.deepEqual(buildBrowserAgentTaskRequest({
    recordId: "record:browser-question",
    question: "What is this page about?",
    runtime: "claude_code",
    title: "Question about current page",
  }), {
    record_id: "record:browser-question",
    dry_run: false,
    autonomy: "suggest",
    speed: "work",
    task: {
      runtime: "claude_code",
      goal: [
        "What is this page about?",
        "Answer only with a structured analysis View.",
        "Do not modify files. Do not return next_actions, tasks, tool plans, or diffs.",
        "Prefer concrete facts from the captured page and related Info Views.",
      ].join("\n"),
      constraints: {
        write_policy: "views_only",
        action_policy: "analysis_only",
        browser_surface: "chrome_extension_popup",
      },
      output_contract: {
        view_type: "analysis.browser_agent_task",
        title: "Question about current page",
        purpose: "Answer a user question about the current browser page using Info context.",
      },
    },
  });
});

test("Browser sidepanel Ask uses normal context chat instead of AgentTask", () => {
  assert.equal(
    contextChatEndpointFromSettings({ endpoint: "http://127.0.0.1:3111/context/ingest" }),
    "http://127.0.0.1:3111/context/chat",
  );
  const background = readFileSync(`${LEGACY_EXTENSION_DIR}/background.js`, "utf8");
  const sidepanel = readFileSync(`${LEGACY_EXTENSION_DIR}/src/sidepanel/main.tsx`, "utf8");

  assert.match(background, /ask-current-page/);
  assert.match(background, /get-chat-page-context/);
  assert.match(background, /contextChatEndpointFromSettings/);
  assert.match(sidepanel, /type:\s*"get-chat-page-context"/);
  assert.match(sidepanel, /fetch\(String\(context\.endpoint\)/);
  assert.doesNotMatch(sidepanel, /type:\s*"ask-current-page"/);
  assert.doesNotMatch(sidepanel, /type:\s*"submit-agent-task-current-page"/);
  assert.doesNotMatch(sidepanel, /Claude Code AgentTask/);
});

test("Browser ambient extracts Program-produced and cascaded View IDs from processed ingest", () => {
  assert.deepEqual(viewIdsFromProcessedIngestResponse({
    processing: {
      runs: [
        { written_views: ["analysis:agent"] },
        { written_views: ["analysis:agent", "analysis:browser"] },
      ],
    },
    cascade_processing: [{
      runs: [
        { written_views: ["project:ctx", "thread:active"] },
        { written_views: ["brief:research", "analysis:agent"] },
      ],
    }],
  }), ["analysis:agent", "analysis:browser", "project:ctx", "thread:active", "brief:research"]);
});

test("Browser popup extracts direct and cascaded View IDs from AgentTask response", () => {
  assert.deepEqual(viewIdsFromAgentTaskResponse({
    result: { written_views: ["analysis:browser"] },
    cascade_processing: [{
      runs: [
        { written_views: ["project:ctx"] },
        { written_views: ["brief:research", "analysis:browser"] },
      ],
    }],
  }), ["analysis:browser", "project:ctx", "brief:research"]);
});

test("Browser ambient formats returned Views for popup display", () => {
  const text = formatAmbientViewResult({
    ok: true,
    views: [{
      view: {
        id: "analysis:browser:123",
        view_type: "analysis.browser_agent_task",
        title: "Browser agent analysis",
        summary: "This page is relevant to Info runtime design.",
        content: {
          agent_output: {
            key_points: ["Context pack should be automatic", "Agent runtime owns skills"],
          },
        },
      },
    }],
  });

  assert.match(text, /Browser agent analysis/);
  assert.match(text, /Info runtime design/);
  assert.match(text, /Context pack should be automatic/);
  assert.match(text, /analysis:browser:123/);
});

test("Browser popup extracts summary and key points from any retrievable View", () => {
  const view = {
    id: "analysis:any",
    summary: "Fallback summary.",
    content: {
      agent_output: {
        summary: "Agent summary.",
        key_points: ["first", "second", "third", "fourth"],
      },
    },
  };

  assert.equal(viewSummaryText(view), "Agent summary.");
  assert.deepEqual(viewKeyPoints(view, 2), ["first", "second"]);
});

test("Browser ambient formats cascaded Views for popup display", () => {
  const text = formatAmbientViewResult({
    ok: true,
    views: [
      { view: { id: "analysis:browser:123", view_type: "analysis.browser_agent_task", title: "Browser agent analysis", summary: "Primary analysis.", content: {} } },
      { view: { id: "project:ctx", view_type: "project.current_context", title: "Project context", summary: "Derived project context.", content: {} } },
      { view: { id: "brief:research", view_type: "brief.research", title: "Research brief", summary: "Derived research brief.", content: {} } },
    ],
  });

  assert.match(text, /Cascaded views/);
  assert.match(text, /project.current_context/);
  assert.match(text, /brief.research/);
});

test("Browser ambient formats View subscription results without adding intelligence to the popup", () => {
  const text = formatViewSubscriptionResult({
    ok: true,
    next_cursor: "2026-05-25T01:02:03.000Z",
    views: [
      { id: "project:ctx", view_type: "project.current_context", title: "Project context", content: { agent_output: { summary: "Current work is Info runtime." } } },
      { id: "brief:research", view_type: "brief.research", summary: "Research brief from cascaded AgentTask output." },
    ],
  });

  assert.match(text, /2 new View/);
  assert.match(text, /project.current_context/);
  assert.match(text, /Current work is Info runtime/);
  assert.match(text, /#1/);
  assert.match(text, /project:ctx/);
  assert.match(text, /brief.research/);
  assert.match(text, /brief:research/);
});

test("Browser popup can select a feedback target View by list number or explicit id", () => {
  const views = [
    { id: "project:ctx", view_type: "project.current_context" },
    { id: "brief:research", view_type: "brief.research" },
  ];

  assert.deepEqual(selectedViewFromInput("#2", views), { id: "brief:research", view_type: "brief.research" });
  assert.equal(selectedViewIdFromInput("1", views), "project:ctx");
  assert.equal(selectedViewIdFromInput("#2", views), "brief:research");
  assert.equal(selectedViewIdFromInput("brief:research", views), "brief:research");
  assert.equal(selectedViewIdFromInput("", views), "project:ctx");
  assert.equal(selectedViewIdFromInput("9", views), undefined);
});

test("Browser popup explicit invalid feedback target does not fall back to previous target", () => {
  const views = [
    { id: "project:ctx", view_type: "project.current_context" },
    { id: "brief:research", view_type: "brief.research" },
  ];

  assert.deepEqual(feedbackTargetFromInput("", views, "project:ctx"), { ok: true, view: views[0] });
  assert.deepEqual(feedbackTargetFromInput("#2", views, "project:ctx"), { ok: true, view: views[1] });
  assert.deepEqual(feedbackTargetFromInput("9", views, "project:ctx"), { ok: false, error: "Selected View not found." });
});

test("Browser popup feedback request can include target View type as factual metadata", () => {
  assert.deepEqual(buildViewFeedbackRequest({
    viewId: "brief:research",
    viewType: "brief.research",
    type: "analysis.dismissed",
    value: "dismissed",
    payload: { surface: "popup" },
  }).payload, {
    surface: "popup",
    target_view_type: "brief.research",
  });
});
