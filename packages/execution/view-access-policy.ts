import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ExactViewRefSchema,
  IdentifierSchema,
  ViewPolicySchema,
  ViewRevisionSchema,
  canonicalJson,
  type ExactViewRef,
  type View,
  type ViewPolicy,
} from "@info/view";
import {
  OperatorSnapshotSchema,
  type OperatorSnapshot,
} from "@info/transformation";

const ExactViewRuleTargetSchema = z.object({
  kind: z.literal("view"),
  ref: ExactViewRefSchema,
}).strict();

const SourceRuleTargetSchema = z.object({
  kind: z.literal("source"),
  connector: IdentifierSchema.optional(),
  connection_id: IdentifierSchema.optional(),
  source_kind: IdentifierSchema.optional(),
  source_id: IdentifierSchema.optional(),
}).strict().refine(
  target => target.connector !== undefined
    || target.connection_id !== undefined
    || target.source_kind !== undefined
    || target.source_id !== undefined,
  "A source access rule requires at least one source field",
);

const SchemaRuleTargetSchema = z.object({
  kind: z.literal("schema"),
  name: IdentifierSchema,
  version: z.number().int().positive().optional(),
}).strict();

const OperatorRuleTargetSchema = z.object({
  kind: z.literal("operator"),
  operator_id: IdentifierSchema,
  revision: z.number().int().positive().optional(),
}).strict();

export const ViewAccessRuleTargetSchema = z.union([
  ExactViewRuleTargetSchema,
  SourceRuleTargetSchema,
  SchemaRuleTargetSchema,
  OperatorRuleTargetSchema,
]);

export const ViewAccessRuleSchema = z.object({
  id: IdentifierSchema,
  effect: z.enum(["allow", "deny"]),
  target: ViewAccessRuleTargetSchema,
  reason: z.string().trim().min(1).max(2_000),
}).strict();

export const ViewAccessPolicyConfigurationSchema = z.object({
  kind: z.literal("view_access"),
  profile: z.enum(["manual", "smart_approve", "approve_all"]),
  rules: z.array(ViewAccessRuleSchema).default([]),
}).strict().superRefine((configuration, context) => {
  const ids = configuration.rules.map(rule => rule.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "View access rule ids must be unique",
      path: ["rules"],
    });
  }
});

export const ViewAccessPolicySnapshotSchema = z.object({
  id: IdentifierSchema,
  revision: z.number().int().positive(),
  configuration: ViewAccessPolicyConfigurationSchema,
}).strict();

export const ViewAccessUseSchema = z.enum([
  "local_execution",
  "external_model",
  "embedding",
]);

export const ViewAccessAuthorizationRequestSchema = z.object({
  policy: ViewAccessPolicySnapshotSchema,
  operator: OperatorSnapshotSchema,
  use: ViewAccessUseSchema,
  views: z.array(ViewRevisionSchema),
}).strict().superRefine((request, context) => {
  const refs = request.views.map(view => `${view.id}@${view.revision}`);
  if (new Set(refs).size !== refs.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A View access request cannot contain duplicate exact revisions",
      path: ["views"],
    });
  }
});

export const ViewAccessDecisionProvenanceSchema = z.object({
  source: z.enum(["view_constraint", "explicit_rule", "profile_default"]),
  id: IdentifierSchema,
  effect: z.enum(["allow", "deny", "require_approval"]),
  reason: z.string().trim().min(1),
}).strict();

export const ViewAccessViewDecisionSchema = z.object({
  view: ExactViewRefSchema,
  outcome: z.enum(["allowed", "denied", "approval_required"]),
  decisive: ViewAccessDecisionProvenanceSchema,
  matched: z.array(ViewAccessDecisionProvenanceSchema),
}).strict();

export const ViewAccessDecisionSchema = z.object({
  decision_id: IdentifierSchema,
  outcome: z.enum(["allowed", "denied", "approval_required"]),
  policy: z.object({
    policy_id: IdentifierSchema,
    revision: z.number().int().positive(),
  }).strict(),
  operator: z.object({
    operator_id: IdentifierSchema,
    revision: z.number().int().positive(),
  }).strict(),
  use: ViewAccessUseSchema,
  allowed_views: z.array(ExactViewRefSchema),
  denied_views: z.array(ExactViewRefSchema),
  approval_required_views: z.array(ExactViewRefSchema),
  operator_matches: z.array(ViewAccessDecisionProvenanceSchema),
  views: z.array(ViewAccessViewDecisionSchema),
}).strict();

export type ViewAccessRuleTarget = z.infer<typeof ViewAccessRuleTargetSchema>;
export type ViewAccessRule = z.infer<typeof ViewAccessRuleSchema>;
export type ViewAccessPolicyConfiguration = z.infer<typeof ViewAccessPolicyConfigurationSchema>;
export type ViewAccessPolicySnapshot = z.infer<typeof ViewAccessPolicySnapshotSchema>;
export type ViewAccessUse = z.infer<typeof ViewAccessUseSchema>;
export type ViewAccessAuthorizationRequest = z.infer<typeof ViewAccessAuthorizationRequestSchema>;
export type ViewAccessOutcome = "allowed" | "denied" | "approval_required";

export type ViewAccessDecisionProvenance = {
  source: "view_constraint" | "explicit_rule" | "profile_default";
  id: string;
  effect: "allow" | "deny" | "require_approval";
  reason: string;
};

export type ViewAccessViewDecision = {
  view: ExactViewRef;
  outcome: ViewAccessOutcome;
  decisive: ViewAccessDecisionProvenance;
  matched: ViewAccessDecisionProvenance[];
};

export type ViewAccessDecision = {
  decision_id: string;
  outcome: ViewAccessOutcome;
  policy: { policy_id: string; revision: number };
  operator: { operator_id: string; revision: number };
  use: ViewAccessUse;
  allowed_views: ExactViewRef[];
  denied_views: ExactViewRef[];
  approval_required_views: ExactViewRef[];
  operator_matches: ViewAccessDecisionProvenance[];
  views: ViewAccessViewDecision[];
};

export interface ViewAccessAuthorizer {
  authorize(input: ViewAccessAuthorizationRequest): Promise<ViewAccessDecision>;
}

export class DeterministicViewAccessAuthorizer implements ViewAccessAuthorizer {
  async authorize(input: ViewAccessAuthorizationRequest): Promise<ViewAccessDecision> {
    return evaluateViewAccess(input);
  }
}

export function parseViewAccessPolicySnapshot(input: unknown): ViewAccessPolicySnapshot {
  return ViewAccessPolicySnapshotSchema.parse(input);
}

export function evaluateViewAccess(input: unknown): ViewAccessDecision {
  const request = ViewAccessAuthorizationRequestSchema.parse(input);
  const operatorRules = request.policy.configuration.rules.filter(rule => matchesOperator(rule.target, request.operator));
  const operatorMatches = operatorRules.map(ruleProvenance);
  const viewDecisions = request.views
    .map(view => evaluateView(request, view, operatorRules))
    .sort((left, right) => exactRefKey(left.view).localeCompare(exactRefKey(right.view)));

  const operatorDeny = operatorMatches.find(match => match.effect === "deny");
  const outcome = operatorDeny
    ? "denied"
    : viewDecisions.some(decision => decision.outcome === "denied")
      ? "denied"
      : viewDecisions.some(decision => decision.outcome === "approval_required")
        ? "approval_required"
        : "allowed";

  const decisionPayload = {
    policy: request.policy,
    operator: request.operator,
    use: request.use,
    views: request.views
      .map(policyRelevantViewSnapshot)
      .sort((left, right) => exactRefKey(left.ref).localeCompare(exactRefKey(right.ref))),
  };

  return {
    decision_id: `view-access:${createHash("sha256").update(canonicalJson(decisionPayload)).digest("hex")}`,
    outcome,
    policy: { policy_id: request.policy.id, revision: request.policy.revision },
    operator: { operator_id: request.operator.id, revision: request.operator.revision },
    use: request.use,
    allowed_views: operatorDeny ? [] : refsWithOutcome(viewDecisions, "allowed"),
    denied_views: operatorDeny
      ? viewDecisions.map(decision => decision.view)
      : refsWithOutcome(viewDecisions, "denied"),
    approval_required_views: operatorDeny ? [] : refsWithOutcome(viewDecisions, "approval_required"),
    operator_matches: operatorMatches,
    views: operatorDeny
      ? viewDecisions.map(decision => forceOperatorDeny(decision, operatorDeny))
      : viewDecisions,
  };
}

export type ViewPolicyInheritanceErrorCode = "no_input_policies" | "mixed_owners";

export class ViewPolicyInheritanceError extends Error {
  constructor(
    message: string,
    readonly code: ViewPolicyInheritanceErrorCode,
  ) {
    super(message);
    this.name = "ViewPolicyInheritanceError";
  }
}

export function inheritStrictestViewPolicy(inputs: readonly ViewPolicy[]): ViewPolicy {
  if (inputs.length === 0) {
    throw new ViewPolicyInheritanceError(
      "At least one input policy is required for View policy inheritance",
      "no_input_policies",
    );
  }
  const policies = inputs.map(policy => ViewPolicySchema.parse(policy));
  const owners = new Set(policies.map(policy => policy.owner));
  if (owners.size !== 1) {
    throw new ViewPolicyInheritanceError(
      "View policies with different owners require an explicit cross-owner policy decision",
      "mixed_owners",
    );
  }

  const localSearchPolicies = policies.map(policy => policy.allow_local_search);
  return ViewPolicySchema.parse({
    owner: policies[0]!.owner,
    visibility: strictest(policies.map(policy => policy.visibility), ["public", "shared", "private"]),
    privacy: strictest(policies.map(policy => policy.privacy), ["public", "private", "sensitive"]),
    retention: strictest(policies.map(policy => policy.retention), ["archive", "normal", "session", "do_not_store"]),
    allow_external_model: policies.every(policy => policy.allow_external_model),
    allow_embedding: policies.every(policy => policy.allow_embedding),
    ...(localSearchPolicies.some(value => value === false)
      ? { allow_local_search: false }
      : localSearchPolicies.some(value => value === true)
        ? { allow_local_search: true }
        : {}),
    labels: [...new Set(policies.flatMap(policy => policy.labels))].sort(),
  });
}

function evaluateView(
  request: ViewAccessAuthorizationRequest,
  view: View,
  operatorRules: ViewAccessRule[],
): ViewAccessViewDecision {
  const viewRules = request.policy.configuration.rules.filter(rule => (
    rule.target.kind !== "operator" && matchesView(rule.target, view)
  ));
  const matched = [
    ...hardConstraints(view, request.use),
    ...operatorRules.map(ruleProvenance),
    ...viewRules.map(ruleProvenance),
  ];
  const hardDeny = matched.find(match => match.source === "view_constraint" && match.effect === "deny");
  const explicitDeny = matched.find(match => match.source === "explicit_rule" && match.effect === "deny");
  const explicitAllow = matched.find(match => match.source === "explicit_rule" && match.effect === "allow");
  const decisive = hardDeny
    ?? explicitDeny
    ?? explicitAllow
    ?? profileDefault(request.policy.configuration.profile, view);

  return {
    view: exactRef(view),
    outcome: outcomeFor(decisive.effect),
    decisive,
    matched: [...matched, ...(matched.includes(decisive) ? [] : [decisive])],
  };
}

function hardConstraints(view: View, use: ViewAccessUse): ViewAccessDecisionProvenance[] {
  if (use === "external_model" && !view.policy.allow_external_model) {
    return [{
      source: "view_constraint",
      id: "view.policy.allow_external_model",
      effect: "deny",
      reason: "The exact View revision forbids external model disclosure",
    }];
  }
  if (use === "embedding" && !view.policy.allow_embedding) {
    return [{
      source: "view_constraint",
      id: "view.policy.allow_embedding",
      effect: "deny",
      reason: "The exact View revision forbids embedding disclosure",
    }];
  }
  return [];
}

function profileDefault(
  profile: ViewAccessPolicyConfiguration["profile"],
  view: View,
): ViewAccessDecisionProvenance {
  if (profile === "manual") {
    return {
      source: "profile_default",
      id: "profile.manual",
      effect: "require_approval",
      reason: "Manual profile requires an explicit decision for unmatched Views",
    };
  }
  if (profile === "smart_approve" && view.policy.privacy === "sensitive") {
    return {
      source: "profile_default",
      id: "profile.smart_approve.sensitive",
      effect: "require_approval",
      reason: "Smart Approve requires explicit approval for sensitive Views",
    };
  }
  return {
    source: "profile_default",
    id: profile === "smart_approve" ? "profile.smart_approve" : "profile.approve_all",
    effect: "allow",
    reason: profile === "smart_approve"
      ? "Smart Approve permits a non-sensitive View without a matching deny"
      : "Approve All permits a View without a matching deny",
  };
}

function ruleProvenance(rule: ViewAccessRule): ViewAccessDecisionProvenance {
  return {
    source: "explicit_rule",
    id: rule.id,
    effect: rule.effect,
    reason: rule.reason,
  };
}

function matchesOperator(target: ViewAccessRuleTarget, operator: OperatorSnapshot): boolean {
  return target.kind === "operator"
    && target.operator_id === operator.id
    && (target.revision === undefined || target.revision === operator.revision);
}

function matchesView(target: ViewAccessRuleTarget, view: View): boolean {
  switch (target.kind) {
    case "view":
      return target.ref.view_id === view.id && target.ref.revision === view.revision;
    case "schema":
      return target.name === view.schema.name
        && (target.version === undefined || target.version === view.schema.version);
    case "source": {
      const capture = view.provenance.capture;
      return capture !== undefined
        && (target.connector === undefined || target.connector === capture.connector)
        && (target.connection_id === undefined || target.connection_id === capture.connection_id)
        && (target.source_kind === undefined || target.source_kind === capture.source_kind)
        && (target.source_id === undefined || target.source_id === capture.source_id);
    }
    case "operator":
      return false;
  }
}

function policyRelevantViewSnapshot(view: View) {
  return {
    ref: exactRef(view),
    schema: view.schema,
    policy: view.policy,
    capture: view.provenance.capture ?? null,
  };
}

function forceOperatorDeny(
  decision: ViewAccessViewDecision,
  deny: ViewAccessDecisionProvenance,
): ViewAccessViewDecision {
  return {
    ...decision,
    outcome: "denied",
    decisive: deny,
  };
}

function refsWithOutcome(
  decisions: ViewAccessViewDecision[],
  outcome: ViewAccessOutcome,
): ExactViewRef[] {
  return decisions.filter(decision => decision.outcome === outcome).map(decision => decision.view);
}

function outcomeFor(effect: ViewAccessDecisionProvenance["effect"]): ViewAccessOutcome {
  if (effect === "allow") return "allowed";
  if (effect === "deny") return "denied";
  return "approval_required";
}

function exactRef(view: Pick<View, "id" | "revision">): ExactViewRef {
  return { view_id: view.id, revision: view.revision };
}

function exactRefKey(ref: ExactViewRef): string {
  return `${ref.view_id}@${ref.revision}`;
}

function strictest<T extends string>(values: T[], order: readonly T[]): T {
  return values.reduce((current, value) => (
    order.indexOf(value) > order.indexOf(current) ? value : current
  ));
}
