import { createHash } from "node:crypto";
import {
  createTriggerOccurrence,
  matchTrigger,
} from "./matching.js";
import { canonicalJson, ExactViewRefSchema, type JsonValue } from "@info/view";
import { TriggerOccurrenceSchema } from "./contracts.js";
import type {
  AutomationDefinition,
  ExactViewRef,
  ParsedAutomationView,
  TriggerDefinition,
  TriggerOccurrence,
  TriggerPredicate,
  TriggerSignal,
} from "./contracts.js";
import type { TriggerMatchResult } from "./matching.js";
import type {
  AutomationContextResolverPort,
  ResolvedAutomationContext,
} from "./context.js";
import { AutomationContextResolutionError } from "./context.js";
import type {
  AutomationDeliveryAttempt,
  AutomationDeliveryPort,
  AutomationDeliveryRequest,
  AutomationDeliveryResult,
} from "./delivery.js";
import {
  parseAutomationTraceEvent,
  type AutomationEventSink,
  type AutomationFailure,
  type AutomationTargetTraceEvent,
  type AutomationTraceEventInput,
  type AutomationTraceEventType,
} from "./trace.js";
import type { ReactiveCascadeLedger } from "./cascade.js";

export type OccurrenceReservation =
  | { created: true; recovered?: true }
  | {
      created: false;
      reason: "duplicate" | "cooldown" | "concurrency";
      correlation_id: string;
      status: "reserved" | "succeeded" | "failed";
    };

export interface AutomationOccurrenceRepository {
  reserve(input: {
    idempotency_key: string;
    correlation_id: string;
    occurrence: TriggerOccurrence;
    reserved_at: string;
    attempt_id: string;
    lease_duration_ms: number;
    limits: Pick<AutomationDefinition["limits"], "cooldown_ms" | "max_concurrency">;
  }): Promise<OccurrenceReservation>;
  finalize(input: {
    idempotency_key: string;
    correlation_id: string;
    status: "succeeded" | "failed";
    run_id?: string;
    error?: string;
  }): Promise<void>;
}

export type AutomationTargetRequest = {
  correlation_id: string;
  automation: ExactViewRef;
  policy_snapshot: ParsedAutomationView["view"]["policy"];
  occurrence: TriggerOccurrence;
  target: AutomationDefinition["target"];
  context: ResolvedAutomationContext;
  requested_delivery: AutomationDefinition["delivery"];
  runtime_override?: TriggerOccurrence["runtime_override"];
  timeout_ms?: number;
  cascade?: TriggerOccurrence["cascade"];
  pre_execution_failure?: {
    code: string;
    message: string;
    stage: "authorization" | "execution" | "validation" | "commit";
    details?: Record<string, JsonValue>;
  };
};

export type AutomationTargetResult =
  | {
      status: "succeeded";
      run_id: string;
      output_views: ExactViewRef[];
    }
  | {
      status: "failed";
      run_id: string;
      failure_view: ExactViewRef;
      failure: {
        stage: "authorization" | "execution" | "validation" | "commit";
        code: string;
        message: string;
        diagnostics?: Record<string, JsonValue>;
      };
    };

export type AutomationTargetProgress = {
  run_id: string;
  views: ExactViewRef[];
};

export type AutomationTargetExecutionContext = {
  progress(update: AutomationTargetProgress): Promise<void>;
  trace(event: AutomationTargetTraceEvent): Promise<void>;
};

export type AutomationInvocationAttempt = {
  id: string;
  parent_attempt_id?: string;
  reason: "retry" | "alternative_context" | "alternative_agent" | "alternative_delivery";
};

export interface AutomationTargetExecutor {
  execute(
    request: AutomationTargetRequest,
    context: AutomationTargetExecutionContext,
  ): Promise<AutomationTargetResult>;
}

export type AutomationInvocationResult =
  | { status: "ignored"; reason: string }
  | { status: "duplicate"; correlation_id: string; existing_status: "reserved" | "succeeded" | "failed" }
  | { status: "skipped"; reason: "cooldown" | "concurrency"; correlation_id: string; existing_status: "reserved" | "succeeded" | "failed" }
  | {
      status: "succeeded";
      correlation_id: string;
      occurrence: TriggerOccurrence;
      run_id: string;
      output_views: ExactViewRef[];
      deliveries: AutomationDeliveryAttempt[];
    }
  | {
      status: "failed";
      correlation_id: string;
      occurrence: TriggerOccurrence;
      run_id: string;
      failure_view: ExactViewRef;
      error: string;
      failure: Extract<AutomationTargetResult, { status: "failed" }>["failure"];
      deliveries: AutomationDeliveryAttempt[];
    };

export type AutomationInvocationAdmissionResult = AutomationInvocationResult | {
  status: "enqueued";
  correlation_id: string;
  receipt_id: string;
};

export type AutomationInvocationPredicateMatch = {
  automation: ExactViewRef;
  trigger_id: string;
  signal_id: string;
  predicate_digest: string;
  matched: true;
  reason: string;
};

export type AutomationInvocationInput = {
  automation: ParsedAutomationView;
  signal: TriggerSignal;
  predicate_match?: AutomationInvocationPredicateMatch;
  attempt?: AutomationInvocationAttempt;
};

export interface AutomationInvocationPort {
  invoke(input: AutomationInvocationInput): Promise<AutomationInvocationAdmissionResult>;
}

export type AutomationRuntimeOptions = {
  occurrences: AutomationOccurrenceRepository;
  context: AutomationContextResolverPort;
  target: AutomationTargetExecutor;
  delivery: AutomationDeliveryPort;
  events: AutomationEventSink;
  cascades?: ReactiveCascadeLedger;
  now?: () => Date;
};

export class AutomationRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: "occurrence_reservation_failed" | "context_resolution_failed" | "target_execution_failed" | "occurrence_finalize_failed" | "trace_persistence_failed",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AutomationRuntimeError";
  }
}

export class AutomationRuntime {
  private readonly now: () => Date;

  constructor(private readonly options: AutomationRuntimeOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async invoke(input: AutomationInvocationInput): Promise<AutomationInvocationResult> {
    const invocationStartedAt = this.now().getTime();
    const automation = { view_id: input.automation.view.id, revision: input.automation.view.revision };
    const match = invocationMatch(input);
    if (!input.automation.definition.enabled || !match.matched) {
      const reason = input.automation.definition.enabled ? match.reason : "Automation is disabled";
      await this.emit({
        type: "automation.occurrence_ignored",
        occurred_at: this.nowIso(),
        correlation_id: ignoredCorrelationId(automation, input.signal.id),
        automation,
        payload: { reason, signal_id: input.signal.id },
      });
      return { status: "ignored", reason };
    }
    if (input.signal.cascade && !this.options.cascades) {
      throw new AutomationRuntimeError(
        `Reactive cascade ledger is required for ${input.signal.cascade.attempt_id}`,
        "occurrence_reservation_failed",
      );
    }

    const baseOccurrence = createTriggerOccurrence({
      automation,
      definition: input.automation.definition,
      signal: input.signal,
      match,
    });
    const attempt = invocationAttempt(input.attempt, baseOccurrence.id);
    const occurrence = input.attempt
      ? TriggerOccurrenceSchema.parse({
          ...baseOccurrence,
          id: `${baseOccurrence.id}:attempt:${attempt.id}`,
          idempotency_key: `${baseOccurrence.idempotency_key}:attempt:${attempt.id}`,
        })
      : baseOccurrence;
    const correlationId = occurrence.id;
    await this.emit({
      type: "automation.occurrence_received",
      occurred_at: this.nowIso(),
      correlation_id: correlationId,
      automation,
      occurrence_id: occurrence.id,
      attempt_id: attempt.id,
      parent_attempt_id: attempt.parent_attempt_id,
      payload: {
        trigger_id: occurrence.trigger_id,
        trigger_kind: occurrence.trigger_kind,
        signal_id: input.signal.id,
        match: occurrence.match,
        evidence: occurrence.evidence,
        signal_payload: occurrence.payload,
      },
    });
    if (attempt.parent_attempt_id && attempt.reason) {
      await this.emit({
        type: "automation.attempt_linked",
        occurred_at: this.nowIso(),
        correlation_id: correlationId,
        automation,
        occurrence_id: occurrence.id,
        attempt_id: attempt.id,
        parent_attempt_id: attempt.parent_attempt_id,
        payload: { reason: attempt.reason },
      });
    }

    let reservation: OccurrenceReservation;
    try {
      reservation = await this.options.occurrences.reserve({
        idempotency_key: occurrence.idempotency_key,
        correlation_id: correlationId,
        occurrence,
        reserved_at: this.nowIso(),
        attempt_id: attempt.id,
        lease_duration_ms: input.signal.cascade?.policy.limits.reservation_lease_ms
          ?? Math.max(input.automation.definition.limits.timeout_ms ?? 0, 300_000),
        limits: {
          cooldown_ms: input.automation.definition.limits.cooldown_ms,
          max_concurrency: input.automation.definition.limits.max_concurrency,
        },
      });
    } catch (error) {
      await this.emitRuntimeFailure(automation, occurrence, correlationId, undefined, "occurrence_reservation_failed", error);
      throw new AutomationRuntimeError("failed to reserve Automation occurrence", "occurrence_reservation_failed", { cause: error });
    }

    if (!reservation.created) {
      await this.emit({
        type: reservation.reason === "duplicate" ? "automation.occurrence_deduped" : "automation.occurrence_rejected",
        occurred_at: this.nowIso(),
        correlation_id: reservation.correlation_id,
        automation,
        occurrence_id: occurrence.id,
        payload: { idempotency_key: occurrence.idempotency_key, reason: reservation.reason, existing_status: reservation.status },
      });
      if (reservation.reason !== "duplicate") {
        await this.stopCascade(occurrence, `automation_${reservation.reason}`, `Automation occurrence was skipped by ${reservation.reason}`);
        return {
          status: "skipped",
          reason: reservation.reason,
          correlation_id: reservation.correlation_id,
          existing_status: reservation.status,
        };
      }
      return {
        status: "duplicate",
        correlation_id: reservation.correlation_id,
        existing_status: reservation.status,
      };
    }

    await this.emit({
      type: "automation.occurrence_reserved",
      occurred_at: this.nowIso(),
      correlation_id: correlationId,
      automation,
      occurrence_id: occurrence.id,
      payload: { idempotency_key: occurrence.idempotency_key },
    });

    const deliveries: AutomationDeliveryAttempt[] = [];
    let deliveryBatch = 0;
    try {
      deliveries.push(...await this.deliverPhase({
        definition: input.automation.definition,
        automation,
        occurrence,
        correlationId,
        phase: "accepted",
        views: [],
        onlyProgress: true,
        batch: deliveryBatch++,
      }));

      let resolvedContext: ResolvedAutomationContext;
      let preExecutionFailure: AutomationTargetRequest["pre_execution_failure"];
      const contextStartedAt = this.now().getTime();
      try {
        resolvedContext = await this.options.context.resolve({ automation: input.automation, occurrence });
        await this.emit({
          type: "automation.context_resolved",
          occurred_at: this.nowIso(),
          correlation_id: correlationId,
          automation,
          occurrence_id: occurrence.id,
          duration_ms: this.elapsed(contextStartedAt),
          payload: {
            disclosed_views: resolvedContext.disclosed_views,
            attempts: resolvedContext.attempts,
          },
        });
      } catch (error) {
        const failure = contextFailure(error);
        await this.emit({
          type: "automation.context_failed",
          occurred_at: this.nowIso(),
          correlation_id: correlationId,
          automation,
          occurrence_id: occurrence.id,
          duration_ms: this.elapsed(contextStartedAt),
          failure,
          payload: {
            role: error instanceof AutomationContextResolutionError ? error.role : "unknown",
            attempts: error instanceof AutomationContextResolutionError ? error.attempts : [],
          },
        });
        if (occurrence.cascade && error instanceof AutomationContextResolutionError) {
          resolvedContext = error.failure_context;
          preExecutionFailure = {
            code: failure.code,
            message: failure.message,
            stage: error.code === "view_access_denied" ? "authorization" : "validation",
            details: {
              role: error.role,
              context_error_code: error.code,
            },
          };
        } else {
          await this.finalize(automation, occurrence, correlationId, "failed", undefined, failure.message);
          await this.stopCascade(occurrence, failure.code, failure.message);
          throw new AutomationRuntimeError("Automation context resolution failed", "context_resolution_failed", { cause: error });
        }
      }

      await this.emit({
        type: "automation.run_started",
        occurred_at: this.nowIso(),
        correlation_id: correlationId,
        automation,
        occurrence_id: occurrence.id,
        payload: { target: input.automation.definition.target },
      });

      const targetStartedAt = this.now().getTime();
      const observedRunIds = new Set<string>();
      const targetResult = await this.options.target.execute({
        correlation_id: correlationId,
        automation,
        policy_snapshot: input.automation.view.policy,
        occurrence,
        target: input.automation.definition.target,
        context: resolvedContext,
        requested_delivery: input.automation.definition.delivery,
        ...(occurrence.runtime_override ? { runtime_override: occurrence.runtime_override } : {}),
        timeout_ms: input.automation.definition.limits.timeout_ms,
        ...(occurrence.cascade ? { cascade: occurrence.cascade } : {}),
        ...(preExecutionFailure ? { pre_execution_failure: preExecutionFailure } : {}),
      }, {
        progress: async update => {
          const parsedViews = update.views.map(view => ExactViewRefSchema.safeParse(view));
          if (!update.run_id.trim() || parsedViews.length === 0 || parsedViews.some(view => !view.success)) {
            throw new Error("Automation target progress requires run_id and at least one exact View");
          }
          const views = parsedViews.map(view => {
            if (!view.success) throw view.error;
            return view.data;
          });
          observedRunIds.add(update.run_id);
          await this.emit({
            type: "automation.run_progress",
            occurred_at: this.nowIso(),
            correlation_id: correlationId,
            automation,
            occurrence_id: occurrence.id,
            run_id: update.run_id,
            payload: { views },
          });
          deliveries.push(...await this.deliverPhase({
            definition: input.automation.definition,
            automation,
            occurrence,
            correlationId,
            phase: "progress",
            runId: update.run_id,
            views,
            onlyProgress: true,
            batch: deliveryBatch++,
          }));
        },
        trace: async event => {
          observedRunIds.add(event.run_id);
          const failure = event.type === "agent.failed"
            ? event.failure ?? agentFailure(event)
            : event.failure;
          await this.emit({
            type: "automation.agent_event",
            source: "agent",
            occurred_at: event.occurred_at,
            correlation_id: correlationId,
            automation,
            occurrence_id: occurrence.id,
            run_id: event.run_id,
            attempt_id: event.attempt_id ?? event.invocation_id,
            parent_attempt_id: event.parent_attempt_id,
            failure,
            payload: {
              agent_event_type: event.type,
              invocation_id: event.invocation_id,
              runtime: event.runtime,
              transformation: event.transformation,
              ...(event.payload ? { event_payload: event.payload } : {}),
            },
          });
        },
      });

      if ([...observedRunIds].some(runId => runId !== targetResult.run_id)) {
        throw new Error(`Automation target event Run does not match result Run: ${[...observedRunIds].join(", ")} != ${targetResult.run_id}`);
      }

      if (targetResult.status === "failed") {
        await this.emit({
          type: "automation.execution_failed",
          occurred_at: this.nowIso(),
          correlation_id: correlationId,
          automation,
          occurrence_id: occurrence.id,
          run_id: targetResult.run_id,
          duration_ms: this.elapsed(targetStartedAt),
          failure: { ...targetResult.failure, failure_view: targetResult.failure_view },
          payload: {},
        });
        deliveries.push(...await this.deliverPhase({
          definition: input.automation.definition,
          automation,
          occurrence,
          correlationId,
          phase: "failure",
          runId: targetResult.run_id,
          views: [targetResult.failure_view],
          batch: deliveryBatch++,
        }));
        await this.finalize(automation, occurrence, correlationId, "failed", targetResult.run_id, targetResult.failure.message);
        return {
          status: "failed",
          correlation_id: correlationId,
          occurrence,
          run_id: targetResult.run_id,
          failure_view: targetResult.failure_view,
          error: targetResult.failure.message,
          failure: targetResult.failure,
          deliveries,
        };
      }

      await this.emit({
        type: "automation.result_committed",
        occurred_at: this.nowIso(),
        correlation_id: correlationId,
        automation,
        occurrence_id: occurrence.id,
        run_id: targetResult.run_id,
        duration_ms: this.elapsed(targetStartedAt),
        payload: { output_views: targetResult.output_views },
      });
      deliveries.push(...await this.deliverPhase({
        definition: input.automation.definition,
        automation,
        occurrence,
        correlationId,
        phase: "result",
        runId: targetResult.run_id,
        views: targetResult.output_views,
        batch: deliveryBatch++,
      }));
      await this.finalize(automation, occurrence, correlationId, "succeeded", targetResult.run_id);
      await this.emit({
        type: "automation.occurrence_completed",
        occurred_at: this.nowIso(),
        correlation_id: correlationId,
        automation,
        occurrence_id: occurrence.id,
        run_id: targetResult.run_id,
        duration_ms: this.elapsed(invocationStartedAt),
        payload: { status: "succeeded" },
      });
      return {
        status: "succeeded",
        correlation_id: correlationId,
        occurrence,
        run_id: targetResult.run_id,
        output_views: targetResult.output_views,
        deliveries,
      };
    } catch (error) {
      if (error instanceof AutomationRuntimeError) throw error;
      await this.emitRuntimeFailure(automation, occurrence, correlationId, undefined, "target_execution_failed", error);
      try {
        await this.finalize(automation, occurrence, correlationId, "failed", undefined, errorMessage(error));
      } catch (finalizeError) {
        throw finalizeError;
      }
      throw new AutomationRuntimeError("Automation target execution failed before a structured result", "target_execution_failed", { cause: error });
    }
  }

  private async deliverPhase(input: {
    definition: AutomationDefinition;
    automation: ExactViewRef;
    occurrence: TriggerOccurrence;
    correlationId: string;
    phase: AutomationDeliveryRequest["phase"];
    runId?: string;
    views: ExactViewRef[];
    onlyProgress?: boolean;
    batch: number;
  }): Promise<AutomationDeliveryAttempt[]> {
    const configured = input.onlyProgress
      ? input.definition.delivery.filter(item => item.show_progress)
      : input.definition.delivery;
    const attempts: AutomationDeliveryAttempt[] = [];

    for (const [index, delivery] of configured.entries()) {
      const request: AutomationDeliveryRequest = {
        id: `${input.correlationId}:delivery:${input.batch}:${input.phase}:${index}`,
        correlation_id: input.correlationId,
        phase: input.phase,
        surface: delivery.surface,
        urgency: delivery.urgency,
        replacement: delivery.replacement,
        ...(delivery.expires_after_ms === undefined ? {} : {
          expires_at: new Date(Date.parse(input.occurrence.occurred_at) + delivery.expires_after_ms).toISOString(),
        }),
        actions: delivery.actions,
        automation: input.automation,
        occurrence_id: input.occurrence.id,
        ...(input.runId ? { run_id: input.runId } : {}),
        views: input.views,
      };
      await this.emit({
        type: "automation.delivery_attempted",
        occurred_at: this.nowIso(),
        correlation_id: input.correlationId,
        automation: input.automation,
        occurrence_id: input.occurrence.id,
        run_id: input.runId,
        payload: { request },
      });

      let result: AutomationDeliveryResult;
      const deliveryStartedAt = this.now().getTime();
      try {
        result = await this.options.delivery.deliver(request);
      } catch (error) {
        result = { status: "failed", error: errorMessage(error) };
      }
      attempts.push({ request, result });
      await this.emit({
        type: deliveryTraceType(result),
        occurred_at: this.nowIso(),
        correlation_id: input.correlationId,
        automation: input.automation,
        occurrence_id: input.occurrence.id,
        run_id: input.runId,
        duration_ms: this.elapsed(deliveryStartedAt),
        failure: deliveryFailure(result),
        payload: { request_id: request.id, surface: request.surface, result },
      });
    }
    return attempts;
  }

  private async finalize(
    automation: ExactViewRef,
    occurrence: TriggerOccurrence,
    correlationId: string,
    status: "succeeded" | "failed",
    runId?: string,
    error?: string,
  ): Promise<void> {
    try {
      await this.options.occurrences.finalize({
        idempotency_key: occurrence.idempotency_key,
        correlation_id: correlationId,
        status,
        run_id: runId,
        error,
      });
    } catch (cause) {
      await this.emitRuntimeFailure(automation, occurrence, correlationId, runId, "occurrence_finalize_failed", cause);
      throw new AutomationRuntimeError("failed to finalize Automation occurrence", "occurrence_finalize_failed", { cause });
    }
  }

  private async emitRuntimeFailure(
    automation: ExactViewRef,
    occurrence: TriggerOccurrence,
    correlationId: string,
    runId: string | undefined,
    code: AutomationRuntimeError["code"],
    error: unknown,
  ): Promise<void> {
    await this.emit({
      type: "automation.runtime_failed",
      occurred_at: this.nowIso(),
      correlation_id: correlationId,
      automation,
      occurrence_id: occurrence.id,
      run_id: runId,
      failure: runtimeFailure(code, error),
      payload: {},
    });
  }

  private async stopCascade(occurrence: TriggerOccurrence, code: string, message: string): Promise<void> {
    if (!occurrence.cascade) return;
    if (!this.options.cascades) {
      throw new AutomationRuntimeError(
        `Reactive cascade ledger is missing for ${occurrence.cascade.attempt_id}`,
        "occurrence_finalize_failed",
      );
    }
    const current = await this.options.cascades.getAttempt(occurrence.cascade.attempt_id);
    if (!current || current.status === "succeeded" || current.status === "failed" || current.status === "stopped") return;
    await this.options.cascades.finalize({
      attempt_id: occurrence.cascade.attempt_id,
      status: "stopped",
      completed_at: this.nowIso(),
      ...(current.run_id ? { run_id: current.run_id } : {}),
      cost_usd: current.cost_usd,
      error_code: code,
      error_message: message,
    });
  }

  private async emit(event: AutomationTraceEventInput): Promise<void> {
    const parsed = parseAutomationTraceEvent(event);
    try {
      await this.options.events.emit(parsed);
    } catch (cause) {
      throw new AutomationRuntimeError("failed to persist Automation trace event", "trace_persistence_failed", { cause });
    }
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private elapsed(startedAt: number): number {
    return Math.max(0, this.now().getTime() - startedAt);
  }
}

function invocationMatch(input: AutomationInvocationInput): TriggerMatchResult {
  if (!input.predicate_match) return matchTrigger(input.automation.definition.trigger, input.signal);

  const trigger = input.automation.definition.trigger;
  const attestation = input.predicate_match;
  if (
    attestation.automation.view_id !== input.automation.view.id
    || attestation.automation.revision !== input.automation.view.revision
  ) {
    throw new Error(
      `prevalidated predicate Automation mismatch: ${attestation.automation.view_id}@${attestation.automation.revision}`
      + ` != ${input.automation.view.id}@${input.automation.view.revision}`,
    );
  }
  if (attestation.trigger_id !== trigger.id) {
    throw new Error(`prevalidated predicate trigger mismatch: ${attestation.trigger_id} != ${trigger.id}`);
  }
  if (attestation.signal_id !== input.signal.id) {
    throw new Error(`prevalidated predicate signal mismatch: ${attestation.signal_id} != ${input.signal.id}`);
  }
  if (!("predicate" in trigger) || trigger.predicate === undefined) {
    throw new Error("prevalidated predicate match requires a Trigger predicate");
  }
  const predicateDigest = triggerPredicateDigest(trigger.predicate);
  if (attestation.predicate_digest !== predicateDigest) {
    throw new Error(`prevalidated predicate digest mismatch for ${trigger.id}`);
  }

  const structural = matchTrigger(withoutPredicate(trigger), input.signal);
  if (!structural.matched) return structural;
  return { matched: true, reason: attestation.reason };
}

export function triggerPredicateDigest(predicate: TriggerPredicate): string {
  return createHash("sha256").update(canonicalJson(predicate)).digest("hex");
}

function withoutPredicate(trigger: TriggerDefinition): TriggerDefinition {
  if (!("predicate" in trigger)) return trigger;
  const { predicate: _predicate, ...structural } = trigger;
  return structural;
}

function deliveryTraceType(result: AutomationDeliveryResult): AutomationTraceEventType {
  switch (result.status) {
    case "delivered": return "automation.delivery_succeeded";
    case "expired": return "automation.delivery_expired";
    case "suppressed": return "automation.delivery_suppressed";
    case "unavailable": return "automation.delivery_unavailable";
    case "failed": return "automation.delivery_failed";
  }
}

function ignoredCorrelationId(automation: ExactViewRef, signalId: string): string {
  return `automation-ignored:${automation.view_id}:${automation.revision}:${signalId}`;
}

function invocationAttempt(
  input: AutomationInvocationAttempt | undefined,
  correlationId: string,
): { id: string; parent_attempt_id?: string; reason?: AutomationInvocationAttempt["reason"] } {
  if (!input) return { id: `${correlationId}:attempt:0` };
  if (!input.id.trim()) throw new Error("Automation invocation attempt id is required");
  if (input.parent_attempt_id !== undefined && !input.parent_attempt_id.trim()) {
    throw new Error("Automation invocation parent attempt id cannot be empty");
  }
  if (input.parent_attempt_id === input.id) {
    throw new Error("Automation invocation attempt cannot be its own parent");
  }
  return input;
}

function contextFailure(error: unknown): AutomationFailure {
  return {
    stage: "context",
    code: error instanceof AutomationContextResolutionError ? error.code : "context_resolution_failed",
    message: errorMessage(error),
  };
}

function agentFailure(event: AutomationTargetTraceEvent): AutomationFailure {
  const code = typeof event.payload?.code === "string" ? event.payload.code : "agent_runtime_failed";
  const message = typeof event.payload?.message === "string"
    ? event.payload.message
    : `Agent runtime ${event.runtime} failed`;
  return {
    stage: "execution",
    code,
    message,
  };
}

function deliveryFailure(result: AutomationDeliveryResult): AutomationFailure | undefined {
  switch (result.status) {
    case "unavailable":
      return { stage: "delivery", code: "delivery_surface_unavailable", message: result.error };
    case "failed":
      return { stage: "delivery", code: "delivery_failed", message: result.error, diagnostics: result.diagnostics };
    case "delivered":
    case "expired":
    case "suppressed":
      return undefined;
  }
}

function runtimeFailure(code: AutomationRuntimeError["code"], error: unknown): AutomationFailure {
  const stage = code === "occurrence_reservation_failed"
    ? "occurrence"
    : code === "context_resolution_failed"
      ? "context"
      : code === "occurrence_finalize_failed"
        ? "finalization"
        : code === "trace_persistence_failed"
          ? "trace"
          : "execution";
  return { stage, code, message: errorMessage(error) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
