import { createHash } from "node:crypto";
import {
  ViewDraftSchema,
  ViewRepositoryError,
  canonicalJson,
  exactViewRef,
  type ExactViewRef,
  type JsonObject,
  type View,
  type ViewPolicy,
  type ViewRepository,
} from "@info/view";
import {
  TransformationRepositoryError,
  exactTransformationRef,
  type TransformationRepository,
} from "@info/transformation";
import { ExecutionRuntimeError, inheritStrictestViewPolicy, type ExecutionResult, type ExecutionRuntime } from "@info/execution";
import { ViewPackageCatalog, ViewPackageError } from "@info/view-package";
import {
  AuthoringAgentCandidateSchema,
  AuthoringAgentOutputJsonSchema,
  AuthoringApplyInputSchema,
  AuthoringDecisionInputSchema,
  AuthoringDecisionValueSchema,
  AuthoringError,
  AuthoringInspectInputSchema,
  AuthoringProposalValueSchema,
  AuthoringProposeInputSchema,
  AuthoringReceiptValueSchema,
  AuthoringRejectInputSchema,
  AuthoringRequestInputSchema,
  AuthoringRequestValueSchema,
  AuthoringTraceEventSchema,
  lifecycleDraft,
  lifecycleValue,
  proposalDigest,
  type AuthoringAgentCandidate,
  type AuthoringApplyInput,
  type AuthoringDecisionInput,
  type AuthoringObserver,
  type AuthoringProposalAgentPort,
  type AuthoringProposalArtifact,
  type AuthoringReceiptValue,
  type AuthoringRejectInput,
} from "./contracts.js";

export type AuthoringServiceDependencies = {
  views: ViewRepository;
  transformations: TransformationRepository;
  execution: Pick<ExecutionRuntime, "execute">;
  packages: ViewPackageCatalog;
  agent: AuthoringProposalAgentPort;
  observer: AuthoringObserver;
  now?: () => string;
};

export class AuthoringService {
  private readonly now: () => string;

  constructor(private readonly dependencies: AuthoringServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async request(inputValue: unknown, actor: string): Promise<View> {
    const input = AuthoringRequestInputSchema.parse(inputValue);
    if (input.policy.owner !== actor) {
      throw new AuthoringError("Authoring Request policy owner must be the requesting actor", "authoring_owner_mismatch", {
        actor,
        owner: input.policy.owner,
      });
    }
    const operationDigest = digest({ operation: "request", input, actor });
    const replay = await this.replayView(input.view_id, input.expected_revision + 1, operationDigest, "metaflow.authoring.request");
    if (replay) return replay;
    const sources = await this.requireViews(input.source_views, "authoring_source_missing");
    if (sources.length > 0) {
      const inherited = inheritStrictestViewPolicy([...sources.map(source => source.policy), input.policy]);
      if (canonicalJson(normalizePolicyLabels(inherited)) !== canonicalJson(normalizePolicyLabels(input.policy))) {
        throw new AuthoringError("Authoring Request policy weakens one or more source View policies", "authoring_policy_weakening", {
          source_views: input.source_views,
        });
      }
    }
    const value = AuthoringRequestValueSchema.parse({
      contract_version: 1,
      artifact_kind: input.artifact_kind,
      prompt: input.prompt,
      source_views: input.source_views,
      requested_by: actor,
      trace_id: input.trace_id,
    });
    const result = await this.dependencies.views.commit({
      draft: lifecycleDraft({
        id: input.view_id,
        schema_name: "metaflow.authoring.request",
        name: `Authoring Request: ${input.artifact_kind}`,
        purpose: "Freeze a natural-language request before proposal generation",
        value,
        policy: input.policy,
        actor,
        created_at: input.created_at,
        inputs: input.source_views,
        relations: input.source_views.map(target => ({ type: "authoring_source", target, metadata: {} })),
        metadata: { authoring_operation_digest: operationDigest },
      }),
      expected_revision: input.expected_revision,
      idempotency_key: input.idempotency_key,
    }, commitContext(input.trace_id, input.created_at, "authoring_request"));
    const ref = exactViewRef(result.view);
    await this.observe(value.trace_id, "authoring.requested", actor, [ref], {});
    return result.view;
  }

  async propose(inputValue: unknown, actor: string, signal = new AbortController().signal): Promise<View> {
    const input = AuthoringProposeInputSchema.parse(inputValue);
    const request = await this.requireLifecycle(input.request, "metaflow.authoring.request");
    const requestValue = AuthoringRequestValueSchema.parse(lifecycleValue(request));
    this.requireOwner(request.policy, actor);
    const operationDigest = digest({ operation: "propose", input, actor });
    const failureOperationDigest = digest({ operation: "proposal_failure", input, actor });
    const replay = await this.replayView(input.proposal_view_id, input.expected_revision + 1, operationDigest, "metaflow.authoring.proposal");
    if (replay) return replay;
    const failureReplay = await this.replayView(input.failure_receipt_view_id, 1, failureOperationDigest, "metaflow.authoring.receipt");
    if (failureReplay) throw replayedFailure(failureReplay);
    try {
      const untrusted = await this.dependencies.agent.propose({
        request: requestValue,
        request_ref: input.request,
        policy: request.policy,
        output_schema: AuthoringAgentOutputJsonSchema,
        ...(input.runtime ? { runtime: input.runtime } : {}),
      }, { signal });
      const byteLength = jsonByteLength(untrusted);
      if (byteLength > 1_000_000) {
        throw new AuthoringError("Agent proposal exceeds the bounded authoring candidate size", "authoring_candidate_too_large", {
          byte_length: byteLength,
          max_byte_length: 1_000_000,
        });
      }
      const candidateResult = AuthoringAgentCandidateSchema.safeParse(untrusted);
      if (!candidateResult.success) {
        throw new AuthoringError("Agent proposal failed the declarative authoring contract", "authoring_candidate_invalid", {
          issue_count: candidateResult.error.issues.length,
        }, { cause: candidateResult.error });
      }
      if (candidateResult.data.kind !== requestValue.artifact_kind) {
        throw new AuthoringError("Agent proposal kind does not match the frozen Request", "authoring_kind_mismatch", {
          requested: requestValue.artifact_kind,
          proposed: candidateResult.data.kind,
        });
      }
      await this.validateCandidate(candidateResult.data, requestValue, actor, input);
      const artifact = this.freezeArtifact(candidateResult.data, input.created_at);
      const value = AuthoringProposalValueSchema.parse({
        contract_version: 1,
        request: input.request,
        artifact,
        artifact_digest: proposalDigest(artifact),
        proposed_by: actor,
        trace_id: requestValue.trace_id,
      });
      const committed = await this.dependencies.views.commit({
        draft: lifecycleDraft({
          id: input.proposal_view_id,
          schema_name: "metaflow.authoring.proposal",
          name: `Authoring Proposal: ${requestValue.artifact_kind}`,
          purpose: "Freeze one declarative Agent proposal for exact human review",
          value,
          policy: request.policy,
          actor,
          created_at: input.created_at,
          inputs: [input.request],
          relations: [{ type: "proposes_for", target: input.request, metadata: { artifact_digest: value.artifact_digest } }],
          metadata: { authoring_operation_digest: operationDigest },
        }),
        expected_revision: input.expected_revision,
        idempotency_key: input.idempotency_key,
      }, commitContext(requestValue.trace_id, input.created_at, "authoring_proposal"));
      await this.observe(requestValue.trace_id, "authoring.proposed", actor, [input.request, exactViewRef(committed.view)], {
        artifact_digest: value.artifact_digest,
      });
      return committed.view;
    } catch (cause) {
      if (await this.dependencies.views.getLatest(input.proposal_view_id)) throw cause;
      const receipt = await this.commitReceipt({
        view_id: input.failure_receipt_view_id,
        expected_revision: 0,
        idempotency_key: `${input.idempotency_key}:failure`,
        policy: request.policy,
        actor,
        created_at: input.created_at,
        operation_digest: failureOperationDigest,
        value: {
          contract_version: 1,
          request: input.request,
          status: "failed",
          error: safeError(cause),
          completed_by: actor,
          trace_id: requestValue.trace_id,
        },
      });
      await this.observe(requestValue.trace_id, "authoring.failed", actor, [input.request, exactViewRef(receipt)], {
        stage: "proposal",
        error_code: safeError(cause).code,
      }, cause);
      throw withReceipt(cause, exactViewRef(receipt));
    }
  }

  async approve(inputValue: unknown, actor: string): Promise<View> {
    return this.decide(inputValue, actor, "approved");
  }

  async reject(inputValue: unknown, actor: string): Promise<{ decision: View; receipt: View }> {
    const input = AuthoringRejectInputSchema.parse(inputValue);
    const { proposal, proposalValue } = await this.validateDecisionInput(input, actor);
    const operationDigest = digest({ operation: "reject", input, actor });
    const replay = await this.replayView(input.decision_view_id, input.expected_revision + 1, operationDigest, "metaflow.authoring.decision");
    if (replay) {
      const receipt = await this.replayView(
        input.receipt_view_id,
        1,
        digest({ operation: "reject_receipt", input, actor }),
        "metaflow.authoring.receipt",
      );
      if (!receipt) throw new AuthoringError("Rejected Decision replay is missing its atomic Receipt", "authoring_receipt_missing");
      return { decision: replay, receipt };
    }
    const request = await this.requireLifecycle(proposalValue.request, "metaflow.authoring.request");
    const value = decisionValue(input, "rejected", actor, proposalValue.trace_id);
    const decisionRef = { view_id: input.decision_view_id, revision: input.expected_revision + 1 };
    const receiptValue = AuthoringReceiptValueSchema.parse({
      contract_version: 1,
      request: proposalValue.request,
      proposal: input.proposal,
      decision: decisionRef,
      status: "rejected",
      completed_by: actor,
      trace_id: proposalValue.trace_id,
    });
    const result = await this.dependencies.views.commitBatch([
      {
        draft: this.decisionDraft(input, value, proposal.policy, actor, operationDigest),
        expected_revision: input.expected_revision,
        idempotency_key: input.idempotency_key,
      },
      {
        draft: receiptDraft(input.receipt_view_id, receiptValue, request.policy, actor, input.created_at, digest({ operation: "reject_receipt", input, actor })),
        expected_revision: 0,
        idempotency_key: `${input.idempotency_key}:receipt`,
      },
    ], commitContext(proposalValue.trace_id, input.created_at, "authoring_rejection"));
    const decision = result.results[0]!.view;
    const receipt = result.results[1]!.view;
    await this.observe(proposalValue.trace_id, "authoring.rejected", actor, [input.proposal, exactViewRef(decision), exactViewRef(receipt)], {});
    return { decision, receipt };
  }

  async apply(inputValue: unknown, actor: string, signal = new AbortController().signal): Promise<View> {
    const input = AuthoringApplyInputSchema.parse(inputValue);
    const decision = await this.requireLifecycle(input.decision, "metaflow.authoring.decision");
    const decisionValueParsed = AuthoringDecisionValueSchema.parse(lifecycleValue(decision));
    this.requireOwner(decision.policy, actor);
    const operationDigest = digest({ operation: "apply", input, actor });
    const replay = await this.replayView(input.receipt_view_id, input.expected_revision + 1, operationDigest, "metaflow.authoring.receipt");
    if (replay) {
      const replayValue = AuthoringReceiptValueSchema.parse(lifecycleValue(replay));
      if (replayValue.status === "failed") throw replayedFailure(replay);
      return replay;
    }
    if (decisionValueParsed.decision !== "approved") {
      throw new AuthoringError("Only an approved Proposal can be applied", "authoring_not_approved", { decision: input.decision });
    }
    const proposal = await this.requireLifecycle(decisionValueParsed.proposal, "metaflow.authoring.proposal");
    const proposalValue = AuthoringProposalValueSchema.parse(lifecycleValue(proposal));
    if (proposalValue.artifact_digest !== decisionValueParsed.proposal_digest) {
      throw new AuthoringError("Approval digest no longer matches the exact Proposal", "authoring_digest_mismatch", {
        proposal: decisionValueParsed.proposal,
      });
    }
    const request = await this.requireLifecycle(proposalValue.request, "metaflow.authoring.request");
    const requestValue = AuthoringRequestValueSchema.parse(lifecycleValue(request));
    this.validateApplyIdentities(proposalValue.artifact, input.receipt_view_id, [request, proposal, decision]);
    let target: NonNullable<AuthoringReceiptValue["target"]>;
    try {
      target = await this.applyArtifact(proposalValue.artifact, request.policy, actor, input, proposalValue, requestValue.source_views, signal);
    } catch (cause) {
      const value = AuthoringReceiptValueSchema.parse({
        contract_version: 1,
        request: proposalValue.request,
        proposal: decisionValueParsed.proposal,
        decision: input.decision,
        status: "failed",
        error: safeError(cause),
        completed_by: actor,
        trace_id: proposalValue.trace_id,
      });
      const receipt = await this.commitReceipt({
        view_id: input.receipt_view_id,
        expected_revision: input.expected_revision,
        idempotency_key: `${input.idempotency_key}:failure`,
        policy: request.policy,
        actor,
        value,
        created_at: input.created_at,
        operation_digest: operationDigest,
      });
      await this.observe(proposalValue.trace_id, "authoring.failed", actor, [input.decision, exactViewRef(receipt)], {
        stage: "apply",
        error_code: value.error!.code,
      }, cause);
      throw withReceipt(cause, exactViewRef(receipt));
    }

    const value = AuthoringReceiptValueSchema.parse({
      contract_version: 1,
      request: proposalValue.request,
      proposal: decisionValueParsed.proposal,
      decision: input.decision,
      status: "applied",
      target,
      completed_by: actor,
      trace_id: proposalValue.trace_id,
    });
    let receipt: View;
    try {
      receipt = await this.commitReceipt({
        view_id: input.receipt_view_id,
        expected_revision: input.expected_revision,
        idempotency_key: input.idempotency_key,
        policy: request.policy,
        actor,
        value,
        created_at: input.created_at,
        operation_digest: operationDigest,
      });
    } catch (cause) {
      throw new AuthoringError(
        "Authored target was applied but its Receipt did not commit; retry the exact Apply request",
        "authoring_receipt_commit_failed",
        { target },
        { cause },
      );
    }
    await this.observe(proposalValue.trace_id, "authoring.applied", actor, [proposalValue.request, decisionValueParsed.proposal, input.decision, exactViewRef(receipt)], {
      target_kind: target.kind,
    });
    return receipt;
  }

  async inspect(inputValue: unknown): Promise<{ view: View; lifecycle: ReturnType<typeof lifecycleValue> }> {
    const input = AuthoringInspectInputSchema.parse(inputValue);
    const view = await this.dependencies.views.get(input.ref);
    if (!view) throw new AuthoringError("Exact authoring View does not exist", "authoring_view_not_found", { ref: input.ref });
    return { view, lifecycle: lifecycleValue(view) };
  }

  private async decide(inputValue: unknown, actor: string, decision: "approved"): Promise<View> {
    const input = AuthoringDecisionInputSchema.parse(inputValue);
    const { proposal, proposalValue } = await this.validateDecisionInput(input, actor);
    const operationDigest = digest({ operation: decision, input, actor });
    const replay = await this.replayView(input.decision_view_id, input.expected_revision + 1, operationDigest, "metaflow.authoring.decision");
    if (replay) return replay;
    const value = decisionValue(input, decision, actor, proposalValue.trace_id);
    const result = await this.dependencies.views.commit({
      draft: this.decisionDraft(input, value, proposal.policy, actor, operationDigest),
      expected_revision: input.expected_revision,
      idempotency_key: input.idempotency_key,
    }, commitContext(proposalValue.trace_id, input.created_at, "authoring_approval"));
    await this.observe(proposalValue.trace_id, "authoring.approved", actor, [input.proposal, exactViewRef(result.view)], {});
    return result.view;
  }

  private async validateDecisionInput(input: AuthoringDecisionInput, actor: string) {
    const proposal = await this.requireLifecycle(input.proposal, "metaflow.authoring.proposal");
    const proposalValue = AuthoringProposalValueSchema.parse(lifecycleValue(proposal));
    this.requireOwner(proposal.policy, actor);
    if (proposalValue.artifact_digest !== input.proposal_digest) {
      throw new AuthoringError("Decision must bind the exact Proposal digest", "authoring_digest_mismatch", {
        proposal: input.proposal,
        expected_digest: proposalValue.artifact_digest,
        supplied_digest: input.proposal_digest,
      });
    }
    return { proposal, proposalValue };
  }

  private decisionDraft(input: AuthoringDecisionInput | AuthoringRejectInput, value: ReturnType<typeof decisionValue>, policy: ViewPolicy, actor: string, operationDigest: string) {
    return lifecycleDraft({
      id: input.decision_view_id,
      schema_name: "metaflow.authoring.decision",
      name: `Authoring Decision: ${value.decision}`,
      purpose: "Bind one human decision to an exact Proposal revision and digest",
      value,
      policy,
      actor,
      created_at: input.created_at,
      inputs: [input.proposal],
      relations: [{ type: value.decision === "approved" ? "approves" : "rejects", target: input.proposal, metadata: { proposal_digest: value.proposal_digest } }],
      metadata: { authoring_operation_digest: operationDigest },
    });
  }

  private freezeArtifact(candidate: AuthoringAgentCandidate, createdAt: string): AuthoringProposalArtifact {
    if (candidate.kind === "view") return { ...candidate, view: { ...candidate.view, created_at: createdAt } };
    if (candidate.kind !== "view_package") return candidate;
    const registered = this.dependencies.packages.get(candidate.package.id, candidate.package.version);
    return {
      kind: "view_package",
      package: {
        ...candidate.package,
        manifest_digest: digest(registered.manifest),
      },
    };
  }

  private async validateCandidate(
    candidate: AuthoringAgentCandidate,
    request: { source_views: ExactViewRef[] },
    actor: string,
    proposalInput: { request: ExactViewRef; proposal_view_id: string; failure_receipt_view_id: string },
  ): Promise<void> {
    if (candidate.kind === "transformation") {
      assertNoExecutablePayload(candidate.transformation.operator.configuration, ["transformation", "operator", "configuration"]);
      assertNoExecutablePayload(candidate.transformation.metadata, ["transformation", "metadata"]);
      if (candidate.transformation.trigger) {
        assertNoExecutablePayload(candidate.transformation.trigger.configuration, ["transformation", "trigger", "configuration"]);
      }
      if (candidate.transformation.policy) {
        assertNoExecutablePayload(candidate.transformation.policy.configuration, ["transformation", "policy", "configuration"]);
      }
      if (candidate.transformation.budget) {
        assertNoExecutablePayload(candidate.transformation.budget.extensions, ["transformation", "budget", "extensions"]);
      }
    }
    if (candidate.kind !== "view") return;
    if ([proposalInput.request.view_id, proposalInput.proposal_view_id, proposalInput.failure_receipt_view_id].includes(candidate.view.id)) {
      throw new AuthoringError("Authored target cannot reuse an authoring lifecycle View identity", "authoring_target_identity_conflict", {
        target_view_id: candidate.view.id,
      });
    }
    const approvedSources = new Set(request.source_views.map(refKey));
    for (const relation of candidate.view.relations) {
      if (!approvedSources.has(refKey(relation.target))) {
        throw new AuthoringError("Authored View relation target was not frozen in the Request sources", "authoring_relation_not_approved", {
          target: relation.target,
        });
      }
    }
    if (candidate.view.expected_revision === 0) return;
    const baseRef = { view_id: candidate.view.id, revision: candidate.view.expected_revision };
    if (!approvedSources.has(refKey(baseRef))) {
      throw new AuthoringError("Authored View revision base must be an exact Request source", "authoring_base_not_approved", { base: baseRef });
    }
    const base = await this.dependencies.views.get(baseRef);
    if (!base) throw new AuthoringError("Authored View revision base does not exist", "authoring_view_not_found", { ref: baseRef });
    this.requireOwner(base.policy, actor);
  }

  private validateApplyIdentities(artifact: AuthoringProposalArtifact, receiptViewId: string, lifecycle: View[]): void {
    const lifecycleIds = lifecycle.map(view => view.id);
    if (lifecycleIds.includes(receiptViewId)) {
      throw new AuthoringError("Apply Receipt cannot reuse a Request, Proposal, or Decision identity", "authoring_lifecycle_identity_conflict", {
        receipt_view_id: receiptViewId,
      });
    }
    if (artifact.kind === "view" && [...lifecycleIds, receiptViewId].includes(artifact.view.id)) {
      throw new AuthoringError("Authored target cannot reuse an authoring lifecycle View identity", "authoring_target_identity_conflict", {
        target_view_id: artifact.view.id,
      });
    }
  }

  private async applyArtifact(
    artifact: AuthoringProposalArtifact,
    requestPolicy: ViewPolicy,
    actor: string,
    input: AuthoringApplyInput,
    proposal: { request: ExactViewRef; trace_id: string },
    sourceViews: ExactViewRef[],
    signal: AbortSignal,
  ) {
    if (artifact.kind === "view") {
      const { expected_revision: expectedRevision, created_at: createdAt, ...authoredView } = artifact.view;
      const draft = ViewDraftSchema.parse({
        ...authoredView,
        aliases: artifact.view.aliases,
        role: "derived",
        time: { created_at: createdAt },
        provenance: { inputs: [proposal.request, ...sourceViews], actor, trace_id: proposal.trace_id },
        policy: requestPolicy,
      });
      const result = await this.dependencies.views.commit({
        draft,
        expected_revision: expectedRevision,
        idempotency_key: `${input.idempotency_key}:target`,
      }, commitContext(proposal.trace_id, this.now(), "authoring_apply_view"));
      return { kind: "view" as const, ref: exactViewRef(result.view) };
    }
    if (artifact.kind === "transformation") {
      const committed = await this.dependencies.transformations.commit({
        transformation: artifact.transformation,
        expected_revision: artifact.expected_revision,
        idempotency_key: `${input.idempotency_key}:target`,
      });
      let execution: ExecutionResult | undefined;
      if (artifact.execute) {
        execution = await this.dependencies.execution.execute({
          ...artifact.execute,
          transformation: committed.transformation,
        }, { signal });
      }
      return {
        kind: "transformation" as const,
        ref: exactTransformationRef(committed.transformation),
        ...(execution ? { run_id: execution.run.id, run_status: execution.run.status } : {}),
      };
    }
    const registered = this.dependencies.packages.get(artifact.package.id, artifact.package.version);
    const currentDigest = digest(registered.manifest);
    if (currentDigest !== artifact.package.manifest_digest) {
      throw new AuthoringError("Registered View Package no longer matches the approved manifest digest", "authoring_package_digest_mismatch", {
        package_id: artifact.package.id,
        package_version: artifact.package.version,
      });
    }
    return { kind: "view_package" as const, ...artifact.package };
  }

  private async commitReceipt(input: {
    view_id: string;
    expected_revision: number;
    idempotency_key: string;
    policy: ViewPolicy;
    actor: string;
    value: AuthoringReceiptValue;
    created_at: string;
    operation_digest: string;
  }): Promise<View> {
    const result = await this.dependencies.views.commit({
      draft: receiptDraft(input.view_id, input.value, input.policy, input.actor, input.created_at, input.operation_digest),
      expected_revision: input.expected_revision,
      idempotency_key: input.idempotency_key,
    }, commitContext(input.value.trace_id, input.created_at, "authoring_receipt"));
    return result.view;
  }

  private async requireLifecycle(ref: ExactViewRef, schemaName: string): Promise<View> {
    const view = await this.dependencies.views.get(ref);
    if (!view) throw new AuthoringError("Exact authoring View does not exist", "authoring_view_not_found", { ref });
    if (view.schema.name !== schemaName || view.schema.version !== 1) {
      throw new AuthoringError("Exact View has the wrong authoring lifecycle Schema", "invalid_lifecycle_view", {
        ref,
        expected_schema: schemaName,
        actual_schema: view.schema.name,
      });
    }
    lifecycleValue(view);
    return view;
  }

  private async requireViews(refs: ExactViewRef[], code: string): Promise<View[]> {
    const views: View[] = [];
    for (const ref of refs) {
      const view = await this.dependencies.views.get(ref);
      if (!view) throw new AuthoringError("Exact source View does not exist", code, { ref });
      views.push(view);
    }
    return views;
  }

  private requireOwner(policy: ViewPolicy, actor: string): void {
    if (policy.owner !== actor) throw new AuthoringError("Actor does not own the authoring lifecycle", "authoring_owner_mismatch", { actor, owner: policy.owner });
  }

  private async replayView(viewId: string, revision: number, operationDigest: string, schemaName: string): Promise<View | undefined> {
    const existing = await this.dependencies.views.get({ view_id: viewId, revision });
    if (!existing) return undefined;
    if (existing.metadata.authoring_operation_digest !== operationDigest) {
      throw new AuthoringError("Authoring identity was reused with a different exact request", "authoring_idempotency_conflict", {
        ref: exactViewRef(existing),
      });
    }
    if (existing.schema.name !== schemaName || existing.schema.version !== 1) {
      throw new AuthoringError("Authoring identity resolved to the wrong lifecycle Schema", "authoring_idempotency_conflict", {
        ref: exactViewRef(existing),
        expected_schema: schemaName,
        actual_schema: existing.schema.name,
      });
    }
    lifecycleValue(existing);
    return existing;
  }

  private async observe(traceId: string, type: Parameters<AuthoringObserver["record"]>[0]["type"], actor: string, refs: ExactViewRef[], details: JsonObject, cause?: unknown): Promise<void> {
    await this.dependencies.observer.record(AuthoringTraceEventSchema.parse({
      trace_id: traceId,
      type,
      occurred_at: this.now(),
      actor,
      refs,
      details,
    }), cause);
  }
}

function decisionValue(input: AuthoringDecisionInput | AuthoringRejectInput, decision: "approved" | "rejected", actor: string, traceId: string) {
  return AuthoringDecisionValueSchema.parse({
    contract_version: 1,
    proposal: input.proposal,
    proposal_digest: input.proposal_digest,
    decision,
    decided_by: actor,
    ...(input.reason ? { reason: input.reason } : {}),
    trace_id: traceId,
  });
}

function receiptDraft(id: string, value: AuthoringReceiptValue, policy: ViewPolicy, actor: string, createdAt: string, operationDigest: string) {
  const inputs = [value.request, value.proposal, value.decision].filter((ref): ref is ExactViewRef => ref !== undefined);
  return lifecycleDraft({
    id,
    schema_name: "metaflow.authoring.receipt",
    name: `Authoring Receipt: ${value.status}`,
    purpose: "Record the terminal result of one approval-gated authoring lifecycle",
    value,
    policy,
    actor,
    created_at: createdAt,
    inputs,
    relations: inputs.map(target => ({ type: "authoring_trace", target, metadata: {} })),
    metadata: { authoring_operation_digest: operationDigest },
  });
}

function commitContext(traceId: string, committedAt: string, originId: string) {
  return {
    batch_id: `${originId}:${traceId}`,
    committed_at: committedAt,
    origin: { kind: "operation" as const, id: originId },
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function jsonByteLength(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("value is not JSON-compatible");
    return Buffer.byteLength(encoded, "utf8");
  } catch (cause) {
    throw new AuthoringError("Agent proposal is not a JSON-compatible declarative value", "authoring_candidate_invalid", {}, { cause });
  }
}

function refKey(ref: ExactViewRef): string {
  return `${ref.view_id}@${ref.revision}`;
}

function normalizePolicyLabels(policy: ViewPolicy): ViewPolicy {
  return { ...policy, labels: [...policy.labels].sort() };
}

const executableKeys = new Set([
  "code",
  "command",
  "entrypoint",
  "executable",
  "module",
  "script",
  "source_code",
  "source_text",
]);

function assertNoExecutablePayload(value: unknown, path: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoExecutablePayload(item, [...path, String(index)]));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (executableKeys.has(key.toLowerCase())) {
      throw new AuthoringError("Agent proposal contains executable payload instead of an exact implementation reference", "authoring_executable_payload_forbidden", {
        path: [...path, key],
      });
    }
    assertNoExecutablePayload(child, [...path, key]);
  }
}

function safeError(cause: unknown): { code: string; message: string } {
  if (cause instanceof AuthoringError) return { code: cause.code, message: cause.message };
  if (cause instanceof ViewRepositoryError || cause instanceof TransformationRepositoryError) {
    return {
      code: cause.code.includes("conflict") ? `authoring_target_${cause.code}` : "authoring_target_invalid",
      message: cause.message.slice(0, 2_000),
    };
  }
  if (cause instanceof ExecutionRuntimeError) {
    return { code: `authoring_execution_${cause.code}`, message: cause.message.slice(0, 2_000) };
  }
  if (cause instanceof ViewPackageError) {
    return { code: `authoring_package_${cause.code}`, message: cause.message.slice(0, 2_000) };
  }
  if (cause instanceof Error) return { code: "authoring_dependency_failed", message: cause.message.slice(0, 2_000) };
  return { code: "authoring_dependency_failed", message: String(cause).slice(0, 2_000) };
}

function withReceipt(cause: unknown, receipt: ExactViewRef): AuthoringError {
  const error = safeError(cause);
  return new AuthoringError(error.message, error.code, { receipt }, { cause });
}

function replayedFailure(receipt: View): AuthoringError {
  const value = AuthoringReceiptValueSchema.parse(lifecycleValue(receipt));
  if (value.status !== "failed" || !value.error) {
    return new AuthoringError("Expected a failed authoring Receipt during replay", "authoring_idempotency_conflict", {
      receipt: exactViewRef(receipt),
    });
  }
  return new AuthoringError(value.error.message, value.error.code, {
    receipt: exactViewRef(receipt),
    replayed: true,
  });
}
