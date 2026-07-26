import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextStore } from "@info/core";
import { ingestFeedback } from "@info/runtime/feedback.js";

// ---------------------------------------------------------------------------
// Helpers: replicate the pure logic from the Chrome ACP ambient UX modules
// so we can test it in Node without a browser.
// ---------------------------------------------------------------------------

/**
 * selectionActionFromConfig — mirrors
 * apps/chrome-acp/packages/chrome-extension/src/lib/ambient/ux.ts
 */
function selectionActionFromConfig(action: unknown): {
  id: string;
  label: string;
  prompt: string;
} | null {
  if (!action || typeof action !== "object") return null;
  const a = action as Record<string, unknown>;
  const enabled = a.enabled !== false;
  const id = String(a.id || "").trim();
  const label = String(a.label || "").trim();
  const prompt = String(a.prompt || "").trim();
  if (!enabled || !id || !label || !prompt) return null;
  return { id, label, prompt };
}

const DEFAULT_SELECTION_ACTIONS = [
  {
    id: "explain",
    label: "Explain",
    prompt:
      "Explain this selected text in plain language. Keep it concise, and mention the page context if it matters.",
  },
  {
    id: "translate_zh",
    label: "Translate",
    prompt:
      "Translate this selected text into natural Simplified Chinese. Preserve names, technical terms, and the original meaning.",
  },
];

/** Build the save action (always appended by the toolbar renderer). */
const SAVE_ACTION = { id: "save", label: "Save", prompt: "" };

/**
 * sensitiveEditable — mirrors the logic in content.ts that decides whether
 * a form field is sensitive and should block writing suggestions / feedback.
 */
function sensitiveEditable(attrs: {
  id?: string;
  name?: string;
  autocomplete?: string;
}): boolean {
  return /password|token|secret|api[_-]?key|credit card|验证码|密码/i.test(
    `${attrs.id || ""} ${attrs.name || ""} ${attrs.autocomplete || ""}`,
  );
}

/**
 * Build a feedback payload for a toolbar action, mimicking
 * what the content script sends over chrome.runtime.sendMessage.
 */
function toolbarActionFeedback(
  action: { id: string; label: string; prompt: string },
  viewId: string,
  viewType: string,
  surface: "selection_toolbar" | "writing_inline" = "selection_toolbar",
) {
  if (action.id === "save") {
    return {
      feedbackType: "analysis.useful",
      value: "saved",
      reason: "Saved selected text to Info.",
      payload: { action: "save", surface, action_id: action.id },
    };
  }
  return {
    feedbackType: "analysis.useful",
    value: action.id,
    reason: `Toolbar action: ${action.label}`,
    payload: { action: action.id, surface, action_id: action.id },
  };
}

/**
 * Build a side-panel inbox routing message, mirroring routeToInbox from ux.ts.
 */
function routeToInboxPayload(
  viewId: string,
  viewType: string,
  action: "save" | "route" | "feedback",
) {
  return {
    type: "feedback-view" as const,
    viewId,
    viewType,
    feedbackType: action === "save" ? "analysis.useful" : "analysis.dismissed",
    value: action,
    applicationId: "chrome_acp.ambient",
    payload: { surface: "ambient", action },
  };
}

/**
 * draftTextFromView / suggestionsFromView — mirrors the view→text helpers
 * in content.ts that decide what text to show in the writing-assist bubble.
 */
function draftTextFromView(view: Record<string, unknown> | null): string {
  const content = view?.content as Record<string, unknown> | undefined;
  const value = content?.draft_text || view?.summary;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function suggestionsFromView(
  view: Record<string, unknown> | null,
): string[] {
  const content = view?.content as Record<string, unknown> | undefined;
  const value = content?.suggestions;
  return Array.isArray(value)
    ? value.filter(
        (item: unknown) => typeof item === "string" && item.trim(),
      )
    : [];
}

/** Suggestion text quality: non-empty, bounded length. */
const MAX_SUGGESTION_LENGTH = 5000;

function suggestionTextIsValid(text: string): {
  valid: boolean;
  reason?: string;
} {
  if (!text || !text.trim()) return { valid: false, reason: "empty" };
  if (text.length > MAX_SUGGESTION_LENGTH)
    return { valid: false, reason: "too_long" };
  return { valid: true };
}

// ---------------------------------------------------------------------------
// withStore helper — same pattern as feedback.test.ts
// ---------------------------------------------------------------------------

function withStore(
  fn: (store: ContextStore) => Promise<void> | void,
) {
  const dir = mkdtempSync(join(tmpdir(), "info-chrome-acp-ux-test-"));
  const store = new ContextStore(join(dir, "context.sqlite"));
  return Promise.resolve(fn(store)).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

// ===========================================================================
// 1. Selection toolbar supports explain, translate, save
// ===========================================================================

test("DEFAULT_SELECTION_ACTIONS includes explain and translate", () => {
  assert.equal(DEFAULT_SELECTION_ACTIONS.length, 2);
  const ids = DEFAULT_SELECTION_ACTIONS.map((a) => a.id);
  assert.ok(ids.includes("explain"));
  assert.ok(ids.includes("translate_zh"));
});

test("explain action produces correct toolbar observation record", async () =>
  withStore(async (store) => {
    const viewId = "view:sel:explain-1";
    store.upsertView({
      id: viewId,
      view_type: "analysis.explain",
      title: "Explain selection",
      content: { analysis: "This means X." },
      privacy: { level: "private", retention: "normal" },
    });

    const explainAction = DEFAULT_SELECTION_ACTIONS.find(
      (a) => a.id === "explain",
    )!;
    const fb = toolbarActionFeedback(
      explainAction,
      viewId,
      "analysis.explain",
    );

    const result = ingestFeedback(
      {
        type: fb.feedbackType,
        application_id: "chrome_acp.ambient",
        view_id: viewId,
        value: fb.value,
        reason: fb.reason,
        payload: fb.payload,
      },
      store,
    );

    assert.equal(result.ok, true);
    assert.equal(result.record.schema.name, "feedback.analysis.useful");
    assert.equal(result.record.payload?.value, "explain");
    assert.equal(result.record.payload?.surface, "selection_toolbar");
    assert.equal(result.record.payload?.action_id, "explain");
  }));

test("translate action produces correct toolbar observation record", async () =>
  withStore(async (store) => {
    const viewId = "view:sel:translate-1";
    store.upsertView({
      id: viewId,
      view_type: "analysis.translate",
      title: "Translate selection",
      content: { analysis: "Translated text." },
      privacy: { level: "private", retention: "normal" },
    });

    const translateAction = DEFAULT_SELECTION_ACTIONS.find(
      (a) => a.id === "translate_zh",
    )!;
    const fb = toolbarActionFeedback(
      translateAction,
      viewId,
      "analysis.translate",
    );

    const result = ingestFeedback(
      {
        type: fb.feedbackType,
        application_id: "chrome_acp.ambient",
        view_id: viewId,
        value: fb.value,
        reason: fb.reason,
        payload: fb.payload,
      },
      store,
    );

    assert.equal(result.ok, true);
    assert.equal(result.record.payload?.value, "translate_zh");
    assert.equal(result.record.payload?.action_id, "translate_zh");
  }));

test("save action produces correct observation record", async () =>
  withStore(async (store) => {
    const viewId = "view:sel:save-1";
    store.upsertView({
      id: viewId,
      view_type: "analysis.save",
      title: "Save selection",
      content: { analysis: "Saved." },
      privacy: { level: "private", retention: "normal" },
    });

    const fb = toolbarActionFeedback(
      SAVE_ACTION,
      viewId,
      "analysis.save",
    );

    const result = ingestFeedback(
      {
        type: fb.feedbackType,
        application_id: "chrome_acp.ambient",
        view_id: viewId,
        value: fb.value,
        reason: fb.reason,
        payload: fb.payload,
      },
      store,
    );

    assert.equal(result.ok, true);
    assert.equal(result.record.payload?.value, "saved");
    assert.equal(result.record.payload?.action, "save");
  }));

// ===========================================================================
// 2. Custom prompt buttons
// ===========================================================================

test("selectionActionFromConfig validates a well-formed custom action", () => {
  const action = selectionActionFromConfig({
    id: "summarize",
    label: "Summarize",
    prompt: "Summarize the selected text concisely.",
  });
  assert.deepEqual(action, {
    id: "summarize",
    label: "Summarize",
    prompt: "Summarize the selected text concisely.",
  });
});

test("selectionActionFromConfig trims whitespace from fields", () => {
  const action = selectionActionFromConfig({
    id: "  define  ",
    label: "  Define  ",
    prompt: "  Define this term  ",
  });
  assert.ok(action);
  assert.equal(action!.id, "define");
  assert.equal(action!.label, "Define");
  assert.equal(action!.prompt, "Define this term");
});

test("selectionActionFromConfig rejects action with enabled: false", () => {
  const action = selectionActionFromConfig({
    id: "explain",
    label: "Explain",
    prompt: "Explain it.",
    enabled: false,
  });
  assert.equal(action, null);
});

test("selectionActionFromConfig rejects action missing id", () => {
  const action = selectionActionFromConfig({
    label: "Explain",
    prompt: "Explain it.",
  });
  assert.equal(action, null);
});

test("selectionActionFromConfig rejects action missing label", () => {
  const action = selectionActionFromConfig({
    id: "explain",
    prompt: "Explain it.",
  });
  assert.equal(action, null);
});

test("selectionActionFromConfig rejects action missing prompt", () => {
  const action = selectionActionFromConfig({
    id: "explain",
    label: "Explain",
  });
  assert.equal(action, null);
});

test("selectionActionFromConfig rejects non-object input", () => {
  assert.equal(selectionActionFromConfig(null), null);
  assert.equal(selectionActionFromConfig(undefined), null);
  assert.equal(selectionActionFromConfig("string"), null);
  assert.equal(selectionActionFromConfig(42), null);
});

test("custom prompt button fires correct feedback action", async () =>
  withStore(async (store) => {
    const viewId = "view:sel:custom-1";
    store.upsertView({
      id: viewId,
      view_type: "analysis.custom",
      title: "Custom action result",
      content: { analysis: "Custom output." },
      privacy: { level: "private", retention: "normal" },
    });

    const customAction = selectionActionFromConfig({
      id: "define",
      label: "Define",
      prompt: "Define the selected term.",
    })!;
    assert.ok(customAction);

    const fb = toolbarActionFeedback(
      customAction,
      viewId,
      "analysis.custom",
    );
    const result = ingestFeedback(
      {
        type: fb.feedbackType,
        application_id: "chrome_acp.ambient",
        view_id: viewId,
        value: fb.value,
        reason: fb.reason,
        payload: fb.payload,
      },
      store,
    );

    assert.equal(result.ok, true);
    assert.equal(result.record.payload?.value, "define");
    assert.equal(result.record.payload?.action_id, "define");
  }));

// ===========================================================================
// 3. Feedback is recorded — dismiss / insert / edit-from-suggestions
// ===========================================================================

test("dismiss feedback from suggestions writes into feedback system", async () =>
  withStore(async (store) => {
    const viewId = "view:wrt:dismiss-test";
    store.upsertView({
      id: viewId,
      view_type: "draft.writing_continuation",
      title: "Writing suggestion",
      content: { draft_text: "Continue writing here." },
      privacy: { level: "private", retention: "normal" },
    });

    const result = ingestFeedback(
      {
        type: "analysis.dismissed",
        application_id: "editor.inline_assist",
        view_id: viewId,
        value: "dismissed",
        reason: "Dismissed inline writing assist.",
        payload: { action: "dismiss", surface: "writing_inline" },
      },
      store,
    );

    assert.equal(result.ok, true);
    assert.equal(result.record.schema.name, "feedback.analysis.dismissed");
    assert.equal(result.record.source.connector, "editor.inline_assist");
    assert.equal(result.record.payload?.value, "dismissed");
    assert.equal(result.record.payload?.surface, "writing_inline");
    assert.equal(result.record.acquisition?.mode, "manual");
    assert.equal(result.record.acquisition?.actor, "user");
  }));

test("insert feedback from suggestions writes into feedback system", async () =>
  withStore(async (store) => {
    const viewId = "view:wrt:insert-test";
    store.upsertView({
      id: viewId,
      view_type: "draft.writing_continuation",
      title: "Writing draft",
      content: { draft_text: "This is a draft." },
      privacy: { level: "private", retention: "normal" },
    });

    const result = ingestFeedback(
      {
        type: "analysis.useful",
        application_id: "editor.inline_assist",
        view_id: viewId,
        value: "inserted",
        reason: "Inserted inline writing draft.",
        payload: {
          action: "insert",
          surface: "writing_inline",
          draft_text: "This is a draft.",
          original_text: "Before",
          edited_text: "Before This is a draft.",
        },
      },
      store,
    );

    assert.equal(result.ok, true);
    assert.equal(result.record.schema.name, "feedback.analysis.useful");
    assert.equal(result.record.payload?.value, "inserted");
    assert.equal(result.record.payload?.action, "insert");
    assert.equal(
      result.record.payload?.draft_text,
      "This is a draft.",
    );
  }));

test("edit-after-insert feedback writes into feedback system", async () =>
  withStore(async (store) => {
    const viewId = "view:wrt:edit-test";
    store.upsertView({
      id: viewId,
      view_type: "draft.writing_continuation",
      title: "Writing draft (edited)",
      content: { draft_text: "Original draft." },
      privacy: { level: "private", retention: "normal" },
    });

    const result = ingestFeedback(
      {
        type: "output.edited",
        application_id: "editor.inline_assist",
        view_id: viewId,
        value: "edited",
        reason: "Edited inline writing draft after insertion.",
        payload: {
          action: "edit_after_insert",
          surface: "writing_inline",
          original_text: "Original draft.",
          edited_text: "Modified by user.",
        },
      },
      store,
    );

    assert.equal(result.ok, true);
    assert.equal(result.record.schema.name, "feedback.output.edited");
    assert.equal(result.record.payload?.value, "edited");
    assert.equal(
      result.record.payload?.original_text,
      "Original draft.",
    );
    assert.equal(
      result.record.payload?.edited_text,
      "Modified by user.",
    );
  }));

test("feedback record links to target view", async () =>
  withStore(async (store) => {
    const viewId = "view:sel:link-test";
    store.upsertView({
      id: viewId,
      view_type: "advice.writing_assist",
      title: "Advice view",
      content: { suggestions: ["Consider rewriting."] },
      privacy: { level: "private", retention: "normal" },
    });

    const result = ingestFeedback(
      {
        type: "analysis.dismissed",
        application_id: "editor.inline_assist",
        view_id: viewId,
        value: "dismissed",
        reason: "Not useful.",
      },
      store,
    );

    assert.ok(result.record.relations?.related_to?.includes(viewId));
    assert.equal(result.record.payload?.target_view_type, "advice.writing_assist");
  }));

// ===========================================================================
// 4. Side-panel routing
// ===========================================================================

test("routeToInbox for 'save' action produces analysis.useful feedback", () => {
  const msg = routeToInboxPayload(
    "view:inbox:save-1",
    "analysis.explain",
    "save",
  );
  assert.equal(msg.type, "feedback-view");
  assert.equal(msg.viewId, "view:inbox:save-1");
  assert.equal(msg.viewType, "analysis.explain");
  assert.equal(msg.feedbackType, "analysis.useful");
  assert.equal(msg.value, "save");
  assert.equal(msg.payload.surface, "ambient");
  assert.equal(msg.payload.action, "save");
});

test("routeToInbox for 'route' action produces analysis.dismissed feedback", () => {
  const msg = routeToInboxPayload(
    "view:inbox:route-1",
    "draft.writing_continuation",
    "route",
  );
  assert.equal(msg.feedbackType, "analysis.dismissed");
  assert.equal(msg.value, "route");
  assert.equal(msg.payload.surface, "ambient");
  assert.equal(msg.payload.action, "route");
});

test("routeToInbox for 'feedback' action produces analysis.dismissed feedback", () => {
  const msg = routeToInboxPayload(
    "view:inbox:fb-1",
    "advice.writing_assist",
    "feedback",
  );
  assert.equal(msg.feedbackType, "analysis.dismissed");
  assert.equal(msg.value, "feedback");
});

test("side-panel inbox routing feedback can be ingested", async () =>
  withStore(async (store) => {
    const viewId = "view:inbox:ingest-1";
    store.upsertView({
      id: viewId,
      view_type: "draft.writing_continuation",
      title: "Draft to route",
      content: { draft_text: "Routed draft" },
      privacy: { level: "private", retention: "normal" },
    });

    const msg = routeToInboxPayload(viewId, "draft.writing_continuation", "route");
    const result = ingestFeedback(
      {
        type: msg.feedbackType,
        application_id: msg.applicationId,
        view_id: msg.viewId,
        value: msg.value,
        reason: "Routed to side-panel inbox.",
        payload: msg.payload,
      },
      store,
    );

    assert.equal(result.ok, true);
    assert.equal(result.record.payload?.surface, "ambient");
    assert.equal(result.record.payload?.action, "route");
  }));

// ===========================================================================
// 5. No suggestions on sensitive inputs
// ===========================================================================

test("sensitiveEditable detects password field", () => {
  assert.equal(
    sensitiveEditable({ id: "pwd", name: "password", autocomplete: "current-password" }),
    true,
  );
});

test("sensitiveEditable detects token field", () => {
  assert.equal(
    sensitiveEditable({ id: "api-token", name: "token", autocomplete: "" }),
    true,
  );
});

test("sensitiveEditable detects api_key field", () => {
  assert.equal(
    sensitiveEditable({ id: "", name: "api_key", autocomplete: "" }),
    true,
  );
});

test("sensitiveEditable detects api-key field", () => {
  assert.equal(
    sensitiveEditable({ id: "", name: "api-key", autocomplete: "" }),
    true,
  );
});

test("sensitiveEditable detects credit card field", () => {
  assert.equal(
    sensitiveEditable({ id: "cc", name: "credit card number", autocomplete: "cc-number" }),
    true,
  );
});

test("sensitiveEditable detects Chinese password (密码) field", () => {
  assert.equal(
    sensitiveEditable({ id: "密码", name: "", autocomplete: "" }),
    true,
  );
});

test("sensitiveEditable detects Chinese captcha (验证码) field", () => {
  assert.equal(
    sensitiveEditable({ id: "", name: "验证码", autocomplete: "" }),
    true,
  );
});

test("sensitiveEditable allows regular text input", () => {
  assert.equal(
    sensitiveEditable({ id: "comment", name: "comment", autocomplete: "" }),
    false,
  );
});

test("sensitiveEditable allows search input", () => {
  assert.equal(
    sensitiveEditable({ id: "q", name: "search", autocomplete: "" }),
    false,
  );
});

test("sensitiveEditable allows email input", () => {
  assert.equal(
    sensitiveEditable({ id: "email", name: "email", autocomplete: "email" }),
    false,
  );
});

test("sensitiveEditable handles empty attrs object", () => {
  assert.equal(sensitiveEditable({}), false);
});

test("sensitiveEditable with secret autocomplete attribute", () => {
  assert.equal(
    sensitiveEditable({ id: "", name: "field", autocomplete: "secret" }),
    true,
  );
});

// ===========================================================================
// 6. UI text is non-empty and bounded
// ===========================================================================

test("draftTextFromView returns draft_text from content", () => {
  const view = {
    id: "v1",
    view_type: "draft.writing_continuation",
    content: { draft_text: "Continue writing this paragraph." },
  };
  assert.equal(draftTextFromView(view), "Continue writing this paragraph.");
});

test("draftTextFromView falls back to summary", () => {
  const view = {
    id: "v2",
    view_type: "draft.writing_continuation",
    summary: "A summary of the draft.",
    content: {},
  };
  assert.equal(draftTextFromView(view), "A summary of the draft.");
});

test("draftTextFromView returns empty for empty content", () => {
  assert.equal(draftTextFromView(null), "");
  assert.equal(draftTextFromView({ content: {} }), "");
  assert.equal(draftTextFromView({ content: { draft_text: "  " } }), "");
});

test("suggestionsFromView returns valid suggestion strings", () => {
  const view = {
    id: "v3",
    view_type: "advice.writing_assist",
    content: {
      suggestions: [
        "Consider rephrasing this sentence.",
        "Add more detail here.",
      ],
    },
  };
  const suggestions = suggestionsFromView(view);
  assert.equal(suggestions.length, 2);
  assert.equal(suggestions[0], "Consider rephrasing this sentence.");
  assert.equal(suggestions[1], "Add more detail here.");
});

test("suggestionsFromView filters out empty strings", () => {
  const view = {
    id: "v4",
    view_type: "advice.writing_assist",
    content: {
      suggestions: ["Valid suggestion", "", "  ", "Another valid one"],
    },
  };
  const suggestions = suggestionsFromView(view);
  assert.equal(suggestions.length, 2);
});

test("suggestionsFromView returns empty array for missing content", () => {
  assert.deepEqual(suggestionsFromView(null), []);
  assert.deepEqual(suggestionsFromView({ content: {} }), []);
  assert.deepEqual(suggestionsFromView({ content: { suggestions: "not an array" } }), []);
});

test("suggestionTextIsValid accepts normal suggestion text", () => {
  const result = suggestionTextIsValid("This is a useful writing suggestion.");
  assert.equal(result.valid, true);
  assert.equal(result.reason, undefined);
});

test("suggestionTextIsValid rejects empty text", () => {
  const result = suggestionTextIsValid("");
  assert.equal(result.valid, false);
  assert.equal(result.reason, "empty");
});

test("suggestionTextIsValid rejects whitespace-only text", () => {
  const result = suggestionTextIsValid("   ");
  assert.equal(result.valid, false);
  assert.equal(result.reason, "empty");
});

test("suggestionTextIsValid rejects overly long text", () => {
  const longText = "x".repeat(MAX_SUGGESTION_LENGTH + 1);
  const result = suggestionTextIsValid(longText);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "too_long");
});

test("suggestionTextIsValid accepts text at max length boundary", () => {
  const atMax = "x".repeat(MAX_SUGGESTION_LENGTH);
  const result = suggestionTextIsValid(atMax);
  assert.equal(result.valid, true);
});

test("draft text from a view that has both draft and summary prefers draft_text", () => {
  const view = {
    id: "v5",
    view_type: "draft.writing_continuation",
    content: { draft_text: "Draft text" },
    summary: "Summary text",
  };
  assert.equal(draftTextFromView(view), "Draft text");
});

test("combined view output: draft + suggestions both contribute content", () => {
  const view = {
    id: "v6",
    view_type: "draft.writing_continuation",
    content: {
      draft_text: "Here is the continuation.",
      suggestions: ["Make it shorter.", "Add a transition."],
    },
  };
  const draft = draftTextFromView(view);
  const suggestions = suggestionsFromView(view);
  assert.ok(draft.length > 0);
  assert.ok(suggestions.length > 0);
  assert.ok(suggestionTextIsValid(draft).valid);
  for (const s of suggestions) {
    assert.ok(suggestionTextIsValid(s).valid, `Suggestion "${s.slice(0, 30)}..." should be valid`);
  }
});
