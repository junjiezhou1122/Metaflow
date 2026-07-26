import type {
  ExactViewRef,
  View,
  ViewRepository,
} from "@info/view";
import type {
  AutomationContextBinding,
  AutomationContextSource,
  ParsedAutomationView,
  TriggerOccurrence,
} from "./contracts.js";
import { ScheduleTriggerPayloadSchema } from "./contracts.js";

export type AutomationContextAuthorization =
  | { allowed: true; decision_id: string; reason: string }
  | { allowed: false; decision_id: string; reason: string };

export interface AutomationContextAuthorizer {
  authorize(input: {
    automation: ExactViewRef;
    occurrence: TriggerOccurrence;
    role: string;
    view: View;
  }): Promise<AutomationContextAuthorization>;
}

export type AutomationContextAttempt = {
  role: string;
  source_index: number;
  source: AutomationContextSource;
  status: "selected" | "empty" | "denied" | "failed";
  candidate_refs: ExactViewRef[];
  selected_refs: ExactViewRef[];
  authorized: Array<{ ref: ExactViewRef; decision_id: string; reason: string }>;
  denied: Array<{ ref: ExactViewRef; decision_id: string; reason: string }>;
  reason: string;
};

export type ResolvedAutomationContextBinding = {
  role: string;
  required: boolean;
  views: View[];
};

export type ResolvedAutomationContext = {
  bindings: ResolvedAutomationContextBinding[];
  disclosed_views: ExactViewRef[];
  attempts: AutomationContextAttempt[];
};

export class AutomationContextResolutionError extends Error {
  constructor(
    message: string,
    readonly code: "required_context_missing" | "view_access_denied" | "view_resolution_failed",
    readonly role: string,
    readonly attempts: AutomationContextAttempt[],
    readonly failure_context: ResolvedAutomationContext,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AutomationContextResolutionError";
  }
}

export type AutomationContextResolverOptions = {
  views: Pick<ViewRepository, "get" | "query">;
  authorizer: AutomationContextAuthorizer;
};

export interface AutomationContextResolverPort {
  resolve(input: {
    automation: ParsedAutomationView;
    occurrence: TriggerOccurrence;
  }): Promise<ResolvedAutomationContext>;
}

export class AutomationContextResolver implements AutomationContextResolverPort {
  constructor(private readonly options: AutomationContextResolverOptions) {}

  async resolve(input: {
    automation: ParsedAutomationView;
    occurrence: TriggerOccurrence;
  }): Promise<ResolvedAutomationContext> {
    const bindings: ResolvedAutomationContextBinding[] = [];
    const attempts: AutomationContextAttempt[] = [];

    for (const binding of input.automation.definition.input_mapping) {
      const resolved = await this.resolveBinding({
        automation: { view_id: input.automation.view.id, revision: input.automation.view.revision },
        occurrence: input.occurrence,
        binding,
      });
      attempts.push(...resolved.attempts);
      if (resolved.views.length > 0) {
        bindings.push({ role: binding.role, required: binding.required, views: resolved.views });
        continue;
      }
      if (!binding.required) {
        bindings.push({ role: binding.role, required: false, views: [] });
        continue;
      }
      throw requiredContextError(
        binding.role,
        attempts,
        bindings,
        resolved.candidates,
      );
    }

    return {
      bindings,
      disclosed_views: uniqueExactRefs(bindings.flatMap(binding => binding.views.map(exactRef))),
      attempts,
    };
  }

  private async resolveBinding(input: {
    automation: ExactViewRef;
    occurrence: TriggerOccurrence;
    binding: AutomationContextBinding;
  }): Promise<{ views: View[]; candidates: View[]; attempts: AutomationContextAttempt[] }> {
    const attempts: AutomationContextAttempt[] = [];
    const allCandidates: View[] = [];
    for (const [sourceIndex, source] of input.binding.sources.entries()) {
      let candidates: View[];
      try {
        candidates = await this.resolveSource(source, input.occurrence);
      } catch (error) {
        attempts.push({
          role: input.binding.role,
          source_index: sourceIndex,
          source,
          status: "failed",
          candidate_refs: [],
          selected_refs: [],
          authorized: [],
          denied: [],
          reason: errorMessage(error),
        });
        continue;
      }

      if (candidates.length === 0) {
        attempts.push({
          role: input.binding.role,
          source_index: sourceIndex,
          source,
          status: "empty",
          candidate_refs: [],
          selected_refs: [],
          authorized: [],
          denied: [],
          reason: "source returned no matching exact Views",
        });
        continue;
      }
      allCandidates.push(...candidates);

      const selected: View[] = [];
      const authorized: AutomationContextAttempt["authorized"] = [];
      const denied: AutomationContextAttempt["denied"] = [];
      let authorizationFailure: string | undefined;
      for (const view of candidates) {
        try {
          const decision = await this.options.authorizer.authorize({
            automation: input.automation,
            occurrence: input.occurrence,
            role: input.binding.role,
            view,
          });
          if (decision.allowed) {
            selected.push(view);
            authorized.push({ ref: exactRef(view), decision_id: decision.decision_id, reason: decision.reason });
          } else {
            denied.push({ ref: exactRef(view), decision_id: decision.decision_id, reason: decision.reason });
          }
        } catch (error) {
          authorizationFailure = errorMessage(error);
          break;
        }
      }

      if (authorizationFailure) {
        attempts.push({
          role: input.binding.role,
          source_index: sourceIndex,
          source,
          status: "failed",
          candidate_refs: candidates.map(exactRef),
          selected_refs: [],
          authorized,
          denied,
          reason: `authorization failed: ${authorizationFailure}`,
        });
        continue;
      }
      if (selected.length === 0) {
        attempts.push({
          role: input.binding.role,
          source_index: sourceIndex,
          source,
          status: "denied",
          candidate_refs: candidates.map(exactRef),
          selected_refs: [],
          authorized,
          denied,
          reason: "all candidate Views were denied",
        });
        continue;
      }

      attempts.push({
        role: input.binding.role,
        source_index: sourceIndex,
        source,
        status: "selected",
        candidate_refs: candidates.map(exactRef),
        selected_refs: selected.map(exactRef),
        authorized,
        denied,
        reason: denied.length > 0 ? "selected authorized candidates; denied candidates remain in trace" : "selected authorized candidates",
      });
      return { views: selected, candidates: uniqueViews(allCandidates), attempts };
    }
    return { views: [], candidates: uniqueViews(allCandidates), attempts };
  }

  private async resolveSource(source: AutomationContextSource, occurrence: TriggerOccurrence): Promise<View[]> {
    switch (source.kind) {
      case "trigger_evidence": {
        const views = await Promise.all(occurrence.evidence.map(ref => this.getExact(ref)));
        return views.filter(view => {
          if (source.schema_name && view.schema.name !== source.schema_name) return false;
          if (source.source && !captureSourceMatches(view, source.source)) return false;
          return true;
        });
      }
      case "view_ref":
        return [await this.getExact(source.ref)];
      case "view_query":
        return this.options.views.query({
          ...(source.schema_name ? { schema_name: source.schema_name } : {}),
          ...(source.schema_names ? { schema_names: source.schema_names } : {}),
          ...(source.role ? { role: source.role } : {}),
          ...(source.text ? { text: source.text } : {}),
          ...(source.time_range ? {
            time_range: occurrenceTimeRange(occurrence, source.time_range.basis),
          } : {}),
          limit: source.limit,
        });
    }
  }

  private async getExact(ref: ExactViewRef): Promise<View> {
    const view = await this.options.views.get(ref);
    if (!view) throw new Error(`exact View is missing: ${ref.view_id}@${ref.revision}`);
    if (view.id !== ref.view_id || view.revision !== ref.revision) {
      throw new Error(`View repository returned ${view.id}@${view.revision} for ${ref.view_id}@${ref.revision}`);
    }
    return view;
  }
}

function occurrenceTimeRange(
  occurrence: TriggerOccurrence,
  basis: "observed_at" | "created_at",
): { basis: "observed_at" | "created_at"; start: string; end: string } {
  if (occurrence.trigger_kind !== "schedule") {
    throw new Error("occurrence_period time_range requires a schedule occurrence");
  }
  const payload = ScheduleTriggerPayloadSchema.parse(occurrence.payload);
  return { basis, start: payload.period.start, end: payload.period.end };
}

function requiredContextError(
  role: string,
  attempts: AutomationContextAttempt[],
  resolvedBindings: ResolvedAutomationContextBinding[],
  candidates: View[],
): AutomationContextResolutionError {
  const failureContext: ResolvedAutomationContext = {
    bindings: [
      ...resolvedBindings,
      { role, required: true, views: candidates },
    ],
    disclosed_views: uniqueExactRefs(resolvedBindings.flatMap(binding => binding.views.map(exactRef))),
    attempts,
  };
  if (attempts.some(attempt => attempt.status === "failed")) {
    return new AutomationContextResolutionError(
      `required context resolution failed for role: ${role}`,
      "view_resolution_failed",
      role,
      attempts,
      failureContext,
    );
  }
  if (attempts.some(attempt => attempt.status === "denied")) {
    return new AutomationContextResolutionError(
      `required context was denied for role: ${role}`,
      "view_access_denied",
      role,
      attempts,
      failureContext,
    );
  }
  return new AutomationContextResolutionError(
    `required context is missing for role: ${role}`,
    "required_context_missing",
    role,
    attempts,
    failureContext,
  );
}

function uniqueViews(views: View[]): View[] {
  const values = new Map<string, View>();
  for (const view of views) values.set(`${view.id}@${view.revision}`, view);
  return [...values.values()];
}

function captureSourceMatches(view: View, expected: string): boolean {
  const capture = view.provenance.capture;
  return Boolean(capture && [capture.connector, capture.connection_id, capture.source_kind].includes(expected));
}

function exactRef(view: View): ExactViewRef {
  return { view_id: view.id, revision: view.revision };
}

function uniqueExactRefs(refs: ExactViewRef[]): ExactViewRef[] {
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
