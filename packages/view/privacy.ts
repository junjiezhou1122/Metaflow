import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import type { ViewRepository } from "./repository.js";
import {
  ExactViewRefSchema,
  IdentifierSchema,
  SOURCE_TOMBSTONE_REPRESENTATION_KIND,
  TimestampSchema,
  type ExactViewRef,
  type JsonObject,
  type View,
  type ViewDraft,
} from "./schema.js";
import { exactViewRef, viewRevisionKey } from "./revision.js";
import { parseViewDraft } from "./validation.js";

export const SourceIdentityTargetSchema = z.object({
  connector: IdentifierSchema,
  connection_id: IdentifierSchema,
  source_id: IdentifierSchema,
  source_kind: IdentifierSchema,
  identity: z.enum(["stable_source", "occurrence"]),
}).strict();

export const ForgetPolicyScopeSchema = z.object({
  owner: IdentifierSchema.optional(),
  privacy: z.enum(["public", "private", "sensitive"]).optional(),
  schema_name: IdentifierSchema.optional(),
  labels_any: z.array(IdentifierSchema).min(1).optional(),
}).strict().refine(value => Object.keys(value).length > 0, {
  message: "Forget policy scope requires at least one constraint",
});

export const ForgetTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact_view"), ref: ExactViewRefSchema }).strict(),
  z.object({ kind: z.literal("view_identity"), view_id: IdentifierSchema }).strict(),
  z.object({ kind: z.literal("source_identity"), source: SourceIdentityTargetSchema }).strict(),
  z.object({ kind: z.literal("policy_scope"), scope: ForgetPolicyScopeSchema }).strict(),
]);

export const ForgetImpactEntrySchema = z.object({
  ref: ExactViewRefSchema,
  role: z.enum(["raw", "derived"]),
  reason: z.enum(["target", "downstream"]),
  action: z.enum(["purge", "rebuild"]),
  forgotten_inputs: z.array(ExactViewRefSchema),
  retained_inputs: z.array(ExactViewRefSchema),
}).strict();

const ForgetPlanBodyShape = {
  request_id: IdentifierSchema,
  actor: IdentifierSchema,
  requested_at: TimestampSchema,
  mode: z.enum(["normal", "sensitive_cascade"]),
  preauthorization_policy_id: IdentifierSchema.optional(),
  targets: z.array(ForgetTargetSchema).min(1),
  mixed_source_rule: z.enum(["purge", "rebuild"]),
  impact: z.array(ForgetImpactEntrySchema).min(1),
  required_stores: z.array(IdentifierSchema).min(1),
} as const;

export const ForgetPlanSchema = z.object({
  ...ForgetPlanBodyShape,
  plan_digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const ForgetStoreReceiptSchema = z.object({
  store_id: IdentifierSchema,
  status: z.enum(["pending", "succeeded", "failed"]),
  attempts: z.number().int().nonnegative(),
  updated_at: TimestampSchema,
  error_code: IdentifierSchema.optional(),
  error_stage: IdentifierSchema.optional(),
}).strict();

export const ForgetReplacementSchema = z.object({
  forgotten: ExactViewRefSchema,
  rebuilt: ExactViewRefSchema,
}).strict();

export const ForgetFailureSchema = z.object({
  code: IdentifierSchema,
  stage: IdentifierSchema,
  retryable: z.boolean(),
  store_id: IdentifierSchema.optional(),
}).strict();

export const ForgetRequestSchema = z.object({
  plan: ForgetPlanSchema,
  status: z.enum(["previewed", "running", "failed", "succeeded"]),
  receipts: z.array(ForgetStoreReceiptSchema),
  replacements: z.array(ForgetReplacementSchema),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  completed_at: TimestampSchema.optional(),
  failure: ForgetFailureSchema.optional(),
}).strict();

export const SensitiveForgetPreauthorizationSchema = z.object({
  kind: z.literal("preauthorized_sensitive"),
  policy_id: IdentifierSchema,
}).strict();

export const ForgetRequestParametersSchema = z.object({
  request_id: IdentifierSchema,
  requested_at: TimestampSchema,
  targets: z.array(ForgetTargetSchema).min(1),
  mixed_source_rule: z.enum(["purge", "rebuild"]).default("purge"),
  preauthorization: SensitiveForgetPreauthorizationSchema.optional(),
}).strict();

export const ForgetRequestInputSchema = ForgetRequestParametersSchema.extend({
  actor: IdentifierSchema,
}).strict();

export const ForgetExecutionAuthorizationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("confirmed_preview"),
    plan_digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  SensitiveForgetPreauthorizationSchema,
]);

export const ExecuteForgetParametersSchema = z.object({
  request_id: IdentifierSchema,
  authorization: ForgetExecutionAuthorizationSchema,
  recover_running: z.boolean().default(false),
}).strict();

export const ExecuteForgetInputSchema = ExecuteForgetParametersSchema.extend({
  actor: IdentifierSchema,
}).strict();

export const SourceTombstoneParametersSchema = z.object({
  source: ExactViewRefSchema,
  reason: IdentifierSchema,
  occurred_at: TimestampSchema,
  trace_id: IdentifierSchema.optional(),
  idempotency_key: IdentifierSchema.optional(),
}).strict();

export const SourceTombstoneInputSchema = SourceTombstoneParametersSchema.extend({
  actor: IdentifierSchema,
}).strict();

export type ForgetTarget = z.infer<typeof ForgetTargetSchema>;
export type ForgetPlan = z.infer<typeof ForgetPlanSchema>;
export type ForgetImpactEntry = z.infer<typeof ForgetImpactEntrySchema>;
export type ForgetStoreReceipt = z.infer<typeof ForgetStoreReceiptSchema>;
export type ForgetReplacement = z.infer<typeof ForgetReplacementSchema>;
export type ForgetFailure = z.infer<typeof ForgetFailureSchema>;
export type ForgetRequest = z.infer<typeof ForgetRequestSchema>;
export type ForgetRequestInput = z.infer<typeof ForgetRequestInputSchema>;
export type ExecuteForgetInput = z.input<typeof ExecuteForgetInputSchema>;
export type SourceTombstoneInput = z.infer<typeof SourceTombstoneInputSchema>;

export interface ForgetRepository {
  createForgetRequest(request: ForgetRequest): Promise<{ request: ForgetRequest; created: boolean }>;
  getForgetRequest(requestId: string): Promise<ForgetRequest | undefined>;
  startForgetRequest(requestId: string, updatedAt: string, recoverRunning?: boolean): Promise<ForgetRequest>;
  recordForgetStoreReceipt(input: {
    request_id: string;
    receipt: ForgetStoreReceipt;
  }): Promise<ForgetRequest>;
  failForgetRequest(input: {
    request_id: string;
    failure: ForgetFailure;
    failed_at: string;
  }): Promise<ForgetRequest>;
  commitForgetSuccess(input: {
    request_id: string;
    refs: ExactViewRef[];
    replacements: ForgetReplacement[];
    completed_at: string;
  }): Promise<ForgetRequest>;
}

export interface ForgetCleanupStore {
  readonly id: string;
  purge(input: { request_id: string; plan: ForgetPlan }): Promise<void>;
}

export interface ForgetRebuildPort {
  rebuild(input: {
    request_id: string;
    affected: Pick<View, "id" | "revision" | "name" | "purpose" | "schema" | "policy">;
    retained_inputs: View[];
  }): Promise<ViewDraft>;
}

export type PrivacyForgetServiceDependencies = {
  views: ViewRepository;
  requests: ForgetRepository;
  cleanup_stores?: ForgetCleanupStore[];
  rebuilder?: ForgetRebuildPort;
  now?: () => string;
};

export type PrivacyForgetErrorCode =
  | "forget_target_not_found"
  | "forget_owner_mismatch"
  | "forget_impact_limit_exceeded"
  | "forget_rebuilder_required"
  | "forget_request_not_found"
  | "forget_confirmation_mismatch"
  | "forget_sensitive_preauthorization_invalid"
  | "forget_cleanup_failed"
  | "forget_rebuild_failed"
  | "forget_rebuild_invalid"
  | "forget_commit_failed";

export class PrivacyForgetError extends Error {
  constructor(
    message: string,
    readonly code: PrivacyForgetErrorCode,
    readonly stage: string,
    readonly details: JsonObject = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PrivacyForgetError";
  }
}

export class PrivacyForgetService {
  private readonly cleanupStores: ForgetCleanupStore[];
  private readonly cleanupStoreById: Map<string, ForgetCleanupStore>;
  private readonly now: () => string;

  constructor(private readonly dependencies: PrivacyForgetServiceDependencies) {
    this.cleanupStores = [...(dependencies.cleanup_stores ?? [])];
    this.cleanupStoreById = new Map(this.cleanupStores.map(store => [store.id, store]));
    if (this.cleanupStoreById.size !== this.cleanupStores.length) {
      throw new TypeError("Forget cleanup store ids must be unique");
    }
    if (this.cleanupStoreById.has("view-store") || this.cleanupStoreById.has("rebuild")) {
      throw new TypeError("Forget cleanup store ids view-store and rebuild are reserved");
    }
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async request(inputValue: ForgetRequestInput): Promise<ForgetRequest> {
    const input = ForgetRequestInputSchema.parse(inputValue);
    const allViews = await this.dependencies.views.query({ revisions: "all", limit: 10_000 });
    if (allViews.length === 10_000) {
      throw new PrivacyForgetError(
        "Forget impact cannot be proven complete at the configured View scan limit",
        "forget_impact_limit_exceeded",
        "plan",
      );
    }
    const roots = resolveRoots(allViews, input.targets);
    if (roots.length === 0) {
      throw new PrivacyForgetError("Forget target matched no View revisions", "forget_target_not_found", "plan");
    }
    const identityRoots = expandRootIdentities(allViews, roots);
    const foreignOwner = identityRoots.find(view => view.policy.owner !== input.actor);
    if (foreignOwner) {
      throw new PrivacyForgetError(
        "Forget actor does not own every targeted View",
        "forget_owner_mismatch",
        "authorize",
        { ref: exactViewRef(foreignOwner), owner: foreignOwner.policy.owner },
      );
    }
    if (input.preauthorization && identityRoots.some(view => view.policy.privacy !== "sensitive")) {
      throw new PrivacyForgetError(
        "Sensitive cascade preauthorization requires every root View to be sensitive",
        "forget_sensitive_preauthorization_invalid",
        "authorize",
      );
    }

    const impact = computeImpact(allViews, roots, input.mixed_source_rule);
    if (impact.some(item => item.action === "rebuild") && !this.dependencies.rebuilder) {
      throw new PrivacyForgetError(
        "Mixed-source rebuild was requested but no Forget rebuild port is configured",
        "forget_rebuilder_required",
        "plan",
      );
    }
    const planBody = {
      request_id: input.request_id,
      actor: input.actor,
      requested_at: input.requested_at,
      mode: input.preauthorization ? "sensitive_cascade" as const : "normal" as const,
      ...(input.preauthorization ? { preauthorization_policy_id: input.preauthorization.policy_id } : {}),
      targets: input.targets,
      mixed_source_rule: input.mixed_source_rule,
      impact,
      required_stores: [
        ...this.cleanupStores.map(store => store.id).sort(),
        ...(impact.some(item => item.action === "rebuild") ? ["rebuild"] : []),
        "view-store",
      ],
    };
    const plan = ForgetPlanSchema.parse({
      ...planBody,
      plan_digest: await sha256(canonicalJson(planBody)),
    });
    const now = this.now();
    const created = await this.dependencies.requests.createForgetRequest(ForgetRequestSchema.parse({
      plan,
      status: "previewed",
      receipts: plan.required_stores.map(store_id => ({
        store_id,
        status: "pending",
        attempts: 0,
        updated_at: now,
      })),
      replacements: [],
      created_at: now,
      updated_at: now,
    }));
    if (input.preauthorization) {
      return this.execute({
        request_id: created.request.plan.request_id,
        authorization: input.preauthorization,
        actor: input.actor,
      });
    }
    return created.request;
  }

  async execute(inputValue: ExecuteForgetInput): Promise<ForgetRequest> {
    const input = ExecuteForgetInputSchema.parse(inputValue);
    const existing = await this.dependencies.requests.getForgetRequest(input.request_id);
    if (!existing) {
      throw new PrivacyForgetError("Forget request does not exist", "forget_request_not_found", "load", {
        request_id: input.request_id,
      });
    }
    if (existing.plan.actor !== input.actor) {
      throw new PrivacyForgetError(
        "Forget actor does not own this frozen request",
        "forget_owner_mismatch",
        "authorize",
        { request_id: input.request_id },
      );
    }
    if (existing.status === "succeeded") return existing;
    authorizeExecution(existing.plan, input.authorization);

    let active = await this.dependencies.requests.startForgetRequest(
      input.request_id,
      this.now(),
      input.recover_running,
    );
    let activeStore: string | undefined;
    let stage = "cleanup";
    try {
      for (const receipt of active.receipts) {
        if (receipt.store_id === "view-store" || receipt.store_id === "rebuild" || receipt.status === "succeeded") continue;
        activeStore = receipt.store_id;
        const store = this.cleanupStoreById.get(receipt.store_id);
        if (!store) {
          throw new PrivacyForgetError(
            `Forget cleanup store ${receipt.store_id} is not configured`,
            "forget_cleanup_failed",
            "cleanup",
            { store_id: receipt.store_id },
          );
        }
        await store.purge({ request_id: input.request_id, plan: active.plan });
        active = await this.dependencies.requests.recordForgetStoreReceipt({
          request_id: input.request_id,
          receipt: nextReceipt(receipt, "succeeded", this.now()),
        });
      }

      stage = "rebuild";
      activeStore = "rebuild";
      const replacements = await this.rebuild(active);
      const rebuildReceipt = active.receipts.find(item => item.store_id === "rebuild");
      if (rebuildReceipt && rebuildReceipt.status !== "succeeded") {
        active = await this.dependencies.requests.recordForgetStoreReceipt({
          request_id: input.request_id,
          receipt: nextReceipt(rebuildReceipt, "succeeded", this.now()),
        });
      }

      stage = "commit";
      activeStore = "view-store";
      return await this.dependencies.requests.commitForgetSuccess({
        request_id: input.request_id,
        refs: active.plan.impact.map(item => item.ref),
        replacements,
        completed_at: this.now(),
      });
    } catch (cause) {
      const error = cause instanceof PrivacyForgetError
        ? cause
        : new PrivacyForgetError(
            stage === "rebuild" ? "Forget rebuild failed" : stage === "commit" ? "Forget core purge failed" : "Forget cleanup failed",
            stage === "rebuild" ? "forget_rebuild_failed" : stage === "commit" ? "forget_commit_failed" : "forget_cleanup_failed",
            stage,
            activeStore ? { store_id: activeStore } : {},
            { cause },
          );
      const receipt = active.receipts.find(item => item.store_id === activeStore);
      if (receipt && receipt.status !== "succeeded") {
        await this.dependencies.requests.recordForgetStoreReceipt({
          request_id: input.request_id,
          receipt: nextReceipt(receipt, "failed", this.now(), error.code, error.stage),
        });
      }
      await this.dependencies.requests.failForgetRequest({
        request_id: input.request_id,
        failure: {
          code: error.code,
          stage: error.stage,
          retryable: true,
          ...(activeStore ? { store_id: activeStore } : {}),
        },
        failed_at: this.now(),
      });
      throw error;
    }
  }

  async inspect(requestId: string, actor: string): Promise<ForgetRequest> {
    const request = await this.dependencies.requests.getForgetRequest(requestId);
    if (!request) {
      throw new PrivacyForgetError("Forget request does not exist", "forget_request_not_found", "load", {
        request_id: requestId,
      });
    }
    if (request.plan.actor !== actor) {
      throw new PrivacyForgetError(
        "Forget actor does not own this frozen request",
        "forget_owner_mismatch",
        "authorize",
        { request_id: requestId },
      );
    }
    return request;
  }

  private async rebuild(request: ForgetRequest): Promise<ForgetReplacement[]> {
    const rebuildEntries = request.plan.impact.filter(item => item.action === "rebuild");
    if (rebuildEntries.length === 0) return request.replacements;
    const rebuilder = this.dependencies.rebuilder;
    if (!rebuilder) {
      throw new PrivacyForgetError("Forget rebuild port is unavailable", "forget_rebuilder_required", "rebuild");
    }
    const impacted = new Set(request.plan.impact.map(item => viewRevisionKey(item.ref)));
    const replacements: ForgetReplacement[] = [];
    for (const entry of rebuildEntries) {
      const affected = await this.dependencies.views.get(entry.ref);
      if (!affected) {
        throw new PrivacyForgetError("Affected View disappeared before rebuild", "forget_rebuild_failed", "rebuild", {
          ref: entry.ref,
        });
      }
      const retained = await Promise.all(entry.retained_inputs.map(ref => this.dependencies.views.get(ref)));
      if (retained.some(view => !view)) {
        throw new PrivacyForgetError("Retained rebuild input disappeared", "forget_rebuild_failed", "rebuild", {
          ref: entry.ref,
        });
      }
      const draft = parseViewDraft(await rebuilder.rebuild({
        request_id: request.plan.request_id,
        affected,
        retained_inputs: retained as View[],
      }));
      validateRebuildDraft(draft, affected, entry.retained_inputs, impacted);
      const committed = await this.dependencies.views.commit({
        draft,
        expected_revision: 0,
        idempotency_key: `forget:${request.plan.request_id}:rebuild:${viewRevisionKey(entry.ref)}`,
      });
      replacements.push({ forgotten: entry.ref, rebuilt: exactViewRef(committed.view) });
    }
    return replacements;
  }
}

export function buildSourceTombstone(sourceValue: View, inputValue: SourceTombstoneInput): ViewDraft {
  const source = sourceValue;
  const input = SourceTombstoneInputSchema.parse(inputValue);
  if (viewRevisionKey(exactViewRef(source)) !== viewRevisionKey(input.source)) {
    throw new TypeError("Source tombstone input does not match the supplied exact Raw View");
  }
  if (source.role !== "raw") throw new TypeError("A source tombstone requires a Raw View");
  if (source.representation.kind === SOURCE_TOMBSTONE_REPRESENTATION_KIND) {
    throw new TypeError("Source View is already a tombstone");
  }
  if (!source.provenance.capture) throw new TypeError("A source tombstone requires Capture provenance");
  return parseViewDraft({
    id: source.id,
    name: source.name,
    purpose: source.purpose,
    aliases: source.aliases,
    schema: source.schema,
    role: "raw",
    time: { observed_at: input.occurred_at, created_at: input.occurred_at },
    representation: {
      form: "inline",
      kind: SOURCE_TOMBSTONE_REPRESENTATION_KIND,
      media_type: "application/json",
      value: { source_deleted: true, reason: input.reason, changed_at: input.occurred_at },
      metadata: {},
    },
    materialization: {
      primary: {
        id: "canonical-json",
        format: "json",
        media_type: "application/json",
        location: { kind: "inline" },
      },
      alternatives: [],
    },
    relations: [{ type: "supersedes", target: exactViewRef(source), metadata: {} }],
    provenance: {
      inputs: [],
      capture: source.provenance.capture,
      actor: input.actor,
      ...(input.trace_id ? { trace_id: input.trace_id } : {}),
    },
    policy: source.policy,
    metadata: {},
  });
}

function resolveRoots(views: View[], targets: ForgetTarget[]): View[] {
  const roots = new Map<string, View>();
  for (const view of views) {
    if (targets.some(target => matchesTarget(view, target))) roots.set(viewRevisionKey(exactViewRef(view)), view);
  }
  return [...roots.values()].sort(compareViews);
}

function matchesTarget(view: View, target: ForgetTarget): boolean {
  if (target.kind === "exact_view") return viewRevisionKey(exactViewRef(view)) === viewRevisionKey(target.ref);
  if (target.kind === "view_identity") return view.id === target.view_id;
  if (target.kind === "source_identity") {
    const capture = view.provenance.capture;
    return Boolean(capture)
      && capture!.connector === target.source.connector
      && capture!.connection_id === target.source.connection_id
      && capture!.source_id === target.source.source_id
      && capture!.source_kind === target.source.source_kind
      && capture!.identity === target.source.identity;
  }
  const scope = target.scope;
  return (scope.owner === undefined || view.policy.owner === scope.owner)
    && (scope.privacy === undefined || view.policy.privacy === scope.privacy)
    && (scope.schema_name === undefined || view.schema.name === scope.schema_name)
    && (scope.labels_any === undefined || scope.labels_any.some(label => view.policy.labels.includes(label)));
}

function computeImpact(views: View[], roots: View[], mixedSourceRule: "purge" | "rebuild"): ForgetImpactEntry[] {
  const identityRoots = expandRootIdentities(views, roots);
  const impacted = new Set(identityRoots.map(view => viewRevisionKey(exactViewRef(view))));
  let changed = true;
  while (changed) {
    changed = false;
    for (const view of views) {
      const key = viewRevisionKey(exactViewRef(view));
      if (impacted.has(key)) continue;
      if (dependenciesOf(view).some(ref => impacted.has(viewRevisionKey(ref)))) {
        impacted.add(key);
        changed = true;
      }
    }
  }
  const rootKeys = new Set(identityRoots.map(view => viewRevisionKey(exactViewRef(view))));
  return views
    .filter(view => impacted.has(viewRevisionKey(exactViewRef(view))))
    .sort(compareViews)
    .map(view => {
      const forgottenInputs = dependenciesOf(view).filter(ref => impacted.has(viewRevisionKey(ref)));
      const retainedInputs = view.provenance.inputs.filter(ref => !impacted.has(viewRevisionKey(ref)));
      const root = rootKeys.has(viewRevisionKey(exactViewRef(view)));
      return ForgetImpactEntrySchema.parse({
        ref: exactViewRef(view),
        role: view.role,
        reason: root ? "target" : "downstream",
        action: !root && view.role === "derived" && retainedInputs.length > 0 && mixedSourceRule === "rebuild"
          ? "rebuild"
          : "purge",
        forgotten_inputs: forgottenInputs,
        retained_inputs: retainedInputs,
      });
    });
}

function expandRootIdentities(views: View[], roots: View[]): View[] {
  const rootIds = new Set(roots.map(view => view.id));
  return views.filter(view => rootIds.has(view.id)).sort(compareViews);
}

function dependenciesOf(view: View): ExactViewRef[] {
  const refs = [...view.provenance.inputs, ...view.relations.map(relation => relation.target)];
  const unique = new Map(refs.map(ref => [viewRevisionKey(ref), ref]));
  return [...unique.values()];
}

function compareViews(left: View, right: View): number {
  return left.id.localeCompare(right.id) || left.revision - right.revision;
}

function authorizeExecution(
  plan: ForgetPlan,
  authorization: z.infer<typeof ForgetExecutionAuthorizationSchema>,
): void {
  if (authorization.kind === "confirmed_preview") {
    if (authorization.plan_digest !== plan.plan_digest) {
      throw new PrivacyForgetError(
        "Forget confirmation does not match the frozen impact plan",
        "forget_confirmation_mismatch",
        "authorize",
      );
    }
    return;
  }
  if (plan.mode !== "sensitive_cascade") {
    throw new PrivacyForgetError(
      "Sensitive cascade authorization cannot execute a normal Forget plan",
      "forget_sensitive_preauthorization_invalid",
      "authorize",
    );
  }
  if (plan.preauthorization_policy_id !== authorization.policy_id) {
    throw new PrivacyForgetError(
      "Sensitive cascade authorization does not match the frozen policy",
      "forget_sensitive_preauthorization_invalid",
      "authorize",
    );
  }
}

function nextReceipt(
  previous: ForgetStoreReceipt,
  status: "succeeded" | "failed",
  updatedAt: string,
  errorCode?: string,
  errorStage?: string,
): ForgetStoreReceipt {
  return ForgetStoreReceiptSchema.parse({
    store_id: previous.store_id,
    status,
    attempts: previous.attempts + 1,
    updated_at: updatedAt,
    ...(errorCode ? { error_code: errorCode } : {}),
    ...(errorStage ? { error_stage: errorStage } : {}),
  });
}

function validateRebuildDraft(
  draft: ViewDraft,
  affected: View,
  retained: ExactViewRef[],
  impacted: Set<string>,
): void {
  const draftRefs = [
    ...draft.provenance.inputs,
    ...draft.relations.map(relation => relation.target),
  ];
  const retainedKeys = [...retained].map(viewRevisionKey).sort();
  const inputKeys = draft.provenance.inputs.map(viewRevisionKey).sort();
  const impactedIds = new Set([...impacted].map(key => key.slice(0, key.lastIndexOf("@"))));
  const invalid = draft.id === affected.id
    || impactedIds.has(draft.id)
    || draft.role !== "derived"
    || draft.purpose !== affected.purpose
    || draft.schema.name !== affected.schema.name
    || canonicalJson(draft.policy) !== canonicalJson(affected.policy)
    || canonicalJson(retainedKeys) !== canonicalJson(inputKeys)
    || draftRefs.some(ref => impacted.has(viewRevisionKey(ref)));
  if (invalid) {
    throw new PrivacyForgetError(
      "Forget rebuild candidate does not preserve the safe retained-input contract",
      "forget_rebuild_invalid",
      "rebuild",
      { affected: exactViewRef(affected), candidate_id: draft.id },
    );
  }
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
