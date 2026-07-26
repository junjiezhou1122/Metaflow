import { createHash } from "node:crypto";
import {
  matchTrigger,
  parseAutomationView,
  parseTriggerSignal,
  type AutomationInvocationResult,
  type AutomationRuntime,
  type ParsedAutomationView,
  type TriggerSignal,
} from "@info/automation";
import {
  ObservationCandidateSchema,
  type CaptureIngress,
  type IngestReceipt,
  type ObservationCandidate,
} from "@info/capture";
import type { ExactViewRef, JsonValue, ViewRepository } from "@info/view";
import type { MacBrowserContextBridge } from "./browser-context.js";
import {
  MacAutomationAdapterError,
  parseMacVoiceCaptureEvent,
  type BrowserDomSnapshot,
  type MacVoiceCaptureEvent,
} from "./contracts.js";

export interface MacAutomationCatalog {
  list(): Promise<ParsedAutomationView[]>;
}

export class ViewMacAutomationCatalog implements MacAutomationCatalog {
  constructor(private readonly views: Pick<ViewRepository, "query">, private readonly limit = 1_000) {}

  async list(): Promise<ParsedAutomationView[]> {
    const views = await this.views.query({
      schema_name: "metaflow.automation",
      role: "derived",
      revisions: "latest",
      limit: this.limit,
    });
    return views.map(parseAutomationView);
  }
}

export type MacAutomationAdapterEvent = {
  type:
    | "macos_automation.received"
    | "macos_automation.matched"
    | "macos_automation.ignored"
    | "macos_automation.browser_context_requested"
    | "macos_automation.browser_context_received"
    | "macos_automation.capture_committed"
    | "macos_automation.invoked"
    | "macos_automation.failed";
  occurred_at: string;
  event_id: string;
  session_id: string;
  payload: Record<string, JsonValue>;
};

export type MacAutomationSubmission = {
  status: "ignored" | "invoked";
  event_id: string;
  session_id: string;
  signal: TriggerSignal;
  captured_views: Array<{
    role: "voice_utterance" | "current_app" | "current_page";
    ref: ExactViewRef;
    created: boolean;
  }>;
  matched_automations: ExactViewRef[];
  invocations: AutomationInvocationResult[];
  latency: {
    shortcut_hold_ms: number;
    release_to_response_ms: number;
  };
};

export type MacAgentRuntimeResolver = {
  resolve(requestedName: string): string | undefined;
};

export type MacAutomationControllerOptions = {
  capture: Pick<CaptureIngress, "ingest">;
  catalog: MacAutomationCatalog;
  runtime: Pick<AutomationRuntime, "invoke">;
  browser_context?: MacBrowserContextBridge;
  agents?: MacAgentRuntimeResolver;
  now?: () => Date;
  events?: { emit(event: MacAutomationAdapterEvent): void | Promise<void> };
};

export class MacAutomationController {
  private readonly now: () => Date;

  constructor(private readonly options: MacAutomationControllerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async submit(input: unknown): Promise<MacAutomationSubmission> {
    const event = parseMacVoiceCaptureEvent(input);
    const receivedAt = this.now().getTime();
    await this.emit(event, "macos_automation.received", {
      shortcut_hold_ms: shortcutHoldMs(event),
      app: event.accessibility.status === "trusted" ? event.accessibility.bundle_identifier : "unavailable",
      speech_status: event.speech.status,
    });
    if (event.accessibility.status === "denied") {
      await this.fail(event, "accessibility_denied", event.accessibility.message);
      throw new MacAutomationAdapterError(event.accessibility.message, "accessibility_denied", {
        permission_code: event.accessibility.code,
      });
    }
    if (event.speech.status === "failed") {
      await this.fail(event, "asr_failed", event.speech.message);
      throw new MacAutomationAdapterError(event.speech.message, "asr_failed", { asr_code: event.speech.code });
    }
    const readyEvent = event as MacVoiceCaptureEvent & {
      speech: Extract<MacVoiceCaptureEvent["speech"], { status: "recognized" }>;
      accessibility: Extract<MacVoiceCaptureEvent["accessibility"], { status: "trusted" }>;
    };

    let automations: ParsedAutomationView[];
    try {
      automations = await this.options.catalog.list();
    } catch (error) {
      await this.fail(event, "automation_catalog_failed", error);
      throw new MacAutomationAdapterError("failed to load macOS Automations", "automation_catalog_failed", {}, { cause: error });
    }

    const runtimeOverride = this.runtimeOverride(event);
    const provisionalSignal = signalFor(event, [], runtimeOverride);
    const matched = automations.filter(automation => automation.definition.enabled && matchTrigger(automation.definition.trigger, provisionalSignal).matched);
    if (matched.length === 0) {
      await this.emit(event, "macos_automation.ignored", { reason: "no_enabled_automation_matched" });
      return {
        status: "ignored",
        event_id: event.event_id,
        session_id: event.session_id,
        signal: provisionalSignal,
        captured_views: [],
        matched_automations: [],
        invocations: [],
        latency: { shortcut_hold_ms: shortcutHoldMs(event), release_to_response_ms: this.elapsed(receivedAt) },
      };
    }
    await this.emit(event, "macos_automation.matched", {
      automations: matched.map(item => `${item.view.id}@${item.view.revision}`),
    });

    let browser: BrowserDomSnapshot | undefined;
    if (isBrowser(event.accessibility.bundle_identifier)) {
      if (!this.options.browser_context) {
        await this.fail(event, "browser_context_failed", "Browser foreground context requires the explicit DOM bridge");
        throw new MacAutomationAdapterError(
          "Browser foreground context requires the explicit DOM bridge",
          "browser_context_failed",
        );
      }
      await this.emit(event, "macos_automation.browser_context_requested", {
        bundle_identifier: event.accessibility.bundle_identifier,
      });
      try {
        browser = await this.options.browser_context.request(event);
      } catch (error) {
        await this.fail(event, "browser_context_failed", error);
        throw new MacAutomationAdapterError("failed to resolve Browser DOM context", "browser_context_failed", {}, { cause: error });
      }
      await this.emit(event, "macos_automation.browser_context_received", {
        request_id: browser.request_id,
        url: browser.url,
        characters: browser.text.length,
      });
    }

    let capturedViews: MacAutomationSubmission["captured_views"];
    try {
      capturedViews = await this.captureEvidence(readyEvent, browser);
    } catch (error) {
      await this.fail(event, "capture_failed", error);
      throw new MacAutomationAdapterError("failed to admit macOS trigger evidence", "capture_failed", {}, { cause: error });
    }
    const signal = signalFor(event, capturedViews.map(item => item.ref), runtimeOverride);
    const invocations: AutomationInvocationResult[] = [];
    try {
      for (const automation of matched) {
        const result = await this.options.runtime.invoke({ automation, signal });
        invocations.push(result);
        await this.emit(event, "macos_automation.invoked", {
          automation: `${automation.view.id}@${automation.view.revision}`,
          status: result.status,
          ...(result.status === "succeeded" || result.status === "failed" || result.status === "duplicate" || result.status === "skipped"
            ? { correlation_id: result.correlation_id }
            : {}),
        });
      }
    } catch (error) {
      await this.fail(event, "automation_invocation_failed", error);
      throw new MacAutomationAdapterError("macOS Automation invocation failed", "automation_invocation_failed", {}, { cause: error });
    }

    return {
      status: "invoked",
      event_id: event.event_id,
      session_id: event.session_id,
      signal,
      captured_views: capturedViews,
      matched_automations: matched.map(item => ({ view_id: item.view.id, revision: item.view.revision })),
      invocations,
      latency: { shortcut_hold_ms: shortcutHoldMs(event), release_to_response_ms: this.elapsed(receivedAt) },
    };
  }

  private runtimeOverride(event: MacVoiceCaptureEvent): TriggerSignal["runtime_override"] {
    if (!event.requested_agent) return undefined;
    const runtime = this.options.agents?.resolve(event.requested_agent);
    if (!runtime) {
      throw new MacAutomationAdapterError(`unknown requested Agent: ${event.requested_agent}`, "unknown_agent", {
        requested_agent: event.requested_agent,
      });
    }
    return { runtime, requested_by: "user", requested_name: event.requested_agent };
  }

  private async captureEvidence(
    event: MacVoiceCaptureEvent & { speech: Extract<MacVoiceCaptureEvent["speech"], { status: "recognized" }>; accessibility: Extract<MacVoiceCaptureEvent["accessibility"], { status: "trusted" }> },
    browser?: BrowserDomSnapshot,
  ): Promise<MacAutomationSubmission["captured_views"]> {
    const inputs: Array<{ role: MacAutomationSubmission["captured_views"][number]["role"]; candidate: ObservationCandidate }> = [
      { role: "voice_utterance", candidate: voiceCandidate(event) },
      { role: "current_app", candidate: accessibilityCandidate(event) },
    ];
    if (browser) inputs.push({ role: "current_page", candidate: browserCandidate(event, browser) });

    const captured: MacAutomationSubmission["captured_views"] = [];
    for (const input of inputs) {
      const receipt = await this.options.capture.ingest(input.candidate);
      const stored = requireStoredReceipt(receipt, input.role);
      const item = { role: input.role, ref: { view_id: stored.view_id, revision: stored.revision }, created: stored.created };
      captured.push(item);
      await this.emit(event, "macos_automation.capture_committed", {
        role: input.role,
        view_id: item.ref.view_id,
        revision: item.ref.revision,
        created: item.created,
      });
    }
    return captured;
  }

  private async emit(event: MacVoiceCaptureEvent, type: MacAutomationAdapterEvent["type"], payload: Record<string, JsonValue>): Promise<void> {
    await this.options.events?.emit({ type, occurred_at: this.now().toISOString(), event_id: event.event_id, session_id: event.session_id, payload });
  }

  private async fail(event: MacVoiceCaptureEvent, code: string, error: unknown): Promise<void> {
    await this.emit(event, "macos_automation.failed", {
      code,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private elapsed(startedAt: number): number {
    return Math.max(0, this.now().getTime() - startedAt);
  }
}

function signalFor(
  event: MacVoiceCaptureEvent,
  evidence: ExactViewRef[],
  runtimeOverride: TriggerSignal["runtime_override"],
): TriggerSignal {
  return parseTriggerSignal({
    id: `macos-voice-signal:${event.event_id}`,
    kind: "user",
    source: "metaflow-mac",
    event: "push_to_talk.release",
    occurred_at: event.shortcut.released_at,
    idempotency_key: `macos-voice:${event.source.connection_id}:${event.session_id}`,
    evidence,
    ...(runtimeOverride ? { runtime_override: runtimeOverride } : {}),
    payload: {
      session_id: event.session_id,
      transcript: event.speech.status === "recognized" ? event.speech.transcript : "",
      app: event.accessibility.status === "trusted" ? event.accessibility.bundle_identifier : "unavailable",
      shortcut_hold_ms: shortcutHoldMs(event),
      has_selection: event.accessibility.status === "trusted" && Boolean(event.accessibility.selected_text),
      ...(event.requested_agent ? { requested_agent: event.requested_agent } : {}),
    },
  });
}

function voiceCandidate(
  event: MacVoiceCaptureEvent & { speech: Extract<MacVoiceCaptureEvent["speech"], { status: "recognized" }> },
): ObservationCandidate {
  return ObservationCandidateSchema.parse({
    idempotency_key: `macos-voice:${event.source.connection_id}:${event.session_id}:utterance`,
    name: "macOS push-to-talk utterance",
    purpose: "Preserve the user utterance recognized for one explicit Ambient invocation",
    schema: { name: "capture.macos.voice_utterance", version: 1, mode: "strict", dialect: "https://json-schema.org/draft/2020-12/schema", json_schema: { type: "object" } },
    observed_at: event.speech.ended_at,
    captured_at: event.captured_at,
    source: {
      connector: event.source.connector,
      connection_id: event.source.connection_id,
      source_id: `${event.session_id}:utterance`,
      source_kind: "apple_speech_recognition",
      identity: "occurrence",
      assertion: "source_derived",
    },
    representation: {
      form: "inline",
      kind: "speech_transcript",
      media_type: "application/json",
      value: {
        transcript: event.speech.transcript,
        locale: event.speech.locale,
        started_at: event.speech.started_at,
        ended_at: event.speech.ended_at,
        ...(event.speech.confidence === undefined ? {} : { confidence: event.speech.confidence }),
      },
    },
    policy: event.privacy,
    metadata: { session_id: event.session_id, recognition_engine: "apple_speech" },
  });
}

function accessibilityCandidate(
  event: MacVoiceCaptureEvent & { accessibility: Extract<MacVoiceCaptureEvent["accessibility"], { status: "trusted" }> },
): ObservationCandidate {
  const ax = event.accessibility;
  return ObservationCandidateSchema.parse({
    idempotency_key: `macos-voice:${event.source.connection_id}:${event.session_id}:accessibility`,
    name: `macOS context: ${ax.app_name}`,
    purpose: "Preserve the exact foreground Accessibility snapshot captured when push-to-talk began",
    schema: { name: "capture.macos.accessibility_snapshot", version: 1, mode: "strict", dialect: "https://json-schema.org/draft/2020-12/schema", json_schema: { type: "object" } },
    observed_at: event.shortcut.pressed_at,
    captured_at: event.captured_at,
    source: {
      connector: event.source.connector,
      connection_id: event.source.connection_id,
      source_id: `${event.session_id}:accessibility`,
      source_kind: "macos_accessibility",
      identity: "occurrence",
      assertion: "direct",
    },
    representation: {
      form: "inline",
      kind: "accessibility_snapshot",
      media_type: "application/json",
      value: {
        app_name: ax.app_name,
        bundle_identifier: ax.bundle_identifier,
        process_id: ax.process_id,
        ...(ax.window_title ? { window_title: ax.window_title } : {}),
        ...(ax.role ? { role: ax.role } : {}),
        ...(ax.subrole ? { subrole: ax.subrole } : {}),
        ...(ax.selected_text ? { selected_text: ax.selected_text } : {}),
        ...(ax.focused_value ? { focused_value: ax.focused_value } : {}),
        ...(ax.field_description ? { field_description: ax.field_description } : {}),
      },
    },
    policy: event.privacy,
    metadata: { session_id: event.session_id },
  });
}

function browserCandidate(event: MacVoiceCaptureEvent, browser: BrowserDomSnapshot): ObservationCandidate {
  return ObservationCandidateSchema.parse({
    idempotency_key: `macos-voice:${event.source.connection_id}:${event.session_id}:browser-dom:${digest(browser.text)}`,
    name: browser.title || browser.url,
    purpose: "Preserve Browser DOM explicitly requested by a macOS voice trigger",
    schema: { name: "capture.browser.page_opened", version: 1, mode: "strict", dialect: "https://json-schema.org/draft/2020-12/schema", json_schema: { type: "object" } },
    observed_at: browser.captured_at,
    captured_at: browser.captured_at,
    source: {
      connector: "chrome-acp",
      connection_id: "chrome-extension",
      source_id: `${browser.window_id}:${browser.tab_id}:${browser.request_id}`,
      source_kind: "browser_dom",
      identity: "occurrence",
      assertion: "direct",
    },
    representation: {
      form: "inline",
      kind: "browser_page",
      media_type: "application/json",
      value: {
        title: browser.title,
        url: browser.url,
        text: browser.text,
        ...(browser.selected_text ? { selected_text: browser.selected_text } : {}),
        dom: browser.dom,
      },
    },
    policy: event.privacy,
    metadata: { ...browser.metadata, request_id: browser.request_id, trigger_session_id: event.session_id },
  });
}

function requireStoredReceipt(receipt: IngestReceipt, role: string): Extract<IngestReceipt, { status: "stored" }> {
  if (receipt.status !== "stored") throw new Error(`macOS ${role} evidence was not retained: ${receipt.reason}`);
  return receipt;
}

function shortcutHoldMs(event: MacVoiceCaptureEvent): number {
  return Math.max(0, Date.parse(event.shortcut.released_at) - Date.parse(event.shortcut.pressed_at));
}

function isBrowser(bundleIdentifier: string): boolean {
  return /^(com\.google\.Chrome|com\.apple\.Safari|org\.mozilla\.firefox|company\.thebrowser\.Browser|com\.microsoft\.edgemac)(\.|$)/i.test(bundleIdentifier);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
