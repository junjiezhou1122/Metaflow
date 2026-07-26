import { z } from "zod";
import {
  ExactViewRefSchema,
  JsonValueSchema,
  parseViewDraft,
  type ExactViewRef,
  type JsonValue,
  type ViewPolicy,
  type ViewRepository,
} from "@info/view";
import {
  parseAutomationTraceEvent,
  type AutomationEventSink,
} from "./trace.js";

export const AutomationDeliveryActionSchema = z.enum([
  "accept",
  "dismiss",
  "later",
  "cancel",
  "retry",
  "correct",
]);

export type AutomationDeliveryAction = z.infer<typeof AutomationDeliveryActionSchema>;

export const AutomationDeliveryRequestSchema = z.object({
  id: z.string().trim().min(1).max(2_000),
  correlation_id: z.string().trim().min(1).max(2_000),
  phase: z.enum(["accepted", "progress", "result", "failure"]),
  surface: z.string().trim().min(1).max(240),
  urgency: z.enum(["glance", "interrupt", "background"]),
  replacement: z.enum(["replace", "keep_existing"]),
  expires_at: z.string().datetime({ offset: true }).optional(),
  actions: z.array(AutomationDeliveryActionSchema),
  automation: ExactViewRefSchema,
  occurrence_id: z.string().trim().min(1).max(2_000),
  run_id: z.string().trim().min(1).max(1_000).optional(),
  views: z.array(ExactViewRefSchema),
}).strict();

export type AutomationDeliveryRequest = z.infer<typeof AutomationDeliveryRequestSchema>;

export const AutomationDeliveryResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("delivered"),
    delivery_id: z.string().trim().min(1).max(1_000),
    replaced_request_id: z.string().trim().min(1).max(2_000).optional(),
    diagnostics: z.record(JsonValueSchema).optional(),
  }).strict(),
  z.object({ status: z.literal("expired"), expired_at: z.string().datetime({ offset: true }) }).strict(),
  z.object({
    status: z.literal("suppressed"),
    reason: z.literal("surface_occupied"),
    active_request_id: z.string().trim().min(1).max(2_000),
  }).strict(),
  z.object({ status: z.literal("unavailable"), error: z.string().trim().min(1) }).strict(),
  z.object({
    status: z.literal("failed"),
    error: z.string().trim().min(1),
    diagnostics: z.record(JsonValueSchema).optional(),
  }).strict(),
]);

export type AutomationDeliveryResult = z.infer<typeof AutomationDeliveryResultSchema>;

export interface AutomationDeliveryPort {
  deliver(request: AutomationDeliveryRequest): Promise<AutomationDeliveryResult>;
}

export type AutomationDeliveryAttempt = {
  request: AutomationDeliveryRequest;
  result: AutomationDeliveryResult;
};

export type AutomationDeliveryLedgerEntry = AutomationDeliveryAttempt & {
  recorded_at: string;
};

export interface AutomationDeliveryLedger {
  record(entry: AutomationDeliveryLedgerEntry): Promise<void>;
  findByRequestId(request_id: string): Promise<AutomationDeliveryLedgerEntry | undefined>;
  findByDeliveryId(delivery_id: string): Promise<AutomationDeliveryLedgerEntry | undefined>;
}

export class InMemoryAutomationDeliveryLedger implements AutomationDeliveryLedger {
  private readonly byRequest = new Map<string, AutomationDeliveryLedgerEntry>();
  private readonly requestByDelivery = new Map<string, string>();

  async record(entry: AutomationDeliveryLedgerEntry): Promise<void> {
    const existing = this.byRequest.get(entry.request.id);
    if (existing) {
      if (!sameDeliveryAttempt(existing, entry)) {
        throw new Error(`Delivery request id conflict: ${entry.request.id}`);
      }
      return;
    }
    if (entry.result.status === "delivered") {
      const owner = this.requestByDelivery.get(entry.result.delivery_id);
      if (owner && owner !== entry.request.id) {
        throw new Error(`Delivery id conflict: ${entry.result.delivery_id}`);
      }
      this.requestByDelivery.set(entry.result.delivery_id, entry.request.id);
    }
    this.byRequest.set(entry.request.id, entry);
  }

  async findByRequestId(requestId: string): Promise<AutomationDeliveryLedgerEntry | undefined> {
    return this.byRequest.get(requestId);
  }

  async findByDeliveryId(deliveryId: string): Promise<AutomationDeliveryLedgerEntry | undefined> {
    const requestId = this.requestByDelivery.get(deliveryId);
    return requestId ? this.byRequest.get(requestId) : undefined;
  }
}

export type AutomationSurfaceRenderer = {
  surface: string;
  capacity: "single" | "multiple";
  render(request: AutomationDeliveryRequest): Promise<{
    delivery_id: string;
    diagnostics?: Record<string, JsonValue>;
  }>;
  withdraw?(input: {
    delivery_id: string;
    request_id: string;
    reason: "replaced" | "expired" | "interaction";
  }): Promise<void>;
};

export const AutomationDeliveryInteractionSchema = z.object({
  id: z.string().trim().min(1).max(180),
  request_id: z.string().trim().min(1).max(2_000),
  delivery_id: z.string().trim().min(1).max(1_000),
  surface: z.string().trim().min(1).max(240),
  action: AutomationDeliveryActionSchema,
  occurred_at: z.string().datetime({ offset: true }),
  actor: z.string().trim().min(1).max(240),
  snooze_until: z.string().datetime({ offset: true }).optional(),
  correction: z.string().trim().min(1).max(20_000).optional(),
  metadata: z.record(JsonValueSchema).default({}),
}).strict().superRefine((interaction, context) => {
  if (interaction.action === "later" && !interaction.snooze_until) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "later requires snooze_until", path: ["snooze_until"] });
  }
  if (interaction.action === "correct" && !interaction.correction) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "correct requires correction", path: ["correction"] });
  }
  if (interaction.action !== "later" && interaction.snooze_until) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "snooze_until is only valid for later", path: ["snooze_until"] });
  }
  if (interaction.action !== "correct" && interaction.correction) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "correction is only valid for correct", path: ["correction"] });
  }
});

export type AutomationDeliveryInteraction = z.infer<typeof AutomationDeliveryInteractionSchema>;

export interface AutomationFeedbackRecorder {
  record(input: {
    request: AutomationDeliveryRequest;
    interaction: AutomationDeliveryInteraction;
    policy: ViewPolicy;
  }): Promise<{ feedback_view: ExactViewRef; created: boolean }>;
}

export interface AutomationInteractionCommandPort {
  handle(input: {
    request: AutomationDeliveryRequest;
    interaction: AutomationDeliveryInteraction;
    feedback_view: ExactViewRef;
    idempotency_key: string;
  }): Promise<{ status: "handled" | "not_applicable"; command_id?: string }>;
}

export type AutomationInteractionResult = {
  feedback_view: ExactViewRef;
  replayed: boolean;
  command:
    | { status: "handled" | "not_applicable"; command_id?: string }
    | { status: "replayed" }
    | { status: "failed"; error: string };
};

export class AutomationDeliveryError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_delivery" | "invalid_interaction" | "unknown_delivery" | "interaction_mismatch" | "trace_failed",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AutomationDeliveryError";
  }
}

export type AutomationDeliveryCoordinatorOptions = {
  renderers: AutomationSurfaceRenderer[];
  ledger: AutomationDeliveryLedger;
  feedback: AutomationFeedbackRecorder;
  commands: AutomationInteractionCommandPort;
  events: AutomationEventSink;
  now?: () => Date;
};

type DeliveredItem = {
  request: AutomationDeliveryRequest;
  delivery_id: string;
  renderer: AutomationSurfaceRenderer;
};

export class AutomationDeliveryCoordinator implements AutomationDeliveryPort {
  private readonly renderers: Map<string, AutomationSurfaceRenderer>;
  private readonly active = new Map<string, DeliveredItem>();
  private readonly rendered = new Map<string, DeliveredItem>();
  private readonly now: () => Date;

  constructor(private readonly options: AutomationDeliveryCoordinatorOptions) {
    this.renderers = new Map(options.renderers.map(renderer => [renderer.surface, renderer]));
    if (this.renderers.size !== options.renderers.length) {
      throw new Error("Delivery renderer surfaces must be unique");
    }
    this.now = options.now ?? (() => new Date());
  }

  async deliver(request: AutomationDeliveryRequest): Promise<AutomationDeliveryResult> {
    const parsed = AutomationDeliveryRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new AutomationDeliveryError("invalid Delivery request", "invalid_delivery", { cause: parsed.error });
    }
    request = parsed.data;
    const replay = await this.options.ledger.findByRequestId(request.id);
    if (replay) {
      if (JSON.stringify(replay.request) !== JSON.stringify(request)) {
        throw new AutomationDeliveryError(`Delivery request id conflict: ${request.id}`, "invalid_delivery");
      }
      return replay.result;
    }

    const now = this.now();
    if (request.expires_at && Date.parse(request.expires_at) <= now.getTime()) {
      return this.record(request, { status: "expired", expired_at: request.expires_at });
    }

    const renderer = this.renderers.get(request.surface);
    if (!renderer) {
      return this.record(request, { status: "unavailable", error: `Delivery surface is unavailable: ${request.surface}` });
    }

    let replaced: DeliveredItem | undefined;
    if (renderer.capacity === "single") {
      const current = this.active.get(renderer.surface);
      if (current) {
        if (current.request.expires_at && Date.parse(current.request.expires_at) <= now.getTime()) {
          const expired = await this.withdraw(current, "expired");
          if (expired) return this.record(request, expired, now);
        } else if (request.replacement === "keep_existing") {
          return this.record(request, { status: "suppressed", reason: "surface_occupied", active_request_id: current.request.id });
        } else {
          const withdrawn = await this.withdraw(current, "replaced");
          if (withdrawn) return this.record(request, withdrawn, now);
          replaced = current;
        }
      }
    }

    let rendered: Awaited<ReturnType<AutomationSurfaceRenderer["render"]>>;
    try {
      rendered = await renderer.render(request);
    } catch (error) {
      return this.record(request, { status: "failed", error: errorMessage(error) }, now);
    }

    const result = AutomationDeliveryResultSchema.safeParse({
      status: "delivered",
      delivery_id: rendered.delivery_id,
      ...(replaced ? { replaced_request_id: replaced.request.id } : {}),
      ...(rendered.diagnostics ? { diagnostics: rendered.diagnostics } : {}),
    });
    if (!result.success) {
      await this.withdrawUnrecorded(renderer, request, rendered.delivery_id);
      throw new AutomationDeliveryError("renderer returned an invalid Delivery result", "invalid_delivery", { cause: result.error });
    }
    try {
      await this.options.ledger.record({ request, result: result.data, recorded_at: now.toISOString() });
    } catch (error) {
      await this.withdrawUnrecorded(renderer, request, rendered.delivery_id);
      throw new AutomationDeliveryError(`failed to persist Delivery request ${request.id}`, "invalid_delivery", { cause: error });
    }
    const renderedItem = { request, delivery_id: rendered.delivery_id, renderer };
    this.rendered.set(rendered.delivery_id, renderedItem);
    if (renderer.capacity === "single") {
      this.active.set(renderer.surface, renderedItem);
    }
    return result.data;
  }

  async interact(input: {
    interaction: unknown;
    policy: ViewPolicy;
  }): Promise<AutomationInteractionResult> {
    const parsed = AutomationDeliveryInteractionSchema.safeParse(input.interaction);
    if (!parsed.success) {
      throw new AutomationDeliveryError("invalid Delivery interaction", "invalid_interaction", { cause: parsed.error });
    }
    const interaction = parsed.data;
    const entry = await this.options.ledger.findByDeliveryId(interaction.delivery_id);
    if (!entry || entry.result.status !== "delivered") {
      throw new AutomationDeliveryError(`unknown delivery: ${interaction.delivery_id}`, "unknown_delivery");
    }
    const delivered = {
      request: entry.request,
      delivery_id: entry.result.delivery_id,
    };
    if (
      interaction.request_id !== delivered.request.id
      || interaction.surface !== delivered.request.surface
      || !delivered.request.actions.includes(interaction.action)
    ) {
      throw new AutomationDeliveryError("Delivery interaction does not match its request", "interaction_mismatch");
    }

    const recorded = await this.options.feedback.record({ request: delivered.request, interaction, policy: input.policy });
    try {
      await this.options.events.emit(parseAutomationTraceEvent({
        type: "automation.feedback_recorded",
        source: "feedback",
        occurred_at: interaction.occurred_at,
        correlation_id: delivered.request.correlation_id,
        automation: delivered.request.automation,
        occurrence_id: delivered.request.occurrence_id,
        run_id: delivered.request.run_id,
        attempt_id: interaction.id,
        payload: {
          interaction_id: interaction.id,
          action: interaction.action,
          request_id: delivered.request.id,
          delivery_id: delivered.delivery_id,
          feedback_view: recorded.feedback_view,
          created: recorded.created,
        },
      }));
    } catch (error) {
      throw new AutomationDeliveryError("failed to persist Automation feedback trace", "trace_failed", { cause: error });
    }
    const renderedItem = this.rendered.get(delivered.delivery_id);
    if (renderedItem) {
      const withdrawal = await this.withdraw(renderedItem, "interaction");
      if (withdrawal) {
        return {
          feedback_view: recorded.feedback_view,
          replayed: !recorded.created,
          command: { status: "failed", error: withdrawal.error },
        };
      }
    }
    try {
      const command = await this.options.commands.handle({
        request: delivered.request,
        interaction,
        feedback_view: recorded.feedback_view,
        idempotency_key: `automation-interaction:${interaction.id}`,
      });
      return { feedback_view: recorded.feedback_view, replayed: !recorded.created, command };
    } catch (error) {
      return {
        feedback_view: recorded.feedback_view,
        replayed: !recorded.created,
        command: { status: "failed", error: errorMessage(error) },
      };
    }
  }

  activeRequest(surface: string): AutomationDeliveryRequest | undefined {
    return this.active.get(surface)?.request;
  }

  private async record(
    request: AutomationDeliveryRequest,
    result: AutomationDeliveryResult,
    recordedAt = this.now(),
  ): Promise<AutomationDeliveryResult> {
    const parsed = AutomationDeliveryResultSchema.safeParse(result);
    if (!parsed.success) {
      throw new AutomationDeliveryError("invalid Delivery result", "invalid_delivery", { cause: parsed.error });
    }
    await this.options.ledger.record({ request, result: parsed.data, recorded_at: recordedAt.toISOString() });
    return parsed.data;
  }

  private async withdrawUnrecorded(
    renderer: AutomationSurfaceRenderer,
    request: AutomationDeliveryRequest,
    deliveryId: string,
  ): Promise<void> {
    if (!renderer.withdraw) {
      throw new AutomationDeliveryError(
        `Delivery ${deliveryId} was rendered but cannot be withdrawn after persistence failed`,
        "invalid_delivery",
      );
    }
    try {
      await renderer.withdraw({ delivery_id: deliveryId, request_id: request.id, reason: "interaction" });
    } catch (error) {
      throw new AutomationDeliveryError(
        `failed to withdraw unrecorded Delivery ${deliveryId}: ${errorMessage(error)}`,
        "invalid_delivery",
        { cause: error },
      );
    }
  }

  private async withdraw(
    item: DeliveredItem,
    reason: "replaced" | "expired" | "interaction",
  ): Promise<Extract<AutomationDeliveryResult, { status: "failed" }> | undefined> {
    if (!item.renderer.withdraw) {
      return { status: "failed", error: `Delivery renderer cannot withdraw ${item.delivery_id}` };
    }
    try {
      await item.renderer.withdraw({ delivery_id: item.delivery_id, request_id: item.request.id, reason });
      this.rendered.delete(item.delivery_id);
      this.active.delete(item.request.surface);
      return undefined;
    } catch (error) {
      return { status: "failed", error: `failed to withdraw ${item.delivery_id}: ${errorMessage(error)}` };
    }
  }
}

export class AutomationFeedbackViewService implements AutomationFeedbackRecorder {
  constructor(private readonly views: Pick<ViewRepository, "commit">) {}

  async record(input: {
    request: AutomationDeliveryRequest;
    interaction: AutomationDeliveryInteraction;
    policy: ViewPolicy;
  }): Promise<{ feedback_view: ExactViewRef; created: boolean }> {
    const refs = uniqueRefs([input.request.automation, ...input.request.views]);
    const value = {
      version: 1,
      interaction_id: input.interaction.id,
      action: input.interaction.action,
      occurred_at: input.interaction.occurred_at,
      actor: input.interaction.actor,
      delivery: {
        request_id: input.request.id,
        delivery_id: input.interaction.delivery_id,
        surface: input.request.surface,
        phase: input.request.phase,
        urgency: input.request.urgency,
      },
      invocation: {
        correlation_id: input.request.correlation_id,
        automation: input.request.automation,
        occurrence_id: input.request.occurrence_id,
        ...(input.request.run_id ? { run_id: input.request.run_id } : {}),
      },
      result_views: input.request.views,
      ...(input.interaction.snooze_until ? { snooze_until: input.interaction.snooze_until } : {}),
      ...(input.interaction.correction ? { correction: input.interaction.correction } : {}),
      metadata: input.interaction.metadata,
    };
    const draft = parseViewDraft({
      id: `automation-feedback:${input.interaction.id}`,
      name: `Automation feedback: ${input.interaction.action}`,
      purpose: "Record one user interaction with an exact Ambient delivery and its result Views",
      schema: {
        name: "metaflow.automation.feedback",
        version: 1,
        mode: "strict",
        dialect: "https://json-schema.org/draft/2020-12/schema",
        json_schema: feedbackJsonSchema(),
      },
      role: "derived",
      time: { observed_at: input.interaction.occurred_at, created_at: input.interaction.occurred_at },
      representation: { form: "inline", kind: "automation_feedback", media_type: "application/json", value },
      materialization: {
        primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
      },
      relations: [
        { type: "feedback_for_automation", target: input.request.automation, metadata: { action: input.interaction.action } },
        ...input.request.views.map(target => ({
          type: "feedback_for_result",
          target,
          metadata: { action: input.interaction.action },
        })),
      ],
      provenance: { inputs: refs, actor: input.interaction.actor },
      policy: input.policy,
      metadata: {
        correlation_id: input.request.correlation_id,
        occurrence_id: input.request.occurrence_id,
        ...(input.request.run_id ? { run_id: input.request.run_id } : {}),
      },
    });
    const committed = await this.views.commit({
      draft,
      expected_revision: 0,
      idempotency_key: `automation-feedback:${input.interaction.id}`,
    });
    return {
      feedback_view: { view_id: committed.view.id, revision: committed.view.revision },
      created: committed.created,
    };
  }
}

function feedbackJsonSchema() {
  return {
    type: "object",
    required: ["version", "interaction_id", "action", "occurred_at", "actor", "delivery", "invocation", "result_views", "metadata"],
    additionalProperties: false,
    properties: {
      version: { const: 1 },
      interaction_id: { type: "string", minLength: 1 },
      action: { enum: AutomationDeliveryActionSchema.options },
      occurred_at: { type: "string" },
      actor: { type: "string", minLength: 1 },
      delivery: { type: "object" },
      invocation: { type: "object" },
      result_views: { type: "array", items: { type: "object" } },
      snooze_until: { type: "string" },
      correction: { type: "string", minLength: 1 },
      metadata: { type: "object" },
    },
  };
}

function uniqueRefs(refs: ExactViewRef[]): ExactViewRef[] {
  const seen = new Set<string>();
  return refs.filter(ref => {
    const key = `${ref.view_id}@${ref.revision}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameDeliveryAttempt(left: AutomationDeliveryAttempt, right: AutomationDeliveryAttempt): boolean {
  return JSON.stringify(left.request) === JSON.stringify(right.request)
    && JSON.stringify(left.result) === JSON.stringify(right.result);
}
