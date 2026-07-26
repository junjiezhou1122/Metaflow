import { TriggerAction } from "iii-sdk";
import {
  parseAutomationView,
  type AutomationInvocationInput,
  type AutomationInvocationPort,
  type AutomationInvocationAdmissionResult,
} from "@info/automation";
import { exactViewRef } from "@info/view";
import { canonicalJson, type JsonValue } from "@info/view";
import type { IiiClientPort } from "./client.js";
import {
  III_AUTOMATION_FUNCTION_ID,
  IiiAutomationInvocationEnvelopeSchema,
  IiiEnqueueReceiptSchema,
  IiiRuntimeError,
  METAFLOW_AUTOMATION_QUEUE,
  assertCompatibleQueueConfiguration,
  automationCorrelationId,
  automationMessageId,
  type IiiQueueConfiguration,
} from "./contracts.js";
import { IiiEventWriter } from "./events.js";

export type IiiAutomationInvocationQueueOptions = {
  client: IiiClientPort;
  queue?: IiiQueueConfiguration;
  events: IiiEventWriter;
  now?: () => string;
};

export class IiiAutomationInvocationQueue implements AutomationInvocationPort {
  private readonly queue: IiiQueueConfiguration;
  private readonly now: () => string;

  constructor(private readonly options: IiiAutomationInvocationQueueOptions) {
    this.queue = assertCompatibleQueueConfiguration(options.queue ?? METAFLOW_AUTOMATION_QUEUE);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async invoke(input: AutomationInvocationInput): Promise<AutomationInvocationAdmissionResult> {
    const automation = parseAutomationView(input.automation.view);
    assertDescriptorSafeSignal(input.signal);
    const automationRef = exactViewRef(automation.view);
    const messageId = automationMessageId({
      automation: automationRef,
      signal_id: input.signal.id,
      ...(input.signal.cascade ? { cascade_attempt_id: input.signal.cascade.attempt_id } : {}),
      predicate_match: input.predicate_match,
      attempt: input.attempt,
      cascade_attempt_id: input.signal.cascade?.attempt_id,
    });
    const correlationId = automationCorrelationId(
      automationRef,
      automation.definition.trigger.id,
      input.signal.id,
    );
    const envelope = IiiAutomationInvocationEnvelopeSchema.parse({
      schema_version: 1,
      contract: "metaflow.automation.invoke.v1",
      message_id: messageId,
      correlation_id: correlationId,
      enqueued_at: this.now(),
      queue: { name: this.queue.name, config_version: this.queue.version },
      automation: automationRef,
      signal: input.signal,
      ...(input.predicate_match ? { predicate_match: input.predicate_match } : {}),
      ...(input.attempt ? { attempt: input.attempt } : {}),
    });

    await this.options.events.emit({
      type: "iii.queue.enqueue_started",
      queue: this.queue.name,
      function_id: III_AUTOMATION_FUNCTION_ID,
      message_id: messageId,
      correlation_id: correlationId,
      automation: automationRef,
      signal_id: input.signal.id,
    });
    try {
      const raw = await this.options.client.trigger<typeof envelope, unknown>({
        function_id: III_AUTOMATION_FUNCTION_ID,
        payload: envelope,
        action: TriggerAction.Enqueue({ queue: this.queue.name }),
      });
      const receipt = IiiEnqueueReceiptSchema.parse(raw);
      await this.options.events.emit({
        type: "iii.queue.enqueued",
        queue: this.queue.name,
        function_id: III_AUTOMATION_FUNCTION_ID,
        message_id: messageId,
        receipt_id: receipt.messageReceiptId,
        correlation_id: correlationId,
        automation: automationRef,
        signal_id: input.signal.id,
        ...(input.signal.cascade ? { cascade_attempt_id: input.signal.cascade.attempt_id } : {}),
      });
      return { status: "enqueued", correlation_id: correlationId, receipt_id: receipt.messageReceiptId };
    } catch (cause) {
      const cancelled = isInvocationStopped(cause);
      await this.options.events.emit({
        type: cancelled ? "iii.queue.cancelled" : "iii.queue.retryable_failure",
        queue: this.queue.name,
        function_id: III_AUTOMATION_FUNCTION_ID,
        message_id: messageId,
        correlation_id: correlationId,
        automation: automationRef,
        signal_id: input.signal.id,
        ...(input.signal.cascade ? { cascade_attempt_id: input.signal.cascade.attempt_id } : {}),
        payload: { message: errorMessage(cause), stage: "enqueue" },
      });
      throw new IiiRuntimeError(
        cancelled ? "III Automation enqueue was cancelled by disconnect" : "III Automation enqueue failed",
        cancelled ? "invocation_cancelled" : "enqueue_failed",
        { cause },
      );
    }
  }
}

const CONTENT_KEYS = new Set([
  "audio",
  "base64",
  "body",
  "bytes",
  "content",
  "html",
  "image",
  "markdown",
  "ocr",
  "selected_text",
  "text",
  "transcript",
  "value",
]);

export function assertDescriptorSafeSignal(signal: AutomationInvocationInput["signal"]): void {
  const bytes = Buffer.byteLength(canonicalJson(signal.payload));
  if (bytes > 32_768) {
    throw new IiiRuntimeError(
      `III Automation signal payload is ${bytes} bytes; descriptor limit is 32768`,
      "signal_payload_not_descriptor_safe",
    );
  }
  inspectDescriptor(signal.payload, "payload");
  if (signal.source === "metaflow.view" && signal.event === "view.committed") {
    const view = recordValue(signal.payload.view);
    const representation = recordValue(view?.representation);
    if (!view || !representation || representation.access !== "descriptor" || "value" in representation) {
      throw new IiiRuntimeError(
        "committed View signals queued through III must use descriptor-only Representation projection",
        "signal_payload_not_descriptor_safe",
      );
    }
  }
}

function inspectDescriptor(value: JsonValue, path: string): void {
  if (typeof value === "string") {
    if (value.length > 2_048) {
      throw new IiiRuntimeError(
        `III Automation signal descriptor string exceeds 2048 characters at ${path}`,
        "signal_payload_not_descriptor_safe",
      );
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectDescriptor(item, `${path}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (CONTENT_KEYS.has(key.toLowerCase()) && item !== null) {
      throw new IiiRuntimeError(
        `III Automation durable queue rejects content field ${path}.${key}; persist content as a governed View and pass its exact ref`,
        "signal_payload_not_descriptor_safe",
      );
    }
    inspectDescriptor(item, `${path}.${key}`);
  }
}

function recordValue(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

export function isInvocationStopped(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "invocation_stopped";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
