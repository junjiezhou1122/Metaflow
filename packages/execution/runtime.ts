import { randomUUID } from "node:crypto";
import {
  ViewRepositoryError,
  canonicalJson,
  exactViewRef,
  parseViewDraft,
  viewRevisionKey,
  type ExactViewRef,
  type JsonObject,
  type View,
  type ViewDraft,
  type ViewPolicy,
  type ViewRepository,
} from "@info/view";
import type { Transformation, ViewSelectorSnapshot } from "@info/transformation";
import { buildFailureEvidence, parseFailureView } from "./failure.js";
import {
  inheritStrictestViewPolicy,
  type ViewAccessAuthorizer,
  type ViewAccessDecision,
} from "./view-access-policy.js";
import {
  ExecutionAttemptSchema,
  ExecutionRunSchema,
  OperatorCandidateEnvelopeSchema,
  parseExecutionRun,
  parseOperatorCandidateEnvelope,
  type ExecutionAttempt,
  type ExecutionReplayExplanation,
  type ExecutionRepository,
  type ExecutionResult,
  type ExecutionRun,
  type ExecutionRunError,
  type ExecutionRunStatus,
  type OperatorCandidateEnvelope,
  type OperatorExecutionPort,
  type ResolvedInputBinding,
  type StartExecutionInput,
} from "./runtime-contracts.js";

export interface ViewSelectorResolver {
  resolve(selector: ViewSelectorSnapshot): Promise<View[]>;
}

export class RepositoryViewSelectorResolver implements ViewSelectorResolver {
  constructor(private readonly views: ViewRepository) {}

  async resolve(selector: ViewSelectorSnapshot): Promise<View[]> {
    const query = selector.query;
    const candidates = await this.views.query({
      revisions: query.revision_scope,
      limit: query.limit,
    });
    const filtered = candidates.filter(view => matchesSelector(view, selector));
    filtered.sort((left, right) => {
      const leftTime = Date.parse(left.time.observed_at ?? left.time.created_at);
      const rightTime = Date.parse(right.time.observed_at ?? right.time.created_at);
      const direction = query.order === "oldest" ? leftTime - rightTime : rightTime - leftTime;
      return direction || viewRevisionKey(exactViewRef(left)).localeCompare(viewRevisionKey(exactViewRef(right)));
    });
    return filtered.slice(0, query.limit);
  }
}

export type ExecutionRuntimeOptions = {
  now?: () => string;
  id?: (kind: "trace" | "attempt") => string;
};

export type ExecutionRuntimeErrorCode =
  | "input_not_found"
  | "required_input_empty"
  | "invocation_input_role_unknown"
  | "invocation_input_ineligible"
  | "authorization_denied"
  | "approval_required"
  | "operator_failed"
  | "operator_crashed"
  | "cancelled"
  | "timeout"
  | "candidate_invalid"
  | "schema_mismatch"
  | "policy_mismatch"
  | "provenance_mismatch"
  | "stale_base"
  | "budget_exceeded"
  | "commit_failed"
  | "failure_commit_failed"
  | "idempotency_conflict"
  | "run_already_active"
  | "replay_incomplete"
  | "cycle"
  | "depth_exhausted"
  | "fan_out_exhausted"
  | "attempts_exhausted"
  | "cost_exhausted"
  | "time_exhausted"
  | "cascade_stopped"
  | "pre_execution_failed"
  | "worker_process_abandoned";

export class ExecutionRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: ExecutionRuntimeErrorCode,
    readonly stage: ExecutionRunError["stage"],
    readonly details: JsonObject = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExecutionRuntimeError";
  }
}

export class ExecutionRuntime {
  private readonly now: () => string;
  private readonly id: (kind: "trace" | "attempt") => string;

  constructor(
    private readonly views: ViewRepository,
    private readonly runs: ExecutionRepository,
    private readonly authorizer: ViewAccessAuthorizer,
    private readonly operators: OperatorExecutionPort,
    private readonly selectors: ViewSelectorResolver = new RepositoryViewSelectorResolver(views),
    options: ExecutionRuntimeOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? (kind => `${kind}:${randomUUID()}`);
  }

  async execute(input: StartExecutionInput, options: { signal?: AbortSignal } = {}): Promise<ExecutionResult> {
    const outputPolicy = resolveOutputPolicy(input.output_policy, input.failure_policy);
    if (input.idempotency_key) {
      const replay = await this.runs.getRunByIdempotencyKey(input.idempotency_key);
      if (replay) {
        assertIdempotentExecutionRequest(replay, input);
        return this.resultFromStoredRun(replay);
      }
    }
    const transformation = input.transformation;
    const resolved = await this.resolveInputs(
      transformation,
      input.invocation_inputs,
      input.pre_execution_failure !== undefined || input.cascade?.disposition === "terminal",
    );
    const selectedViews = resolved.flatMap(binding => binding.views);
    inheritedPolicy(selectedViews, outputPolicy);
    const decision = await this.authorizer.authorize({
      policy: input.access_policy,
      operator: transformation.operator,
      use: input.access_use,
      views: selectedViews,
    });
    const createdAt = this.now();
    const run = parseExecutionRun({
      id: input.run_id,
      correlation_id: input.correlation_id,
      trace_id: this.id("trace"),
      status: "ready",
      frozen: {
        transformation,
        inputs: resolved.map(item => item.binding),
        ...(input.invocation_inputs ? { invocation_inputs: input.invocation_inputs } : {}),
        access_policy: input.access_policy,
        authorization: decision,
        access_use: input.access_use,
        ...(input.runtime_override ? { runtime_override: input.runtime_override } : {}),
        ...(input.idempotency_key ? { idempotency_key: input.idempotency_key } : {}),
        ...(input.repair_context ? { repair: input.repair_context } : {}),
        ...(outputPolicy ? { output_policy: outputPolicy } : {}),
        ...(input.failure_policy ? { failure_policy: input.failure_policy } : {}),
        ...(input.previous_attempt_id ? { previous_attempt_id: input.previous_attempt_id } : {}),
        ...(input.cascade ? {
          cascade: {
            ...input.cascade,
            target: {
              ...input.cascade.target,
              operator: {
                id: transformation.operator.id,
                revision: transformation.operator.revision,
              },
            },
          },
        } : {}),
        ...(input.pre_execution_failure ? { pre_execution_failure: input.pre_execution_failure } : {}),
      },
      created_at: createdAt,
      output_views: [],
      total_cost_usd: 0,
    });

    const creation = await this.runs.createRun(run);
    if (!creation.created) {
      assertIdempotentExecutionRequest(creation.run, input);
      return this.resultFromStoredRun(creation.run);
    }
    await this.emit(run, undefined, "run.created", {
      authorization_decision_id: decision.decision_id,
      selected_inputs: selectedViews.map(view => exactViewRef(view)),
    });

    if (run.frozen.cascade?.disposition === "terminal") {
      const terminal = run.frozen.cascade.terminal;
      if (!terminal) throw new Error(`terminal cascade ${run.frozen.cascade.attempt_id} lost terminal evidence`);
      return this.failRun(
        run,
        undefined,
        selectedViews,
        frozenOutputPolicy(run),
        new ExecutionRuntimeError(terminal.message, "cascade_stopped", "execution", {
          cascade_attempt_id: run.frozen.cascade.attempt_id,
          root_correlation_id: run.frozen.cascade.root_correlation_id,
          terminal_code: terminal.code,
          terminal_stage: terminal.stage,
        }),
        undefined,
        0,
        "failed",
      );
    }

    if (decision.outcome !== "allowed") {
      const error = decision.outcome === "denied"
        ? new ExecutionRuntimeError("View access authorization denied the Run", "authorization_denied", "authorization", {
            decision_id: decision.decision_id,
            denied_views: decision.denied_views,
          })
        : new ExecutionRuntimeError("View access requires explicit approval", "approval_required", "authorization", {
            decision_id: decision.decision_id,
            approval_required_views: decision.approval_required_views,
          });
      return this.failRun(run, undefined, selectedViews, frozenOutputPolicy(run), error, undefined, 0, "failed");
    }

    if (run.frozen.pre_execution_failure) {
      const failure = run.frozen.pre_execution_failure;
      return this.failRun(
        run,
        undefined,
        selectedViews,
        frozenOutputPolicy(run),
        new ExecutionRuntimeError(failure.message, "pre_execution_failed", failure.stage, {
          pre_execution_code: failure.code,
          ...failure.details,
        }),
        undefined,
        0,
        "failed",
      );
    }

    const startedAt = this.now();
    const attempt = ExecutionAttemptSchema.parse({
      id: this.id("attempt"),
      run_id: run.id,
      sequence: 1,
      ...(input.previous_attempt_id ? { previous_attempt_id: input.previous_attempt_id } : {}),
      operator: transformation.operator,
      status: "running",
      started_at: startedAt,
      cost_usd: 0,
    });
    await this.runs.updateRunStarted({ run_id: run.id, attempt, started_at: startedAt });
    await this.emit(run, attempt, "attempt.started", {
      previous_attempt_id: attempt.previous_attempt_id ?? null,
      operator: attempt.operator,
    });

    let candidate: unknown;
    let cost = 0;
    try {
      const outcome = await this.invokeOperator(run, attempt, resolved, options.signal);
      cost = outcome.cost_usd ?? 0;
      if (outcome.status === "cancelled") {
        throw new ExecutionRuntimeError(outcome.reason ?? "Operator execution was cancelled", "cancelled", "execution");
      }
      if (outcome.status === "failed") {
        throw new ExecutionRuntimeError(outcome.error.message, "operator_failed", "execution", {
          ...(outcome.error.details ?? {}),
          operator_code: outcome.error.code,
        });
      }
      candidate = outcome.candidate;
      const budgetCost = transformation.budget?.limits.max_cost_usd;
      if (budgetCost !== undefined && cost > budgetCost) {
        throw new ExecutionRuntimeError(
          `Operator cost ${cost} exceeded Run budget ${budgetCost}`,
          "budget_exceeded",
          "validation",
          { cost_usd: cost, max_cost_usd: budgetCost },
        );
      }
      const outputs = await this.validateCandidate(run, selectedViews, candidate, frozenOutputPolicy(run));
      const completedAt = this.now();
      const completedAttempt = finishAttempt(attempt, "succeeded", completedAt, cost);
      const committed = await this.runs.commitSuccess({
        run_id: run.id,
        attempt: completedAttempt,
        completed_at: completedAt,
        cost_usd: cost,
        outputs,
        terminal_event: {
          run_id: run.id,
          attempt_id: attempt.id,
          type: "run.succeeded",
          occurred_at: completedAt,
          payload: { output_count: outputs.length, cost_usd: cost },
        },
        ...(run.frozen.cascade ? {
          cascade: {
            ...run.frozen.cascade,
            aggregate: {
              ...run.frozen.cascade.aggregate,
              cost_usd: run.frozen.cascade.aggregate.cost_usd + cost,
            },
            disposition: "continue" as const,
          },
        } : {}),
      });
      const storedRun = await this.mustGetRun(run.id);
      return { run: storedRun, outputs: committed.results.map(result => result.view) };
    } catch (caught) {
      const error = normalizeRuntimeError(caught, options.signal?.aborted === true);
      const status: Extract<ExecutionRunStatus, "failed" | "cancelled" | "timed_out"> = error.code === "cancelled"
        ? "cancelled"
        : error.code === "timeout" ? "timed_out" : "failed";
      return this.failRun(run, attempt, selectedViews, frozenOutputPolicy(run), error, candidate, cost, status);
    }
  }

  async replay(runId: string): Promise<ExecutionReplayExplanation> {
    const run = await this.mustGetRun(runId);
    const attempts = await this.runs.getAttempts(runId);
    const events = await this.runs.getTrace(runId);
    const committedOutputs = [];
    for (const ref of run.output_views) {
      const view = await this.views.get(ref);
      if (!view || view.provenance.operator_run_id !== run.id) {
        throw new ExecutionRuntimeError(
          `Run replay cannot explain output ${viewRevisionKey(ref)}`,
          "replay_incomplete",
          "commit",
          { output: ref },
        );
      }
      committedOutputs.push({
        ref,
        operator_run_id: view.provenance.operator_run_id,
        inputs: view.provenance.inputs,
      });
    }
    let failure: ExecutionReplayExplanation["failure"];
    if (run.failure_view) {
      const failureView = await this.views.get(run.failure_view);
      if (!failureView) {
        throw new ExecutionRuntimeError(
          `Run replay cannot load Failure View ${viewRevisionKey(run.failure_view)}`,
          "replay_incomplete",
          "commit",
          { failure_view: run.failure_view },
        );
      }
      const evidence = parseFailureView(failureView);
      failure = {
        ref: run.failure_view,
        inputs: failureView.provenance.inputs,
        ...(evidence.candidate_artifact ? { candidate_artifact: evidence.candidate_artifact } : {}),
        ancestor_failures: evidence.causal_chain.ancestor_failures,
      };
    }
    return { run, attempts, events, committed_outputs: committedOutputs, ...(failure ? { failure } : {}) };
  }

  async reconcileAbandonedRun(
    runId: string,
    input: { code: ExecutionRuntimeErrorCode; message: string },
  ): Promise<ExecutionResult> {
    const run = await this.mustGetRun(runId);
    if (run.status !== "ready" && run.status !== "running") {
      return this.resultFromStoredRun(run);
    }
    const attempts = await this.runs.getAttempts(runId);
    const running = attempts.filter(attempt => attempt.status === "running");
    if (run.status === "running" && running.length !== 1) {
      throw new ExecutionRuntimeError(
        `Abandoned Run ${runId} has ${running.length} running attempts`,
        "replay_incomplete",
        "commit",
        { run_id: runId, running_attempts: running.map(attempt => attempt.id) },
      );
    }
    if (run.status === "ready" && attempts.length > 0) {
      throw new ExecutionRuntimeError(
        `Ready Run ${runId} already has persisted attempts`,
        "replay_incomplete",
        "commit",
        { run_id: runId, attempts: attempts.map(attempt => attempt.id) },
      );
    }
    const views = await this.resolveFrozenInputViews(run);
    return this.failRun(
      run,
      running[0],
      views,
      frozenOutputPolicy(run),
      new ExecutionRuntimeError(input.message, input.code, "execution", {
        run_id: runId,
        recovery: "abandoned_run",
      }),
      undefined,
      run.total_cost_usd,
      "failed",
    );
  }

  private async resolveFrozenInputViews(run: ExecutionRun): Promise<View[]> {
    const refs = run.frozen.inputs.flatMap(binding => binding.selected);
    const views: View[] = [];
    for (const ref of refs) {
      const view = await this.views.get(ref);
      if (!view) {
        throw new ExecutionRuntimeError(
          `Abandoned Run ${run.id} lost input ${viewRevisionKey(ref)}`,
          "replay_incomplete",
          "commit",
          { run_id: run.id, input: ref },
        );
      }
      views.push(view);
    }
    return views;
  }

  private async resolveInputs(
    transformation: Transformation,
    invocationInputs: StartExecutionInput["invocation_inputs"],
    allowMissingRequired = false,
  ): Promise<Array<{ binding: ResolvedInputBinding; views: View[] }>> {
    const supplied = new Map<string, ExactViewRef[]>();
    for (const binding of invocationInputs ?? []) {
      if (supplied.has(binding.role)) {
        throw new ExecutionRuntimeError(
          `Invocation input role ${binding.role} is duplicated`,
          "invocation_input_ineligible",
          "validation",
          { role: binding.role },
        );
      }
      const keys = binding.views.map(viewRevisionKey);
      if (new Set(keys).size !== keys.length) {
        throw new ExecutionRuntimeError(
          `Invocation input role ${binding.role} repeats an exact View revision`,
          "invocation_input_ineligible",
          "validation",
          { role: binding.role },
        );
      }
      supplied.set(binding.role, binding.views);
    }
    const declaredRoles = new Set(transformation.inputs.map(binding => binding.role));
    for (const role of supplied.keys()) {
      if (!declaredRoles.has(role)) {
        throw new ExecutionRuntimeError(
          `Invocation input role ${role} is not declared by the frozen Transformation`,
          "invocation_input_role_unknown",
          "validation",
          { role },
        );
      }
    }
    const resolved = [];
    for (const binding of transformation.inputs) {
      const suppliedRefs = supplied.get(binding.role);
      if (suppliedRefs) {
        const suppliedViews: View[] = [];
        for (const ref of suppliedRefs) {
          const view = await this.views.get(ref);
          if (!view) {
            throw new ExecutionRuntimeError(
              `Invocation input ${viewRevisionKey(ref)} does not exist`,
              "input_not_found",
              "validation",
              { input: ref, role: binding.role },
            );
          }
          if (!binding.sources.some(source => source.kind === "view"
            ? viewRevisionKey(source.ref) === viewRevisionKey(ref)
            : matchesSelector(view, source.selector))) {
            throw new ExecutionRuntimeError(
              `Invocation input ${viewRevisionKey(ref)} is not eligible for role ${binding.role}`,
              "invocation_input_ineligible",
              "validation",
              { input: ref, role: binding.role },
            );
          }
          suppliedViews.push(view);
        }
        const uniqueViews = uniqueByRef(suppliedViews);
        if (binding.required && uniqueViews.length === 0 && !allowMissingRequired) {
          throw new ExecutionRuntimeError(
            `Required invocation input role ${binding.role} supplied no Views`,
            "required_input_empty",
            "validation",
            { role: binding.role },
          );
        }
        const sources = binding.sources.map(source => {
          const eligible = uniqueViews.filter(view => source.kind === "view"
            ? viewRevisionKey(source.ref) === viewRevisionKey(exactViewRef(view))
            : matchesSelector(view, source.selector));
          const refs = eligible.map(view => exactViewRef(view));
          return { source, candidates: refs, selected: refs };
        });
        resolved.push({
          binding: {
            role: binding.role,
            required: binding.required,
            sources,
            selected: uniqueViews.map(view => exactViewRef(view)),
          },
          views: uniqueViews,
        });
        continue;
      }
      const sources = [];
      const selectedViews: View[] = [];
      for (const source of binding.sources) {
        if (source.kind === "view") {
          const view = await this.views.get(source.ref);
          if (!view) {
            throw new ExecutionRuntimeError(
              `Exact input ${viewRevisionKey(source.ref)} does not exist`,
              "input_not_found",
              "validation",
              { input: source.ref, role: binding.role },
            );
          }
          sources.push({ source, candidates: [source.ref], selected: [source.ref] });
          selectedViews.push(view);
        } else {
          const candidates = await this.selectors.resolve(source.selector);
          const refs = candidates.map(view => exactViewRef(view));
          sources.push({ source, candidates: refs, selected: refs });
          selectedViews.push(...candidates);
        }
      }
      const uniqueViews = uniqueByRef(selectedViews);
      if (binding.required && uniqueViews.length === 0 && !allowMissingRequired) {
        throw new ExecutionRuntimeError(
          `Required input role ${binding.role} resolved no Views`,
          "required_input_empty",
          "validation",
          { role: binding.role },
        );
      }
      resolved.push({
        binding: {
          role: binding.role,
          required: binding.required,
          sources,
          selected: uniqueViews.map(view => exactViewRef(view)),
        },
        views: uniqueViews,
      });
    }
    return resolved;
  }

  private async invokeOperator(
    run: ExecutionRun,
    attempt: ExecutionAttempt,
    resolved: Array<{ binding: ResolvedInputBinding; views: View[] }>,
    externalSignal?: AbortSignal,
  ) {
    const controller = new AbortController();
    let termination: "cancelled" | "timed_out" | undefined;
    let resolveTermination!: (value: "cancelled" | "timed_out") => void;
    const terminationPromise = new Promise<"cancelled" | "timed_out">(resolve => {
      resolveTermination = resolve;
    });
    const cancel = () => {
      if (termination) return;
      termination = "cancelled";
      controller.abort();
      resolveTermination("cancelled");
    };
    externalSignal?.addEventListener("abort", cancel, { once: true });
    if (externalSignal?.aborted) cancel();
    const timeoutMs = run.frozen.transformation.budget?.limits.timeout_ms;
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      if (termination) return;
      termination = "timed_out";
      controller.abort();
      resolveTermination("timed_out");
    }, timeoutMs);

    const execution = this.operators.execute({
      run,
      attempt,
      inputs: resolved.map(item => ({ role: item.binding.role, views: item.views })),
    }, {
      signal: controller.signal,
      emit: event => this.emit(run, attempt, event.type, event.payload ?? {}, event.occurred_at),
    });
    try {
      const winner = await Promise.race([
        execution.then(result => ({ kind: "result" as const, result })),
        terminationPromise.then(reason => ({ kind: "termination" as const, reason })),
      ]);
      if (winner.kind === "result") return winner.result;
      await this.operators.cancel(attempt.id);
      void execution.catch(() => undefined);
      throw new ExecutionRuntimeError(
        winner.reason === "timed_out" ? "Operator execution timed out" : "Operator execution was cancelled",
        winner.reason === "timed_out" ? "timeout" : "cancelled",
        "execution",
        timeoutMs === undefined ? {} : { timeout_ms: timeoutMs },
      );
    } catch (error) {
      if (error instanceof ExecutionRuntimeError) throw error;
      if (termination) {
        throw new ExecutionRuntimeError(
          termination === "timed_out" ? "Operator execution timed out" : "Operator execution was cancelled",
          termination === "timed_out" ? "timeout" : "cancelled",
          "execution",
          timeoutMs === undefined ? {} : { timeout_ms: timeoutMs },
          { cause: error },
        );
      }
      throw new ExecutionRuntimeError(
        error instanceof Error ? error.message : "Operator adapter crashed",
        "operator_crashed",
        "execution",
        {},
        { cause: error },
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      externalSignal?.removeEventListener("abort", cancel);
    }
  }

  private async validateCandidate(
    run: ExecutionRun,
    inputs: View[],
    candidate: unknown,
    explicitPolicy?: ViewPolicy,
  ) {
    let envelope: OperatorCandidateEnvelope;
    try {
      envelope = parseOperatorCandidateEnvelope(candidate);
    } catch (error) {
      throw new ExecutionRuntimeError("Operator candidate envelope is invalid", "candidate_invalid", "validation", {}, { cause: error });
    }
    const cardinality = run.frozen.transformation.output.cardinality;
    if (envelope.outputs.length < cardinality.min || (cardinality.max !== undefined && envelope.outputs.length > cardinality.max)) {
      throw new ExecutionRuntimeError(
        "Operator candidate violates output cardinality",
        "candidate_invalid",
        "validation",
        { count: envelope.outputs.length, min: cardinality.min, max: cardinality.max ?? null },
      );
    }
    const inherited = inheritedPolicy(inputs, explicitPolicy);
    const expectedInputs = sortedRefs(inputs.map(view => exactViewRef(view)));
    const seen = new Set<string>();
    const commits = [];
    for (const output of envelope.outputs) {
      let draft: ViewDraft;
      try {
        draft = parseViewDraft(output.draft);
      } catch (error) {
        throw new ExecutionRuntimeError("Candidate View fails envelope or strict Schema validation", "candidate_invalid", "validation", {}, { cause: error });
      }
      if (seen.has(draft.id)) {
        throw new ExecutionRuntimeError(`Candidate repeats View identity ${draft.id}`, "candidate_invalid", "validation");
      }
      seen.add(draft.id);
      if (draft.role !== "derived" || canonicalJson(draft.schema) !== canonicalJson(run.frozen.transformation.output.schema)) {
        throw new ExecutionRuntimeError(
          `Candidate View ${draft.id} does not satisfy the frozen output Schema`,
          "schema_mismatch",
          "validation",
          { view_id: draft.id },
        );
      }
      if (!policyIsAtLeastAsStrict(draft.policy, inherited)) {
        throw new ExecutionRuntimeError(
          `Candidate View ${draft.id} weakens inherited input policy`,
          "policy_mismatch",
          "validation",
          { view_id: draft.id },
        );
      }
      if (
        draft.provenance.operator_run_id !== run.id
        || draft.provenance.trace_id !== run.trace_id
        || canonicalJson(sortedRefs(draft.provenance.inputs)) !== canonicalJson(expectedInputs)
      ) {
        throw new ExecutionRuntimeError(
          `Candidate View ${draft.id} does not preserve frozen Run provenance`,
          "provenance_mismatch",
          "validation",
          { view_id: draft.id },
        );
      }
      const latest = await this.views.getLatest(draft.id);
      const actualRevision = latest?.revision ?? 0;
      if (actualRevision !== output.expected_revision) {
        throw new ExecutionRuntimeError(
          `Candidate base for ${draft.id} is stale: expected ${output.expected_revision}, current ${actualRevision}`,
          "stale_base",
          "commit",
          { view_id: draft.id, expected_revision: output.expected_revision, actual_revision: actualRevision },
        );
      }
      commits.push({
        draft,
        expected_revision: output.expected_revision,
        ...(output.idempotency_key ? { idempotency_key: output.idempotency_key } : {}),
      });
    }
    return commits;
  }

  private async failRun(
    run: ExecutionRun,
    attempt: ExecutionAttempt | undefined,
    inputs: View[],
    explicitFailurePolicy: ViewPolicy | undefined,
    error: ExecutionRuntimeError,
    candidate: unknown,
    cost: number,
    status: Extract<ExecutionRunStatus, "failed" | "cancelled" | "timed_out">,
  ): Promise<ExecutionResult> {
    const completedAt = this.now();
    const completedAttempt = attempt
      ? finishAttempt(attempt, status === "timed_out" ? "timed_out" : status === "cancelled" ? "cancelled" : "failed", completedAt, cost, asRunError(error))
      : undefined;
    const evidence = buildFailureEvidence({
      run,
      ...(attempt ? { attempt } : {}),
      inputs,
      policy: inheritedPolicy(inputs, explicitFailurePolicy),
      error: asRunError(error),
      candidate,
      status,
      created_at: completedAt,
    });
    try {
      const committed = await this.runs.commitFailure({
        run_id: run.id,
        attempt: completedAttempt,
        completed_at: completedAt,
        status,
        cost_usd: cost,
        error: asRunError(error),
        artifacts: evidence.artifacts,
        failure: {
          draft: evidence.failure,
          expected_revision: 0,
          idempotency_key: `execution-failure:${run.id}`,
        },
        terminal_event: {
          run_id: run.id,
          ...(attempt ? { attempt_id: attempt.id } : {}),
          type: `run.${status}`,
          occurred_at: completedAt,
          payload: { code: error.code, stage: error.stage, cost_usd: cost },
        },
        ...(run.frozen.cascade ? {
          cascade: {
            ...run.frozen.cascade,
            aggregate: {
              ...run.frozen.cascade.aggregate,
              cost_usd: run.frozen.cascade.aggregate.cost_usd + cost,
            },
            disposition: "terminal" as const,
            terminal: run.frozen.cascade.disposition === "terminal"
              ? run.frozen.cascade.terminal
              : {
                  code: error.code,
                  message: error.message,
                  stage: error.stage,
                },
          },
        } : {}),
      });
      const storedRun = await this.mustGetRun(run.id);
      const failure = committed.results.find(result => result.view.id === evidence.failure.id)?.view;
      if (!failure) throw new Error("Failure commit returned no View");
      return { run: storedRun, outputs: [], failure };
    } catch (failureError) {
      throw new ExecutionRuntimeError(
        `Run ${run.id} failed and its Failure View could not be committed`,
        "failure_commit_failed",
        "commit",
        {
          original_code: error.code,
          failure_commit_error: failureError instanceof Error ? failureError.message : String(failureError),
          ...(failureError instanceof ViewRepositoryError ? {
            failure_commit_phase: failureError.details.phase ?? null,
            failure_commit_repository_code: failureError.code,
          } : {}),
        },
        { cause: new AggregateError([error, failureError], "Execution and Failure View commit both failed") },
      );
    }
  }

  private async emit(
    run: ExecutionRun,
    attempt: ExecutionAttempt | undefined,
    type: string,
    payload: JsonObject,
    occurredAt = this.now(),
  ): Promise<void> {
    await this.runs.appendTrace({
      run_id: run.id,
      ...(attempt ? { attempt_id: attempt.id } : {}),
      type,
      occurred_at: occurredAt,
      payload,
    });
  }

  private async mustGetRun(runId: string): Promise<ExecutionRun> {
    const run = await this.runs.getRun(runId);
    if (!run) {
      throw new ExecutionRuntimeError(`Execution Run ${runId} disappeared`, "replay_incomplete", "commit", { run_id: runId });
    }
    return run;
  }

  private async resultFromStoredRun(run: ExecutionRun): Promise<ExecutionResult> {
    if (run.status === "ready" || run.status === "running") {
      throw new ExecutionRuntimeError(
        `Idempotent Run ${run.id} is already ${run.status}`,
        "run_already_active",
        "execution",
        { run_id: run.id, status: run.status },
      );
    }
    const outputs: View[] = [];
    for (const ref of run.output_views) {
      const view = await this.views.get(ref);
      if (!view) {
        throw new ExecutionRuntimeError(
          `Idempotent Run ${run.id} lost output ${viewRevisionKey(ref)}`,
          "replay_incomplete",
          "commit",
          { output: ref },
        );
      }
      outputs.push(view);
    }
    const failure = run.failure_view ? await this.views.get(run.failure_view) : undefined;
    if (run.failure_view && !failure) {
      throw new ExecutionRuntimeError(
        `Idempotent Run ${run.id} lost Failure View ${viewRevisionKey(run.failure_view)}`,
        "replay_incomplete",
        "commit",
        { failure_view: run.failure_view },
      );
    }
    return { run, outputs, ...(failure ? { failure } : {}) };
  }
}

function matchesSelector(view: View, selector: ViewSelectorSnapshot): boolean {
  const query = selector.query;
  if (query.schema_names.length > 0 && !query.schema_names.includes(view.schema.name)) return false;
  if (query.roles.length > 0 && !query.roles.includes(view.role)) return false;
  if (query.text && !canonicalJson(view).toLocaleLowerCase().includes(query.text.toLocaleLowerCase())) return false;
  const observedAt = Date.parse(view.time.observed_at ?? view.time.created_at);
  if (query.observed_from && observedAt < Date.parse(query.observed_from)) return false;
  if (query.observed_to && observedAt > Date.parse(query.observed_to)) return false;
  for (const [path, expected] of Object.entries(query.where)) {
    if (canonicalJson(readPath(view, path)) !== canonicalJson(expected)) return false;
  }
  return true;
}

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[part];
  }, value);
}

function uniqueByRef(views: View[]): View[] {
  const byRef = new Map<string, View>();
  for (const view of views) byRef.set(viewRevisionKey(exactViewRef(view)), view);
  return [...byRef.values()].sort((left, right) => viewRevisionKey(exactViewRef(left)).localeCompare(viewRevisionKey(exactViewRef(right))));
}

function sortedRefs(refs: ExactViewRef[]): ExactViewRef[] {
  return [...refs].sort((left, right) => viewRevisionKey(left).localeCompare(viewRevisionKey(right)));
}

function finishAttempt(
  attempt: ExecutionAttempt,
  status: Exclude<ExecutionAttempt["status"], "running">,
  completedAt: string,
  cost: number,
  error?: ExecutionRunError,
): ExecutionAttempt {
  return ExecutionAttemptSchema.parse({
    ...attempt,
    status,
    completed_at: completedAt,
    duration_ms: Math.max(0, Date.parse(completedAt) - Date.parse(attempt.started_at)),
    cost_usd: cost,
    ...(error ? { error } : {}),
  });
}

function inheritedPolicy(inputs: View[], explicit?: ViewPolicy): ViewPolicy {
  if (inputs.length > 0) return inheritStrictestViewPolicy(inputs.map(view => view.policy));
  if (explicit) return explicit;
  throw new ExecutionRuntimeError(
    "A zero-input Transformation requires an explicit output/failure policy",
    "policy_mismatch",
    "validation",
  );
}

function resolveOutputPolicy(outputPolicy?: ViewPolicy, legacyFailurePolicy?: ViewPolicy): ViewPolicy | undefined {
  if (outputPolicy && legacyFailurePolicy && canonicalJson(outputPolicy) !== canonicalJson(legacyFailurePolicy)) {
    throw new ExecutionRuntimeError(
      "output_policy and legacy failure_policy must describe the same View policy",
      "policy_mismatch",
      "validation",
    );
  }
  return outputPolicy ?? legacyFailurePolicy;
}

function frozenOutputPolicy(run: ExecutionRun): ViewPolicy | undefined {
  return run.frozen.output_policy ?? run.frozen.failure_policy;
}

function policyIsAtLeastAsStrict(candidate: ViewPolicy, inherited: ViewPolicy): boolean {
  const visibility = { public: 0, shared: 1, private: 2 } as const;
  const privacy = { public: 0, private: 1, sensitive: 2 } as const;
  const retention = { archive: 0, normal: 1, session: 2, do_not_store: 3 } as const;
  return candidate.owner === inherited.owner
    && visibility[candidate.visibility] >= visibility[inherited.visibility]
    && privacy[candidate.privacy] >= privacy[inherited.privacy]
    && retention[candidate.retention] >= retention[inherited.retention]
    && (!candidate.allow_external_model || inherited.allow_external_model)
    && (!candidate.allow_embedding || inherited.allow_embedding)
    && (candidate.allow_local_search === false || inherited.allow_local_search !== false)
    && inherited.labels.every(label => candidate.labels.includes(label));
}

function asRunError(error: ExecutionRuntimeError): ExecutionRunError {
  return {
    code: error.code,
    message: error.message,
    stage: error.stage,
    details: error.details,
  };
}

function normalizeRuntimeError(error: unknown, signalAborted: boolean): ExecutionRuntimeError {
  if (error instanceof ExecutionRuntimeError) return error;
  if (signalAborted) return new ExecutionRuntimeError("Operator execution was cancelled", "cancelled", "execution");
  if (error instanceof ViewRepositoryError) {
    const stale = error.code === "conflict";
    return new ExecutionRuntimeError(
      error.message,
      stale ? "stale_base" : "commit_failed",
      "commit",
      {
        repository_code: error.code,
        operation: error.details.operation,
        phase: error.details.phase ?? null,
        transaction_id: error.details.transaction_id ?? null,
      },
      { cause: error },
    );
  }
  return new ExecutionRuntimeError(
    error instanceof Error ? error.message : "Execution failed",
    "operator_crashed",
    "execution",
    {},
    { cause: error },
  );
}

function assertIdempotentExecutionRequest(run: ExecutionRun, input: StartExecutionInput): void {
  if (!input.idempotency_key) throw new TypeError("Idempotent execution comparison requires an idempotency key");
  const expected = canonicalJson({
    run_id: input.run_id,
    correlation_id: input.correlation_id,
    transformation: input.transformation,
    access_policy: input.access_policy,
    access_use: input.access_use,
    invocation_inputs: input.invocation_inputs ?? null,
    runtime_override: input.runtime_override ?? null,
    repair: input.repair_context ?? null,
    output_policy: resolveOutputPolicy(input.output_policy, input.failure_policy) ?? null,
    previous_attempt_id: input.previous_attempt_id ?? null,
    cascade: comparableCascade(input.cascade),
    pre_execution_failure: input.pre_execution_failure ?? null,
  });
  const actual = canonicalJson({
    run_id: run.id,
    correlation_id: run.correlation_id,
    transformation: run.frozen.transformation,
    access_policy: run.frozen.access_policy,
    access_use: run.frozen.access_use,
    invocation_inputs: run.frozen.invocation_inputs ?? null,
    runtime_override: run.frozen.runtime_override ?? null,
    repair: run.frozen.repair ?? null,
    output_policy: run.frozen.output_policy ?? run.frozen.failure_policy ?? null,
    previous_attempt_id: run.frozen.previous_attempt_id ?? null,
    cascade: comparableCascade(run.frozen.cascade),
    pre_execution_failure: run.frozen.pre_execution_failure ?? null,
  });
  if (actual !== expected) {
    throw new ExecutionRuntimeError(
      `Execution idempotency key ${input.idempotency_key} was reused with a different request`,
      "idempotency_conflict",
      "validation",
      { idempotency_key: input.idempotency_key, existing_run_id: run.id, requested_run_id: input.run_id },
    );
  }
}

function comparableCascade(cascade: StartExecutionInput["cascade"] | ExecutionRun["frozen"]["cascade"]): unknown {
  if (!cascade) return null;
  const { operator: _operator, ...target } = cascade.target;
  return { ...cascade, target };
}
