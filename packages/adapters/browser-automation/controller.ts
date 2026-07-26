import {
  matchTrigger,
  parseAutomationView,
  parseTriggerSignal,
  type AutomationInvocationResult,
  type AutomationRuntime,
  type ParsedAutomationView,
  type TriggerSignal,
} from "@info/automation";
import type { ExactViewRef, JsonValue, ViewRepository } from "@info/view";
import {
  BrowserAutomationAdapterError,
  parseBrowserPageEvent,
  type BrowserPageEvent,
} from "./contracts.js";

export interface BrowserAutomationCatalog {
  list(): Promise<ParsedAutomationView[]>;
}

export class ViewBrowserAutomationCatalog implements BrowserAutomationCatalog {
  constructor(
    private readonly views: Pick<ViewRepository, "query">,
    private readonly limit = 1_000,
  ) {}

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

export type BrowserAutomationAdapterEvent = {
  type:
    | "browser_automation.received"
    | "browser_automation.matched"
    | "browser_automation.ignored"
    | "browser_automation.capture_committed"
    | "browser_automation.invoked"
    | "browser_automation.failed";
  occurred_at: string;
  event_id: string;
  navigation_id: string;
  payload: Record<string, JsonValue>;
};

export type BrowserAutomationSubmission = {
  status: "ignored" | "invoked";
  event_id: string;
  navigation_id: string;
  signal: TriggerSignal;
  captured_views: Array<{
    role: "current_page" | "current_selection";
    ref: ExactViewRef;
    created: boolean;
  }>;
  matched_automations: ExactViewRef[];
  invocations: AutomationInvocationResult[];
};

export type BrowserAutomationControllerOptions = {
  capture: BrowserAutomationEvidenceCapture;
  catalog: BrowserAutomationCatalog;
  runtime: Pick<AutomationRuntime, "invoke">;
  now?: () => Date;
  events?: { emit(event: BrowserAutomationAdapterEvent): void | Promise<void> };
};

export interface BrowserAutomationEvidenceCapture {
  submitAutomationEvidence(input: BrowserPageEvent): Promise<{
    captured_views: Array<{
      role: "current_page" | "current_selection";
      ref: ExactViewRef;
      created: boolean;
    }>;
  }>;
}

export class BrowserAutomationController {
  private readonly now: () => Date;

  constructor(private readonly options: BrowserAutomationControllerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async submit(input: unknown): Promise<BrowserAutomationSubmission> {
    let event: BrowserPageEvent;
    try {
      event = parseBrowserPageEvent(input);
    } catch (error) {
      if (error instanceof BrowserAutomationAdapterError) throw error;
      throw new BrowserAutomationAdapterError("failed to parse Browser page event", "invalid_browser_event", {}, { cause: error });
    }

    await this.emit(event, "browser_automation.received", {
      url: event.url,
      reason: event.reason,
      dwell_ms: event.dwell_ms,
    });

    let automations: ParsedAutomationView[];
    try {
      automations = await this.options.catalog.list();
    } catch (error) {
      await this.fail(event, "automation_catalog_failed", error);
      throw new BrowserAutomationAdapterError("failed to load Browser Automations", "automation_catalog_failed", {}, { cause: error });
    }

    const provisionalSignal = signalFor(event, []);
    const matched = automations.filter(automation =>
      automation.definition.enabled
      && matchTrigger(automation.definition.trigger, provisionalSignal).matched
    );
    if (matched.length === 0) {
      await this.emit(event, "browser_automation.ignored", { reason: "no_enabled_automation_matched" });
      return {
        status: "ignored",
        event_id: event.event_id,
        navigation_id: event.navigation_id,
        signal: provisionalSignal,
        captured_views: [],
        matched_automations: [],
        invocations: [],
      };
    }

    await this.emit(event, "browser_automation.matched", {
      automations: matched.map(automation => `${automation.view.id}@${automation.view.revision}`),
    });

    if (event.policy.retention === "do_not_store") {
      const error = new BrowserAutomationAdapterError(
        "matched Browser Automation requires exact evidence, but policy forbids storage",
        "required_evidence_not_stored",
        { event_id: event.event_id, automations: matched.map(item => item.view.id) },
      );
      await this.fail(event, error.code, error);
      throw error;
    }

    let capturedViews: BrowserAutomationSubmission["captured_views"];
    try {
      capturedViews = await this.captureEvidence(event);
    } catch (error) {
      await this.fail(event, "capture_failed", error);
      if (error instanceof BrowserAutomationAdapterError) throw error;
      throw new BrowserAutomationAdapterError("failed to admit Browser trigger evidence", "capture_failed", {}, { cause: error });
    }

    const signal = signalFor(event, capturedViews.map(item => item.ref));
    const invocations: AutomationInvocationResult[] = [];
    try {
      for (const automation of matched) {
        const result = await this.options.runtime.invoke({ automation, signal });
        invocations.push(result);
        await this.emit(event, "browser_automation.invoked", {
          automation: `${automation.view.id}@${automation.view.revision}`,
          status: result.status,
          ...(result.status === "succeeded" || result.status === "failed" || result.status === "duplicate" || result.status === "skipped"
            ? { correlation_id: result.correlation_id }
            : {}),
        });
      }
    } catch (error) {
      await this.fail(event, "automation_invocation_failed", error);
      throw new BrowserAutomationAdapterError("Browser Automation invocation failed", "automation_invocation_failed", {}, { cause: error });
    }

    return {
      status: "invoked",
      event_id: event.event_id,
      navigation_id: event.navigation_id,
      signal,
      captured_views: capturedViews,
      matched_automations: matched.map(item => ({ view_id: item.view.id, revision: item.view.revision })),
      invocations,
    };
  }

  private async captureEvidence(event: BrowserPageEvent): Promise<BrowserAutomationSubmission["captured_views"]> {
    const result = await this.options.capture.submitAutomationEvidence(event);
    const expectedRoles: Array<"current_page" | "current_selection"> = event.page.selected_text
      ? ["current_page", "current_selection"]
      : ["current_page"];
    if (
      result.captured_views.length !== expectedRoles.length
      || expectedRoles.some(role => !result.captured_views.some(item => item.role === role))
    ) {
      throw new BrowserAutomationAdapterError(
        "Browser Capture did not return the complete exact evidence set",
        "capture_failed",
        {
          event_id: event.event_id,
          expected_roles: expectedRoles,
          captured_roles: result.captured_views.map(item => item.role),
        },
      );
    }
    for (const item of result.captured_views) {
      await this.emit(event, "browser_automation.capture_committed", {
        role: item.role,
        view_id: item.ref.view_id,
        revision: item.ref.revision,
        created: item.created,
      });
    }
    return result.captured_views;
  }

  private async emit(
    event: BrowserPageEvent,
    type: BrowserAutomationAdapterEvent["type"],
    payload: Record<string, JsonValue>,
  ): Promise<void> {
    await this.options.events?.emit({
      type,
      occurred_at: this.now().toISOString(),
      event_id: event.event_id,
      navigation_id: event.navigation_id,
      payload,
    });
  }

  private async fail(event: BrowserPageEvent, code: string, error: unknown): Promise<void> {
    await this.emit(event, "browser_automation.failed", {
      code,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function signalFor(event: BrowserPageEvent, evidence: ExactViewRef[]): TriggerSignal {
  return parseTriggerSignal({
    id: `browser-signal:${event.event_id}`,
    kind: "event",
    source: event.source.connector,
    event: "browser.page_state",
    occurred_at: event.occurred_at,
    idempotency_key: [
      "browser-event",
      event.source.connector,
      event.source.connection_id,
      event.event_id,
    ].join(":"),
    evidence,
    payload: {
      url: event.url,
      title: event.title,
      domain: event.domain,
      reason: event.reason,
      dwell_ms: event.dwell_ms,
      scroll_depth: event.scroll_depth,
      scroll_events: event.scroll_events,
      selection_count: event.selection_count,
      navigation_id: event.navigation_id,
      tab_id: event.tab_id,
      dom: event.dom,
    },
  });
}
