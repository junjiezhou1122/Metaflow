import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AutomationContextResolutionError,
  AutomationRuntimeError,
  matchTrigger,
  parseAutomationView,
  parseTriggerSignal,
  triggerPredicateDigest,
  type AutomationInvocationAdmissionResult,
  type AutomationInvocationPort,
  type ParsedAutomationView,
  type ReactiveCascadeLedger,
  type TriggerPredicate,
  type TriggerSignal,
} from "@info/automation";
import {
  CaptureProvenanceSchema,
  ExactViewRefSchema,
  JsonValueSchema,
  ViewCommitOriginSchema,
  ViewPolicySchema,
  ReactiveCascadeContextSchema,
  ReactiveCascadePolicySnapshotSchema,
  canonicalJson,
  parseViewCommittedEvent,
  type CommittedViewSummary,
  type ExactViewRef,
  type JsonValue,
  type View,
  type ViewCommittedEvent,
  type ViewCommittedEventConsumer,
  type ViewRepository,
  type ReactiveCascadeContext,
  type ReactiveCascadePolicySnapshot,
} from "@info/view";

export const VIEW_COMMITTED_TRIGGER_SOURCE = "metaflow.view";
export const VIEW_COMMITTED_TRIGGER_EVENT = "view.committed";

const IdentifierSchema = z.string().trim().min(1).max(240);
const TimestampSchema = z.string().datetime({ offset: true });

const ViewCommitRepresentationProjectionSchema = z.object({
  form: z.enum(["inline", "external_reference"]),
  kind: IdentifierSchema,
  media_type: z.string().trim().min(1).optional(),
  access: z.enum(["descriptor", "bounded_content"]),
  value: JsonValueSchema.optional(),
  metadata: z.record(JsonValueSchema).optional(),
  uri: z.string().trim().min(1).optional(),
  digest: z.object({
    algorithm: IdentifierSchema,
    value: z.string().trim().min(1),
  }).strict().optional(),
}).strict();

export const ViewCommittedTriggerPayloadSchema = z.object({
  commit: z.object({
    event_id: IdentifierSchema,
    batch_id: IdentifierSchema,
    transaction_id: IdentifierSchema,
    origin: ViewCommitOriginSchema,
  }).strict(),
  view: z.object({
    ref: ExactViewRefSchema,
    role: z.enum(["raw", "derived"]),
    schema: z.object({
      name: IdentifierSchema,
      version: z.number().int().positive(),
      mode: z.enum(["freeform", "strict"]),
    }).strict(),
    source: CaptureProvenanceSchema.nullable(),
    representation: ViewCommitRepresentationProjectionSchema,
    relation_types: z.array(IdentifierSchema),
    relations: z.array(z.object({
      type: IdentifierSchema,
      target: ExactViewRefSchema,
    }).strict()),
    policy: ViewPolicySchema,
  }).strict(),
}).strict();

export type ViewCommittedTriggerPayload = z.infer<typeof ViewCommittedTriggerPayloadSchema>;

export const CommittedViewTriggerOutcomeSchema = z.enum([
  "matched",
  "ignored",
  "denied",
  "failed",
  "enqueued",
  "stopped",
]);

export const CommittedViewTriggerEventSchema = z.object({
  schema_version: z.literal(1),
  id: IdentifierSchema,
  outcome: CommittedViewTriggerOutcomeSchema,
  stage: z.enum(["discovery", "evidence", "matching", "cascade", "invocation"]),
  occurred_at: TimestampSchema,
  source_event_id: IdentifierSchema,
  source_batch_id: IdentifierSchema,
  evidence: ExactViewRefSchema.optional(),
  automation: ExactViewRefSchema.optional(),
  signal_id: IdentifierSchema.optional(),
  correlation_id: z.string().trim().min(1).max(2_000).optional(),
  reason: z.string().trim().min(1).max(20_000),
  details: z.record(JsonValueSchema).default({}),
}).strict();

export type CommittedViewTriggerOutcome = z.infer<typeof CommittedViewTriggerOutcomeSchema>;
export type CommittedViewTriggerEvent = z.infer<typeof CommittedViewTriggerEventSchema>;

export interface CommittedViewTriggerEventSink {
  emit(event: CommittedViewTriggerEvent): void | Promise<void>;
}

export type CommittedViewTriggerReport = {
  source_event_id: string;
  views_evaluated: number;
  automation_views: number;
  evaluations: number;
  outcomes: CommittedViewTriggerEvent[];
};

export type CommittedViewTriggerErrorCode =
  | "invalid_options"
  | "event_bound_exceeded"
  | "automation_discovery_failed"
  | "evidence_mismatch"
  | "automation_validation_failed"
  | "invocation_failed"
  | "trace_persistence_failed"
  | "dispatch_failed";

export class CommittedViewTriggerError extends Error {
  constructor(
    message: string,
    readonly code: CommittedViewTriggerErrorCode,
    readonly report?: CommittedViewTriggerReport,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CommittedViewTriggerError";
  }
}

export type CommittedViewTriggerAdapterOptions = {
  views: Pick<ViewRepository, "get" | "query">;
  invocations: AutomationInvocationPort;
  events: CommittedViewTriggerEventSink;
  now?: () => Date;
  max_automation_views?: number;
  max_event_views?: number;
  max_relations?: number;
  max_predicate_nodes?: number;
  max_predicate_depth?: number;
  max_predicate_bytes?: number;
  max_representation_bytes?: number;
  cascades: ReactiveCascadeLedger;
  cascade_policy: ReactiveCascadePolicySnapshot;
};

type NormalizedOptions = CommittedViewTriggerAdapterOptions & {
  now: () => Date;
  max_automation_views: number;
  max_event_views: number;
  max_relations: number;
  max_predicate_nodes: number;
  max_predicate_depth: number;
  max_predicate_bytes: number;
  max_representation_bytes: number;
};

type EvaluationFailure = {
  code: CommittedViewTriggerErrorCode;
  error: Error;
};

type PlannedInvocation = {
  view: View;
  automation: ParsedAutomationView;
  signal: TriggerSignal;
  predicate_match?: Parameters<AutomationInvocationPort["invoke"]>[0]["predicate_match"];
};

export class CommittedViewTriggerAdapter implements ViewCommittedEventConsumer {
  private readonly options: NormalizedOptions;

  constructor(options: CommittedViewTriggerAdapterOptions) {
    this.options = normalizeOptions(options);
  }

  async handle(input: ViewCommittedEvent): Promise<void> {
    await this.dispatch(input);
  }

  async dispatch(input: ViewCommittedEvent): Promise<CommittedViewTriggerReport> {
    const event = parseViewCommittedEvent(input);
    const report: CommittedViewTriggerReport = {
      source_event_id: event.event_id,
      views_evaluated: 0,
      automation_views: 0,
      evaluations: 0,
      outcomes: [],
    };
    if (event.views.length > this.options.max_event_views) {
      const reason = `ViewCommitted event contains ${event.views.length} Views; limit is ${this.options.max_event_views}`;
      await this.record(report, event, {
        outcome: "failed",
        stage: "evidence",
        reason,
        details: { view_count: event.views.length, limit: this.options.max_event_views },
      });
      throw new CommittedViewTriggerError(reason, "event_bound_exceeded", report);
    }
    const failures: EvaluationFailure[] = [];
    const plans: PlannedInvocation[] = [];
    const automations = await this.loadAutomations(event, report);
    report.automation_views = automations.length;

    for (const summary of event.views) {
      report.views_evaluated += 1;
      const view = await this.resolveEvidence(event, summary, report, failures);
      if (!view) continue;

      if (automations.length === 0) {
        await this.record(report, event, {
          outcome: "ignored",
          stage: "discovery",
          evidence: summary.ref,
          reason: "no Automation Views are available",
        });
        continue;
      }

      for (const automation of automations) {
        report.evaluations += 1;
        const plan = await this.planAutomation(event, view, automation, report, failures);
        if (plan) plans.push(plan);
      }
    }

    await this.dispatchPlans(event, plans, report, failures);

    if (failures.length > 0) {
      throw new CommittedViewTriggerError(
        `${failures.length} committed-View Automation evaluation(s) failed`,
        "dispatch_failed",
        report,
        { cause: new AggregateError(failures.map(item => item.error)) },
      );
    }
    return report;
  }

  private async loadAutomations(
    event: ViewCommittedEvent,
    report: CommittedViewTriggerReport,
  ): Promise<ParsedAutomationView[]> {
    let views: View[];
    try {
      views = await this.options.views.query({
        schema_name: "metaflow.automation",
        role: "derived",
        revisions: "latest",
        limit: this.options.max_automation_views + 1,
      });
    } catch (cause) {
      await this.record(report, event, {
        outcome: "failed",
        stage: "discovery",
        reason: `Automation discovery failed: ${errorMessage(cause)}`,
      });
      throw new CommittedViewTriggerError("failed to discover Automation Views", "automation_discovery_failed", report, { cause });
    }
    if (views.length > this.options.max_automation_views) {
      await this.record(report, event, {
        outcome: "failed",
        stage: "discovery",
        reason: `Automation discovery exceeded the configured limit of ${this.options.max_automation_views}`,
      });
      throw new CommittedViewTriggerError("Automation discovery exceeded its bound", "automation_discovery_failed", report);
    }

    const parsed: ParsedAutomationView[] = [];
    for (const view of views.sort(compareViews)) {
      try {
        parsed.push(parseAutomationView(view));
      } catch (cause) {
        const automation = exactRef(view);
        await this.record(report, event, {
          outcome: "failed",
          stage: "discovery",
          automation,
          reason: `Automation View is invalid: ${errorMessage(cause)}`,
        });
        throw new CommittedViewTriggerError(
          `invalid Automation View ${view.id}@${view.revision}`,
          "automation_validation_failed",
          report,
          { cause },
        );
      }
    }
    return parsed;
  }

  private async resolveEvidence(
    event: ViewCommittedEvent,
    summary: CommittedViewSummary,
    report: CommittedViewTriggerReport,
    failures: EvaluationFailure[],
  ): Promise<View | undefined> {
    let view: View | undefined;
    try {
      view = await this.options.views.get(summary.ref);
    } catch (cause) {
      const error = asError(cause);
      await this.record(report, event, {
        outcome: "failed",
        stage: "evidence",
        evidence: summary.ref,
        reason: `exact View resolution failed: ${error.message}`,
      });
      failures.push({ code: "evidence_mismatch", error });
      return undefined;
    }
    if (!view) {
      await this.record(report, event, {
        outcome: "denied",
        stage: "evidence",
        evidence: summary.ref,
        reason: "exact committed View is no longer resolvable; it may have been governed or forgotten",
      });
      return undefined;
    }
    const mismatch = committedSummaryMismatch(summary, view);
    if (mismatch) {
      const error = new Error(mismatch);
      await this.record(report, event, {
        outcome: "failed",
        stage: "evidence",
        evidence: summary.ref,
        reason: mismatch,
      });
      failures.push({ code: "evidence_mismatch", error });
      return undefined;
    }
    return view;
  }

  private async planAutomation(
    event: ViewCommittedEvent,
    view: View,
    automation: ParsedAutomationView,
    report: CommittedViewTriggerReport,
    failures: EvaluationFailure[],
  ): Promise<PlannedInvocation | undefined> {
    const automationRef = exactRef(automation.view);
    const evidence = exactRef(view);
    if (!automation.definition.enabled) {
      await this.record(report, event, {
        outcome: "ignored",
        stage: "matching",
        evidence,
        automation: automationRef,
        reason: "Automation is disabled",
      });
      return undefined;
    }

    const trigger = automation.definition.trigger;
    if (trigger.kind !== "event" || trigger.source !== VIEW_COMMITTED_TRIGGER_SOURCE || trigger.event !== VIEW_COMMITTED_TRIGGER_EVENT) {
      await this.record(report, event, {
        outcome: "ignored",
        stage: "matching",
        evidence,
        automation: automationRef,
        reason: "Automation does not subscribe to committed View events",
      });
      return undefined;
    }

    try {
      assertPredicateBounds(
        trigger.predicate,
        this.options.max_predicate_nodes,
        this.options.max_predicate_depth,
        this.options.max_predicate_bytes,
      );
    } catch (cause) {
      const error = asError(cause);
      await this.record(report, event, {
        outcome: "failed",
        stage: "matching",
        evidence,
        automation: automationRef,
        reason: error.message,
      });
      failures.push({ code: "automation_validation_failed", error });
      return undefined;
    }

    const needsRepresentationContent = predicateReadsRepresentationContent(trigger.predicate);
    if (needsRepresentationContent && view.policy.allow_local_search === false) {
      await this.record(report, event, {
        outcome: "denied",
        stage: "matching",
        evidence,
        automation: automationRef,
        reason: "View policy forbids local Representation matching",
        details: { policy_constraint: "allow_local_search" },
      });
      return undefined;
    }

    let matchingSignal: TriggerSignal;
    try {
      matchingSignal = buildTriggerSignal(event, view, needsRepresentationContent, {
        maxRelations: this.options.max_relations,
        maxRepresentationBytes: this.options.max_representation_bytes,
      });
    } catch (cause) {
      const error = asError(cause);
      await this.record(report, event, {
        outcome: needsRepresentationContent ? "denied" : "failed",
        stage: "matching",
        evidence,
        automation: automationRef,
        reason: error.message,
      });
      if (!needsRepresentationContent) failures.push({ code: "evidence_mismatch", error });
      return undefined;
    }

    const match = matchTrigger(trigger, matchingSignal);
    if (!match.matched) {
      await this.record(report, event, {
        outcome: "ignored",
        stage: "matching",
        evidence,
        automation: automationRef,
        signal_id: matchingSignal.id,
        reason: match.reason,
      });
      return undefined;
    }

    // Representation content is matching-only evidence. The invocation signal
    // is persisted before View access authorization, so it must remain a
    // descriptor plus exact ref and never duplicate governed View content.
    const signal = needsRepresentationContent
      ? buildTriggerSignal(event, view, false, {
          maxRelations: this.options.max_relations,
          maxRepresentationBytes: this.options.max_representation_bytes,
        })
      : matchingSignal;

    await this.record(report, event, {
      outcome: "matched",
      stage: "matching",
      evidence,
      automation: automationRef,
      signal_id: signal.id,
      reason: match.reason,
    });

    return {
      view,
      automation,
      signal,
      ...(needsRepresentationContent ? {
        predicate_match: {
          automation: automationRef,
          trigger_id: trigger.id,
          signal_id: signal.id,
          predicate_digest: triggerPredicateDigest(trigger.predicate!),
          matched: true as const,
          reason: match.reason,
        },
      } : {}),
    };
  }

  private async dispatchPlans(
    event: ViewCommittedEvent,
    plans: PlannedInvocation[],
    report: CommittedViewTriggerReport,
    failures: EvaluationFailure[],
  ): Promise<void> {
    if (plans.length === 0) return;
    if (event.cascade?.disposition === "terminal") {
      for (const plan of plans) {
        await this.record(report, event, {
          outcome: "stopped",
          stage: "cascade",
          evidence: exactRef(plan.view),
          automation: exactRef(plan.automation.view),
          signal_id: plan.signal.id,
          reason: `cascade ${event.cascade.attempt_id} is terminal`,
        });
      }
      return;
    }

    const operationPlans = plans.filter(plan => plan.automation.definition.target.kind === "operation");
    if (operationPlans.length > 0) {
      const error = new Error("view.committed Automations must target a Transformation so recursive output stays inside cascade admission");
      for (const plan of operationPlans) {
        await this.record(report, event, {
          outcome: "failed",
          stage: "cascade",
          evidence: exactRef(plan.view),
          automation: exactRef(plan.automation.view),
          signal_id: plan.signal.id,
          reason: error.message,
          details: { target_kind: "operation" },
        });
      }
      failures.push({ code: "automation_validation_failed", error });
      return;
    }

    const contexts = buildCascadeContexts(event, plans, this.options.cascade_policy, this.options.now());
    let admittedContexts = contexts;
    let invocableAttemptIds = new Set<string>();
    if (contexts.length > 0) {
      const reservation = await this.options.cascades.reservePlan({
        attempts: contexts,
        reserved_at: this.options.now().toISOString(),
      });
      if (reservation.outcome === "stopped") {
        for (const record of reservation.attempts) {
          await this.record(report, event, {
            outcome: "stopped",
            stage: "cascade",
            evidence: record.context.lineage.at(-1),
            automation: record.context.target.automation,
            reason: reservation.message,
            details: {
              attempt_id: record.context.attempt_id,
              root_correlation_id: record.context.root_correlation_id,
              code: reservation.code,
            },
          });
        }
      }
      admittedContexts = reservation.attempts.map(record => record.context);
      if (reservation.outcome === "created" || reservation.outcome === "recovered" || reservation.outcome === "stopped") {
        invocableAttemptIds = new Set(reservation.attempts
          .filter(record => record.status === "reserved" || (reservation.outcome === "stopped" && record.status === "stopped"))
          .map(record => record.context.attempt_id));
      }
    }
    const contextBySignal = new Map(admittedContexts.map(context => [cascadePlanKey(context), context]));

    for (const plan of plans) {
      const target = plan.automation.definition.target;
      const key = target.kind === "transformation"
        ? planIdentity(exactRef(plan.view), exactRef(plan.automation.view), {
            transformation_id: target.transformation_id,
            revision: target.revision,
          })
        : undefined;
      const cascade = key ? contextBySignal.get(key) : undefined;
      const signal = cascade
        ? parseTriggerSignal({ ...plan.signal, cascade })
        : plan.signal;
      if (cascade && !invocableAttemptIds.has(cascade.attempt_id)) {
        await this.record(report, event, {
          outcome: "ignored",
          stage: "cascade",
          evidence: exactRef(plan.view),
          automation: exactRef(plan.automation.view),
          signal_id: signal.id,
          reason: `cascade attempt ${cascade.attempt_id} was already admitted and will not be invoked again`,
        });
        continue;
      }
      try {
        const result = await this.options.invocations.invoke({
          automation: plan.automation,
          signal,
          ...(plan.predicate_match ? { predicate_match: plan.predicate_match } : {}),
        });
        await this.recordInvocationResult(
          report,
          event,
          exactRef(plan.view),
          exactRef(plan.automation.view),
          signal,
          result,
          failures,
        );
      } catch (cause) {
        if (isDeniedContextFailure(cause)) {
          await this.record(report, event, {
            outcome: "denied",
            stage: "invocation",
            evidence: exactRef(plan.view),
            automation: exactRef(plan.automation.view),
            signal_id: signal.id,
            reason: errorMessage(cause),
          });
          continue;
        }
        const error = asError(cause);
        await this.record(report, event, {
          outcome: "failed",
          stage: "invocation",
          evidence: exactRef(plan.view),
          automation: exactRef(plan.automation.view),
          signal_id: signal.id,
          reason: error.message,
        });
        failures.push({ code: "invocation_failed", error });
      }
    }
  }

  private async recordInvocationResult(
    report: CommittedViewTriggerReport,
    event: ViewCommittedEvent,
    evidence: ExactViewRef,
    automation: ExactViewRef,
    signal: TriggerSignal,
    result: AutomationInvocationAdmissionResult,
    failures: EvaluationFailure[],
  ): Promise<void> {
    switch (result.status) {
      case "enqueued":
        await this.record(report, event, {
          outcome: "enqueued",
          stage: "invocation",
          evidence,
          automation,
          signal_id: signal.id,
          correlation_id: result.correlation_id,
          reason: "Automation occurrence was durably enqueued",
          details: { invocation_status: result.status, receipt_id: result.receipt_id },
        });
        return;
      case "succeeded":
        await this.record(report, event, {
          outcome: "enqueued",
          stage: "invocation",
          evidence,
          automation,
          signal_id: signal.id,
          correlation_id: result.correlation_id,
          reason: "Automation occurrence was admitted and completed",
          details: { invocation_status: result.status, run_id: result.run_id, output_views: result.output_views },
        });
        return;
      case "failed":
        await this.record(report, event, {
          outcome: "failed",
          stage: "invocation",
          evidence,
          automation,
          signal_id: signal.id,
          correlation_id: result.correlation_id,
          reason: result.error,
          details: {
            invocation_status: result.status,
            run_id: result.run_id,
            failure_view: result.failure_view,
            failure_code: result.failure.code,
            failure_stage: result.failure.stage,
          },
        });
        return;
      case "duplicate":
        await this.record(report, event, {
          outcome: "ignored",
          stage: "invocation",
          evidence,
          automation,
          signal_id: signal.id,
          correlation_id: result.correlation_id,
          reason: "duplicate committed View delivery reused the existing Automation occurrence",
          details: { invocation_status: result.status, existing_status: result.existing_status },
        });
        return;
      case "skipped":
        await this.record(report, event, {
          outcome: "ignored",
          stage: "invocation",
          evidence,
          automation,
          signal_id: signal.id,
          correlation_id: result.correlation_id,
          reason: `Automation occurrence was skipped by ${result.reason}`,
          details: { invocation_status: result.status, existing_status: result.existing_status },
        });
        return;
      case "ignored": {
        const error = new Error(`Automation Runtime rejected a pre-matched signal: ${result.reason}`);
        await this.record(report, event, {
          outcome: "failed",
          stage: "invocation",
          evidence,
          automation,
          signal_id: signal.id,
          reason: error.message,
        });
        failures.push({ code: "invocation_failed", error });
      }
    }
  }

  private async record(
    report: CommittedViewTriggerReport,
    source: ViewCommittedEvent,
    input: Omit<CommittedViewTriggerEvent, "schema_version" | "id" | "occurred_at" | "source_event_id" | "source_batch_id" | "details"> & {
      details?: Record<string, JsonValue>;
    },
  ): Promise<void> {
    const event = CommittedViewTriggerEventSchema.parse({
      schema_version: 1,
      id: bridgeEventId(source, input),
      occurred_at: this.options.now().toISOString(),
      source_event_id: source.event_id,
      source_batch_id: source.batch_id,
      details: input.details ?? {},
      ...input,
    });
    try {
      await this.options.events.emit(event);
    } catch (cause) {
      throw new CommittedViewTriggerError("failed to persist committed-View trigger evidence", "trace_persistence_failed", report, { cause });
    }
    report.outcomes.push(event);
  }
}

export function buildViewCommittedTriggerSignal(
  event: ViewCommittedEvent,
  view: View,
  options: {
    max_relations?: number;
    max_representation_bytes?: number;
  } = {},
): TriggerSignal {
  const parsedEvent = parseViewCommittedEvent(event);
  assertCommittedEventMember(parsedEvent, view);
  return buildTriggerSignal(parsedEvent, view, false, {
    maxRelations: options.max_relations ?? 256,
    maxRepresentationBytes: options.max_representation_bytes ?? 65_536,
  });
}

function buildTriggerSignal(
  event: ViewCommittedEvent,
  view: View,
  includeRepresentation: boolean,
  bounds: { maxRelations: number; maxRepresentationBytes: number },
): TriggerSignal {
  if (view.relations.length > bounds.maxRelations) {
    throw new Error(`View ${view.id}@${view.revision} has ${view.relations.length} relations; trigger limit is ${bounds.maxRelations}`);
  }
  const representation = representationProjection(view, includeRepresentation, bounds.maxRepresentationBytes);
  const ref = exactRef(view);
  const payload = ViewCommittedTriggerPayloadSchema.parse({
    commit: {
      event_id: event.event_id,
      batch_id: event.batch_id,
      transaction_id: event.transaction_id,
      origin: event.origin,
    },
    view: {
      ref,
      role: view.role,
      schema: { name: view.schema.name, version: view.schema.version, mode: view.schema.mode },
      source: view.provenance.capture ?? null,
      representation,
      relation_types: [...new Set(view.relations.map(relation => relation.type))].sort(),
      relations: view.relations.map(relation => ({ type: relation.type, target: relation.target })),
      policy: view.policy,
    },
  });
  const identity = `${event.event_id}:${ref.view_id}@${ref.revision}`;
  return parseTriggerSignal({
    id: `view-commit-signal:${digest(identity)}`,
    kind: "event",
    source: VIEW_COMMITTED_TRIGGER_SOURCE,
    event: VIEW_COMMITTED_TRIGGER_EVENT,
    occurred_at: event.committed_at,
    idempotency_key: `view-commit:${identity}`,
    evidence: [ref],
    payload,
  });
}

function representationProjection(
  view: View,
  includeContent: boolean,
  maxBytes: number,
): z.infer<typeof ViewCommitRepresentationProjectionSchema> {
  const descriptor = {
    form: view.representation.form,
    kind: view.representation.kind,
    ...(view.representation.media_type ? { media_type: view.representation.media_type } : {}),
  } as const;
  if (!includeContent) return { ...descriptor, access: "descriptor" };

  const content = view.representation.form === "inline"
    ? {
        ...descriptor,
        access: "bounded_content" as const,
        value: view.representation.value,
        ...(Object.keys(view.representation.metadata).length > 0 ? { metadata: view.representation.metadata } : {}),
      }
    : {
        ...descriptor,
        access: "bounded_content" as const,
        uri: view.representation.uri,
        ...(view.representation.digest ? { digest: view.representation.digest } : {}),
        ...(Object.keys(view.representation.metadata).length > 0 ? { metadata: view.representation.metadata } : {}),
      };
  const bytes = Buffer.byteLength(canonicalJson(content), "utf8");
  if (bytes > maxBytes) {
    throw new Error(`View ${view.id}@${view.revision} Representation requires ${bytes} bytes; trigger matching limit is ${maxBytes}`);
  }
  return ViewCommitRepresentationProjectionSchema.parse(content);
}

function assertPredicateBounds(
  predicate: TriggerPredicate | undefined,
  maxNodes: number,
  maxDepth: number,
  maxBytes: number,
): void {
  if (!predicate) return;
  const bytes = Buffer.byteLength(canonicalJson(predicate), "utf8");
  if (bytes > maxBytes) {
    throw new Error(`committed View trigger predicate requires ${bytes} bytes; limit is ${maxBytes}`);
  }
  let nodes = 0;
  const visit = (item: TriggerPredicate, depth: number): void => {
    nodes += 1;
    if (nodes > maxNodes) throw new Error(`committed View trigger predicate exceeds ${maxNodes} nodes`);
    if (depth > maxDepth) throw new Error(`committed View trigger predicate exceeds depth ${maxDepth}`);
    if (item.type === "field") {
      if (item.operator === "matches") {
        throw new Error("committed View trigger predicates do not permit unbounded regular-expression matching");
      }
      return;
    }
    if (item.type === "not") visit(item.predicate, depth + 1);
    else item.predicates.forEach(child => visit(child, depth + 1));
  };
  visit(predicate, 1);
}

function assertCommittedEventMember(event: ViewCommittedEvent, view: View): void {
  const summary = event.views.find(item => (
    item.ref.view_id === view.id && item.ref.revision === view.revision
  ));
  if (!summary) {
    throw new Error(`View ${view.id}@${view.revision} is not a member of ViewCommitted event ${event.event_id}`);
  }
  const mismatch = committedSummaryMismatch(summary, view);
  if (mismatch) throw new Error(mismatch);
}

function predicateReadsRepresentationContent(predicate: TriggerPredicate | undefined): boolean {
  if (!predicate) return false;
  if (predicate.type === "field") {
    return ["value", "metadata", "uri", "digest"].some(field => (
      predicate.path === `view.representation.${field}`
      || predicate.path.startsWith(`view.representation.${field}.`)
    ));
  }
  if (predicate.type === "not") return predicateReadsRepresentationContent(predicate.predicate);
  return predicate.predicates.some(predicateReadsRepresentationContent);
}

function committedSummaryMismatch(summary: CommittedViewSummary, view: View): string | undefined {
  if (view.id !== summary.ref.view_id || view.revision !== summary.ref.revision) {
    return `View repository returned ${view.id}@${view.revision} for ${summary.ref.view_id}@${summary.ref.revision}`;
  }
  if (view.role !== summary.role) return `ViewCommitted role mismatch for ${view.id}@${view.revision}`;
  if (
    view.schema.name !== summary.schema.name
    || view.schema.version !== summary.schema.version
    || view.schema.mode !== summary.schema.mode
  ) return `ViewCommitted Schema mismatch for ${view.id}@${view.revision}`;
  if (view.policy.retention !== summary.retention) return `ViewCommitted retention mismatch for ${view.id}@${view.revision}`;
  return undefined;
}

function isDeniedContextFailure(error: unknown): boolean {
  return error instanceof AutomationRuntimeError
    && error.code === "context_resolution_failed"
    && error.cause instanceof AutomationContextResolutionError
    && error.cause.code === "view_access_denied";
}

function buildCascadeContexts(
  event: ViewCommittedEvent,
  plans: PlannedInvocation[],
  rootPolicy: ReactiveCascadePolicySnapshot | undefined,
  now: Date,
): ReactiveCascadeContext[] {
  if (plans.length === 0) return [];
  const inherited = event.cascade;
  const policy = inherited?.policy ?? rootPolicy;
  if (!policy) throw new Error("root reactive cascade policy is required");
  const rootCorrelationId = inherited?.root_correlation_id ?? `cascade-root:${digest(event.event_id)}`;
  const rootEventId = inherited?.root_event_id ?? event.event_id;
  const rootStartedAt = inherited?.root_started_at ?? event.committed_at;
  const priorLineage = inherited?.lineage ?? [];
  const priorFingerprints = inherited?.semantic_fingerprints ?? [];
  const aggregateAttempts = (inherited?.aggregate.attempts ?? 0) + plans.length;
  const aggregateCost = inherited?.aggregate.cost_usd ?? 0;
  const attemptStartedAt = now.toISOString();

  return plans.map((plan, index) => {
    const automation = exactRef(plan.automation.view);
    const target = plan.automation.definition.target;
    if (target.kind !== "transformation") throw new Error("reactive cascade target must be a Transformation");
    const evidence = exactRef(plan.view);
    const exactCycle = priorLineage.some(ref => (
      ref.view_id === evidence.view_id && ref.revision === evidence.revision
    ));
    const semanticFingerprint = digest(canonicalJson({
      source_schema: {
        name: plan.view.schema.name,
        version: plan.view.schema.version,
      },
      automation,
      transformation: {
        transformation_id: target.transformation_id,
        revision: target.revision,
      },
    }));
    const attemptId = `cascade-attempt:${digest(canonicalJson({
      root_correlation_id: rootCorrelationId,
      parent_event_id: event.event_id,
      evidence,
      automation,
      transformation: target,
    }))}`;
    return ReactiveCascadeContextSchema.parse({
      attempt_id: attemptId,
      root_correlation_id: rootCorrelationId,
      root_event_id: rootEventId,
      parent_event_id: event.event_id,
      ...(event.origin.kind === "execution" ? { parent_run_id: event.origin.id } : {}),
      ...(inherited ? { parent_attempt_id: inherited.attempt_id } : {}),
      target: {
        automation,
        transformation: {
          transformation_id: target.transformation_id,
          revision: target.revision,
        },
      },
      lineage: exactCycle ? priorLineage : [...priorLineage, evidence],
      depth: (inherited?.depth ?? 0) + 1,
      fan_out_index: index,
      fan_out_total: plans.length,
      semantic_fingerprints: exactCycle
        ? [...priorFingerprints, semanticFingerprint, semanticFingerprint]
        : [...priorFingerprints, semanticFingerprint],
      policy,
      root_started_at: rootStartedAt,
      attempt_started_at: attemptStartedAt,
      aggregate: { attempts: aggregateAttempts, cost_usd: aggregateCost },
      disposition: "continue",
    });
  });
}

function cascadePlanKey(context: ReactiveCascadeContext): string {
  const evidence = context.lineage.at(-1);
  if (!evidence) throw new Error(`cascade attempt has no lineage: ${context.attempt_id}`);
  return planIdentity(evidence, context.target.automation, context.target.transformation);
}

function planIdentity(
  evidence: ExactViewRef,
  automation: ExactViewRef,
  transformation: { transformation_id: string; revision: number },
): string {
  return canonicalJson({ evidence, automation, transformation });
}

function normalizeOptions(input: CommittedViewTriggerAdapterOptions): NormalizedOptions {
  if (!input.cascades || !input.cascade_policy) {
    throw new CommittedViewTriggerError(
      "committed View triggers require a durable cascade ledger and root policy",
      "invalid_options",
    );
  }
  const cascadePolicy = ReactiveCascadePolicySnapshotSchema.parse(input.cascade_policy);
  const options = {
    ...input,
    cascade_policy: cascadePolicy,
    now: input.now ?? (() => new Date()),
    max_automation_views: input.max_automation_views ?? 1_000,
    max_event_views: input.max_event_views ?? 1_000,
    max_relations: input.max_relations ?? 256,
    max_predicate_nodes: input.max_predicate_nodes ?? 64,
    max_predicate_depth: input.max_predicate_depth ?? 8,
    max_predicate_bytes: input.max_predicate_bytes ?? 16_384,
    max_representation_bytes: input.max_representation_bytes ?? 65_536,
  };
  for (const [name, value, maximum] of [
    ["max_automation_views", options.max_automation_views, 9_999],
    ["max_event_views", options.max_event_views, 10_000],
    ["max_relations", options.max_relations, 10_000],
    ["max_predicate_nodes", options.max_predicate_nodes, 10_000],
    ["max_predicate_depth", options.max_predicate_depth, 100],
    ["max_predicate_bytes", options.max_predicate_bytes, 1_000_000],
    ["max_representation_bytes", options.max_representation_bytes, 10_000_000],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > maximum) {
      throw new CommittedViewTriggerError(`${name} must be an integer between 1 and ${maximum}`, "invalid_options");
    }
  }
  return options;
}

function bridgeEventId(
  source: ViewCommittedEvent,
  event: Pick<CommittedViewTriggerEvent, "outcome" | "stage" | "evidence" | "automation" | "signal_id" | "reason">,
): string {
  return `committed-view-trigger:${digest(canonicalJson({ source_event_id: source.event_id, ...event }))}`;
}

function compareViews(left: View, right: View): number {
  return left.id.localeCompare(right.id) || left.revision - right.revision;
}

function exactRef(view: Pick<View, "id" | "revision">): ExactViewRef {
  return { view_id: view.id, revision: view.revision };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
