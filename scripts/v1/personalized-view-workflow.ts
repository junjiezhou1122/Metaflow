import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { lifecycleValue } from "@info/authoring";
import type { ExecutionRepository, ViewAccessPolicySnapshot } from "@info/execution";
import {
  inheritStrictestViewPolicy,
} from "@info/execution";
import {
  OperationEnvelopeSchema,
  type OperationContext,
  type OperationEnvelope,
  type OperationName,
  type OperationService,
} from "@info/operations";
import {
  CliOperationAdapter,
  HttpOperationAdapter,
  createOperationMcpServer,
  operationMcpToolName,
} from "@info/operation-surfaces";
import type { SearchRequestV1 } from "@info/search";
import type { Transformation, TransformationRepository } from "@info/transformation";
import { exactTransformationRef } from "@info/transformation";
import {
  canonicalJson,
  exactViewRef,
  parseViewDraft,
  TimestampSchema,
  type ExactViewRef,
  type View,
  type ViewDraft,
  type ViewPolicy,
  type ViewRepository,
  type ViewSchemaRef,
} from "@info/view";
import {
  APPLICATION_SPACE_COMPOSITION_RELATION,
  APPLICATION_SPACE_MEMBERSHIP_RELATION,
  APPLICATION_SPACE_REPRESENTATION_KIND,
  applicationSpaceRelations,
  applicationSpaceSchema,
  normalizeApplicationSpaceEntries,
  type ApplicationSpaceEntry,
} from "../../view-packages/application-space/index.js";
import { EXPLORER_DEFAULT_EDGE_TYPES } from "../../apps/view-explorer/src/contracts.js";
import { ViewExplorerOperationClient } from "../../apps/view-explorer/src/operation-client.js";

export const PERSONALIZED_WORKFLOW_SOURCE_LIMITS = Object.freeze({
  codex: 64,
  obsidian: 64,
  total: 96,
});

type WorkflowViewPort = Pick<ViewRepository, "get" | "commit"> & Pick<ExecutionRepository, "getRun">;

export type PersonalizedWorkflowPorts = {
  views: WorkflowViewPort;
  transformations: TransformationRepository;
  operations: OperationService;
};

export type PersonalizedWorkflowSemanticGateContext = {
  operations: OperationService;
  source_refs: ExactViewRef[];
  fragment_refs: ExactViewRef[];
  working_state: View;
  application_space: View;
};

export type PersonalizedWorkflowInput = {
  workflow_id: string;
  created_at: string;
  principal: OperationContext["principal"];
  ports: PersonalizedWorkflowPorts;
  sources: {
    codex: ExactViewRef[];
    obsidian: ExactViewRef[];
  };
  markdown_parser: {
    transformation: { transformation_id: string; revision: number };
    access_policy: ViewAccessPolicySnapshot;
  };
  authoring: {
    prompt: string;
    approval_reason: string;
    expected_output_schema: { name: string; version: number };
    expected_output_contract?: ViewSchemaRef;
    expected_working_state_view_id?: string;
  };
  search: {
    keyword_query: string;
    internal_query: string;
    relation_query: string;
  };
  feedback: {
    message: string;
    requested_changes: ["instruction"];
    evolved_instruction: string;
    resolution: string;
  };
  semantic_gate?: (context: PersonalizedWorkflowSemanticGateContext) => Promise<void>;
};

export type PersonalizedWorkflowSearchResult = {
  hits: Array<{
    ref: ExactViewRef;
    matched_schema: { name: string; version: number };
    matches: Array<{ location: { kind: string } }>;
    path?: unknown[];
  }>;
};

export type PersonalizedWorkflowResult = {
  workflow_id: string;
  source_views: { codex: View[]; obsidian: View[] };
  source_refs: ExactViewRef[];
  fragment_views: View[];
  authoring: {
    request: View;
    proposal: View;
    decision: View;
    receipt: View;
    transformation: Transformation;
    run_id: string;
  };
  working_state: View;
  application_space: View;
  graph: {
    projection: Awaited<ReturnType<ViewExplorerOperationClient["project"]>>;
    exact_view: View;
  };
  search: {
    keyword: PersonalizedWorkflowSearchResult;
    internal: PersonalizedWorkflowSearchResult;
    relation: PersonalizedWorkflowSearchResult;
  };
  surface_parity: {
    surfaces: Array<"in-process" | "cli" | "http" | "mcp">;
    search_operation: "view.search";
    exact_operation: "view.get";
  };
  feedback: {
    view: View;
    transformation: Transformation;
  };
  semantic_gate_executed: boolean;
};

export type PersonalizedWorkflowEvidence = {
  contract_version: 1;
  workflow_id: string;
  source_counts: { codex: number; obsidian: number; total: number };
  source_manifest_sha256: string;
  source_refs: ExactViewRef[];
  fragment_refs: ExactViewRef[];
  working_state_ref: ExactViewRef;
  application_space_ref: ExactViewRef;
  authoring_refs: {
    request: ExactViewRef;
    proposal: ExactViewRef;
    decision: ExactViewRef;
    receipt: ExactViewRef;
    transformation: { transformation_id: string; revision: number };
    run_id: string;
  };
  feedback: {
    view: ExactViewRef;
    transformation: { transformation_id: string; revision: number };
  };
  search_hit_counts: { keyword: number; internal: number; relation: number };
  surface_parity: PersonalizedWorkflowResult["surface_parity"];
  semantic_gate_executed: boolean;
};

export class PersonalizedWorkflowError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PersonalizedWorkflowError";
  }
}

export async function runPersonalizedViewWorkflow(input: PersonalizedWorkflowInput): Promise<PersonalizedWorkflowResult> {
  const workflowId = requireWorkflowId(input.workflow_id);
  requireTimestamp(input.created_at);
  requireNonEmpty(input.authoring.prompt, "authoring.prompt");
  requireNonEmpty(input.authoring.approval_reason, "authoring.approval_reason");
  requireNonEmpty(input.search.keyword_query, "search.keyword_query");
  requireNonEmpty(input.search.internal_query, "search.internal_query");
  requireNonEmpty(input.search.relation_query, "search.relation_query");
  requireNonEmpty(input.feedback.message, "feedback.message");
  requireNonEmpty(input.feedback.evolved_instruction, "feedback.evolved_instruction");
  requireNonEmpty(input.feedback.resolution, "feedback.resolution");
  const sourceViews = await resolveSources(input.ports.views, input.sources, input.principal.id);
  const sourceRefs = [...sourceViews.codex, ...sourceViews.obsidian].map(exactViewRef).sort(compareRefs);
  const inheritedPolicy = inheritStrictestViewPolicy([...sourceViews.codex, ...sourceViews.obsidian].map(view => view.policy));
  const parserTransformation = await input.ports.transformations.get(input.markdown_parser.transformation);
  if (!parserTransformation) {
    fail("parser_transformation_missing", "The exact Markdown Parser Transformation does not exist", {
      transformation: input.markdown_parser.transformation,
    });
  }
  if (parserTransformation.output.schema.name !== "metaflow.view.fragment-set") {
    fail("parser_transformation_invalid", "The Markdown Parser Transformation must output metaflow.view.fragment-set", {
      actual_schema: parserTransformation.output.schema.name,
    });
  }

  const fragmentViews: View[] = [];
  for (const [index, source] of sourceViews.obsidian.entries()) {
    const parsed = await executeOk(input, "run.execute", {
      transformation: exactTransformationRef(parserTransformation),
      parameters: {
        run_id: `run:${workflowId}:parser:${index + 1}`,
        correlation_id: `correlation:${workflowId}:parser:${index + 1}`,
        access_policy: input.markdown_parser.access_policy,
        access_use: "local_execution",
        invocation_inputs: [{ role: "source", views: [exactViewRef(source)] }],
        idempotency_key: `execution:${workflowId}:parser:${index + 1}`,
      },
    }, `parser:${index + 1}`);
    const parserRun = (parsed.data as {
      run?: { status?: unknown; error?: { code?: unknown; stage?: unknown } };
    }).run;
    if (parserRun?.status !== "succeeded") {
      fail("parser_execution_failed", "Markdown Parser Run did not succeed", {
        status: parserRun?.status ?? "missing",
        error_code: parserRun?.error?.code ?? "missing",
        error_stage: parserRun?.error?.stage ?? "missing",
      });
    }
    const output = executionOutputs(parsed.data)[0];
    if (!output || executionOutputs(parsed.data).length !== 1) {
      fail("parser_output_cardinality", "Each Markdown Parser Run must produce exactly one fragment-set View", {
        source: exactViewRef(source),
      });
    }
    if (output.schema.name !== "metaflow.view.fragment-set" || output.schema.version !== 1) {
      fail("parser_output_schema", "Markdown Parser returned an unexpected output Schema", {
        source: exactViewRef(source),
        schema: output.schema,
      });
    }
    requireExactRefList(output.provenance.inputs, [exactViewRef(source)], "parser output provenance");
    if (!isDeepStrictEqual(normalizePolicy(output.policy), normalizePolicy(source.policy))) {
      fail("parser_output_policy_weakened", "Markdown Parser output must exactly inherit its source policy", {
        source: exactViewRef(source),
      });
    }
    fragmentViews.push(output);
  }

  const ids = workflowIds(workflowId);
  const requested = await executeOk(input, "view.authoring.request", {
    view_id: ids.authoringRequest,
    expected_revision: 0,
    artifact_kind: "transformation",
    prompt: input.authoring.prompt,
    source_views: sourceRefs,
    policy: inheritedPolicy,
    trace_id: `trace:${workflowId}:authoring`,
    idempotency_key: `authoring:${workflowId}:request`,
    created_at: input.created_at,
  }, "authoring:request");
  const request = requireView(requested.data, "authoring request");
  const proposed = await executeOk(input, "view.authoring.propose", {
    request: exactViewRef(request),
    proposal_view_id: ids.authoringProposal,
    expected_revision: 0,
    idempotency_key: `authoring:${workflowId}:proposal`,
    failure_receipt_view_id: ids.authoringProposalFailure,
    created_at: tick(input.created_at, 1),
  }, "authoring:propose");
  const proposal = requireView(proposed.data, "authoring proposal");
  const proposalValue = lifecycleValue(proposal) as { artifact_digest?: unknown };
  if (typeof proposalValue.artifact_digest !== "string" || proposalValue.artifact_digest.length === 0) {
    fail("authoring_proposal_digest_missing", "Authoring proposal omitted its artifact digest");
  }
  if (input.authoring.expected_output_contract) {
    const artifact = (proposalValue as { artifact?: unknown }).artifact;
    const proposedSchema = isRecord(artifact)
      && artifact.kind === "transformation"
      && isRecord(artifact.transformation)
      && isRecord(artifact.transformation.output)
      ? artifact.transformation.output.schema
      : undefined;
    if (proposedSchema === undefined
      || canonicalJson(proposedSchema) !== canonicalJson(input.authoring.expected_output_contract)) {
      fail(
        "authoring_output_contract_mismatch",
        "The proposed Transformation output Schema does not match the approval contract",
      );
    }
  }
  const approved = await executeOk(input, "view.authoring.approve", {
    proposal: exactViewRef(proposal),
    proposal_digest: proposalValue.artifact_digest,
    decision_view_id: ids.authoringDecision,
    expected_revision: 0,
    reason: input.authoring.approval_reason,
    idempotency_key: `authoring:${workflowId}:decision`,
    created_at: tick(input.created_at, 2),
  }, "authoring:approve");
  const decision = requireView(approved.data, "authoring decision");
  const applied = await executeOk(input, "view.authoring.apply", {
    decision: exactViewRef(decision),
    receipt_view_id: ids.authoringReceipt,
    expected_revision: 0,
    idempotency_key: `authoring:${workflowId}:apply`,
    created_at: tick(input.created_at, 3),
  }, "authoring:apply");
  const receipt = requireView(applied.data, "authoring receipt");
  const receiptValue = lifecycleValue(receipt) as {
    status?: unknown;
    target?: { kind?: unknown; ref?: unknown; run_id?: unknown; run_status?: unknown };
  };
  if (receiptValue.status !== "applied" || receiptValue.target?.kind !== "transformation" || receiptValue.target.run_status !== "succeeded") {
    const failedRun = typeof receiptValue.target?.run_id === "string"
      ? await input.ports.views.getRun(receiptValue.target.run_id)
      : undefined;
    fail("authoring_apply_incomplete", "Authoring did not apply and execute one Transformation successfully", {
      status: receiptValue.status,
      target_kind: receiptValue.target?.kind,
      run_status: receiptValue.target?.run_status,
      error_code: failedRun?.error?.code ?? "missing",
      error_stage: failedRun?.error?.stage ?? "missing",
      error_details: failedRun?.error?.details ?? {},
    });
  }
  const transformationRef = requireTransformationRef(receiptValue.target.ref);
  if (typeof receiptValue.target.run_id !== "string") {
    fail("authoring_run_missing", "Authoring receipt omitted the Transformation Run id");
  }
  const authoredTransformation = await input.ports.transformations.get(transformationRef);
  if (!authoredTransformation) {
    fail("authored_transformation_missing", "The applied exact Transformation cannot be read", { transformation: transformationRef });
  }
  if (authoredTransformation.revision !== 1) {
    fail("authored_transformation_revision_invalid", "A new personalized workflow must author Transformation revision 1", {
      transformation: transformationRef,
    });
  }
  const authoredRun = await input.ports.views.getRun(receiptValue.target.run_id);
  if (!authoredRun || authoredRun.status !== "succeeded" || authoredRun.output_views.length !== 1) {
    fail("authored_run_invalid", "The authored Transformation Run is not one durable successful single-output Run", {
      run_id: receiptValue.target.run_id,
      status: authoredRun?.status,
      output_count: authoredRun?.output_views.length,
    });
  }
  const workingState = await input.ports.views.get(authoredRun.output_views[0]!);
  if (!workingState) {
    fail("working_state_missing", "The exact working-state output cannot be read", { ref: authoredRun.output_views[0] });
  }
  validateWorkingState(workingState, input.authoring, sourceRefs, inheritedPolicy);

  const applicationSpace = (await input.ports.views.commit({
    draft: applicationSpaceDraft(ids.applicationSpace, workflowId, input.created_at, [
      { ref: exactViewRef(workingState), semantics: "composition" },
      ...fragmentViews.map(view => ({ ref: exactViewRef(view), semantics: "membership" as const })),
    ], inheritStrictestViewPolicy([workingState.policy, ...fragmentViews.map(view => view.policy)]), input.principal.id),
    expected_revision: 0,
    idempotency_key: `application-space:${workflowId}`,
  })).view;

  const explorer = new ViewExplorerOperationClient({
    call: (operation, operationInput, signal) => {
      if (signal.aborted) throw signal.reason;
      return input.ports.operations.execute(
        { operation, input: operationInput },
        operationContext(input, `explorer:${operation}`),
      );
    },
  });
  const explorerSignal = new AbortController().signal;
  const projection = await explorer.project({
    roots: [exactViewRef(applicationSpace)],
    direction: "both",
    edge_types: [...EXPLORER_DEFAULT_EDGE_TYPES],
    max_depth: 2,
    max_nodes: 100,
    max_edges: 500,
  }, explorerSignal);
  requireGraphNode(projection.nodes, exactViewRef(applicationSpace), "Application Space");
  requireGraphNode(projection.nodes, exactViewRef(workingState), "working-state View");
  const explorerExactView = await explorer.getView(exactViewRef(workingState), explorerSignal);
  if (!isDeepStrictEqual(explorerExactView, workingState)) {
    fail("graph_exact_read_mismatch", "Graph Explorer exact selection did not return the committed working-state View");
  }

  const keywordRequest: SearchRequestV1 = {
    contract_version: 1,
    query: { text: input.search.keyword_query },
    scope: { kind: "all_visible", max_nodes: 100, max_scan: 200 },
    target: { envelope: true, internal: true, related_views: false },
    modes: ["keyword"],
    fusion: { strategy: "rrf@1", k: 60, weights: { keyword: 1 } },
    failure_mode: "require_all",
    page: { limit: 20 },
  };
  const keyword = await search(input, "keyword", keywordRequest);
  requireSearchHit(keyword, exactViewRef(workingState), "keyword");
  const internal = await search(input, "internal", {
    contract_version: 1,
    query: { text: input.search.internal_query },
    scope: { kind: "exact_views", refs: fragmentViews.map(exactViewRef) },
    target: { envelope: false, internal: true, related_views: false },
    modes: ["keyword"],
    fusion: { strategy: "rrf@1", k: 60, weights: { keyword: 1 } },
    failure_mode: "require_all",
    page: { limit: 20 },
  });
  if (!internal.hits.some(hit => fragmentViews.some(view => sameRef(hit.ref, exactViewRef(view)))
    && hit.matches.some(match => match.location.kind === "representation"))) {
    fail("internal_search_miss", "Internal Search did not return a representation fragment from the selected Obsidian Views");
  }
  const relation = await search(input, "relation", {
    contract_version: 1,
    query: { text: input.search.relation_query },
    scope: {
      kind: "subgraph",
      roots: [exactViewRef(applicationSpace)],
      direction: "outgoing",
      relation_types: [APPLICATION_SPACE_COMPOSITION_RELATION, APPLICATION_SPACE_MEMBERSHIP_RELATION],
      max_depth: 1,
      max_nodes: 20,
    },
    target: { envelope: false, internal: false, related_views: true },
    modes: ["relation"],
    fusion: { strategy: "rrf@1", k: 60, weights: { relation: 1 } },
    failure_mode: "require_all",
    page: { limit: 20 },
  });
  const relationHit = requireSearchHit(relation, exactViewRef(workingState), "relation");
  if (relationHit.path?.length !== 1) {
    fail("relation_search_path_invalid", "Relation Search did not preserve the one-edge Application Space path", {
      path_length: relationHit.path?.length,
    });
  }

  await verifySurfaceParity(input, keywordRequest, workingState);

  const semanticContext = {
    operations: input.ports.operations,
    source_refs: sourceRefs,
    fragment_refs: fragmentViews.map(exactViewRef),
    working_state: workingState,
    application_space: applicationSpace,
  };
  if (input.semantic_gate) await input.semantic_gate(semanticContext);

  const submitted = await executeOk(input, "feedback.submit", {
    feedback: {
      feedback_id: `feedback:${workflowId}:working-state`,
      sentiment: "correction",
      message: input.feedback.message,
      actor: input.principal.id,
      occurred_at: tick(input.created_at, 10),
      target_view: exactViewRef(workingState),
      target_run_id: receiptValue.target.run_id,
      requested_changes: input.feedback.requested_changes,
      metadata: {},
    },
  }, "feedback:submit");
  const feedbackView = requireView((submitted.data as { view?: unknown }).view, "feedback View");
  const evolved = await executeOk(input, "feedback.apply", {
    feedback: exactViewRef(feedbackView),
    base_transformation: transformationRef,
    change: {
      instruction: {
        ...authoredTransformation.instruction,
        text: input.feedback.evolved_instruction,
      },
    },
    actor: input.principal.id,
    resolution: input.feedback.resolution,
    created_at: tick(input.created_at, 11),
  }, "feedback:apply");
  const evolvedTransformation = requireTransformation(evolved.data);
  if (evolvedTransformation.revision !== 2
    || !evolvedTransformation.supersedes
    || evolvedTransformation.supersedes.transformation_id !== transformationRef.transformation_id
    || evolvedTransformation.supersedes.revision !== transformationRef.revision) {
    fail("feedback_revision_invalid", "Feedback must create exact Transformation revision 2 with a supersedes edge", {
      base: transformationRef,
      evolved: exactTransformationRef(evolvedTransformation),
      supersedes: evolvedTransformation.supersedes,
    });
  }

  return {
    workflow_id: workflowId,
    source_views: sourceViews,
    source_refs: sourceRefs,
    fragment_views: fragmentViews,
    authoring: {
      request,
      proposal,
      decision,
      receipt,
      transformation: authoredTransformation,
      run_id: receiptValue.target.run_id,
    },
    working_state: workingState,
    application_space: applicationSpace,
    graph: { projection, exact_view: explorerExactView },
    search: { keyword, internal, relation },
    surface_parity: {
      surfaces: ["in-process", "cli", "http", "mcp"],
      search_operation: "view.search",
      exact_operation: "view.get",
    },
    feedback: { view: feedbackView, transformation: evolvedTransformation },
    semantic_gate_executed: input.semantic_gate !== undefined,
  };
}

export function projectPersonalizedWorkflowEvidence(result: PersonalizedWorkflowResult): PersonalizedWorkflowEvidence {
  const sourceRefs = [...result.source_refs].sort(compareRefs);
  return {
    contract_version: 1,
    workflow_id: result.workflow_id,
    source_counts: {
      codex: result.source_views.codex.length,
      obsidian: result.source_views.obsidian.length,
      total: result.source_refs.length,
    },
    source_manifest_sha256: createHash("sha256").update(JSON.stringify(sourceRefs)).digest("hex"),
    source_refs: sourceRefs,
    fragment_refs: result.fragment_views.map(exactViewRef).sort(compareRefs),
    working_state_ref: exactViewRef(result.working_state),
    application_space_ref: exactViewRef(result.application_space),
    authoring_refs: {
      request: exactViewRef(result.authoring.request),
      proposal: exactViewRef(result.authoring.proposal),
      decision: exactViewRef(result.authoring.decision),
      receipt: exactViewRef(result.authoring.receipt),
      transformation: exactTransformationRef(result.authoring.transformation),
      run_id: result.authoring.run_id,
    },
    feedback: {
      view: exactViewRef(result.feedback.view),
      transformation: exactTransformationRef(result.feedback.transformation),
    },
    search_hit_counts: {
      keyword: result.search.keyword.hits.length,
      internal: result.search.internal.hits.length,
      relation: result.search.relation.hits.length,
    },
    surface_parity: result.surface_parity,
    semantic_gate_executed: result.semantic_gate_executed,
  };
}

async function resolveSources(
  views: WorkflowViewPort,
  refs: PersonalizedWorkflowInput["sources"],
  principalId: string,
): Promise<{ codex: View[]; obsidian: View[] }> {
  if (refs.codex.length === 0 || refs.obsidian.length === 0) {
    fail("source_group_empty", "The workflow requires at least one exact Codex ref and one exact Obsidian ref", {
      codex: refs.codex.length,
      obsidian: refs.obsidian.length,
    });
  }
  if (refs.codex.length > PERSONALIZED_WORKFLOW_SOURCE_LIMITS.codex
    || refs.obsidian.length > PERSONALIZED_WORKFLOW_SOURCE_LIMITS.obsidian
    || refs.codex.length + refs.obsidian.length > PERSONALIZED_WORKFLOW_SOURCE_LIMITS.total) {
    fail("source_limit_exceeded", "Selected source refs exceed the explicit personalized workflow limit", {
      counts: { codex: refs.codex.length, obsidian: refs.obsidian.length, total: refs.codex.length + refs.obsidian.length },
      limits: PERSONALIZED_WORKFLOW_SOURCE_LIMITS,
    });
  }
  const allRefs = [...refs.codex, ...refs.obsidian];
  const keys = allRefs.map(refKey);
  if (new Set(keys).size !== keys.length) {
    fail("source_ref_duplicate", "Every selected source must be one unique exact View ref");
  }
  const resolved: View[] = [];
  for (const ref of allRefs) {
    const view = await views.get(ref);
    if (!view) fail("source_ref_missing", "A selected exact source View does not exist", { ref });
    resolved.push(view);
  }
  const codex = resolved.slice(0, refs.codex.length);
  const obsidian = resolved.slice(refs.codex.length);
  for (const view of resolved) {
    if (view.role !== "raw") fail("source_not_raw", "Personalized workflow sources must be Raw Views", { ref: exactViewRef(view), role: view.role });
    if (view.policy.owner !== principalId) {
      fail("source_owner_mismatch", "The operation principal must own every selected source View", {
        ref: exactViewRef(view), owner: view.policy.owner, principal: principalId,
      });
    }
  }
  for (const view of codex) {
    if (!(["capture.codex.session", "capture.codex.message"].includes(view.schema.name)) || view.schema.version !== 1) {
      fail("codex_schema_invalid", "Codex sources must use a supported capture.codex.*@1 Schema", {
        ref: exactViewRef(view), schema: view.schema,
      });
    }
  }
  for (const view of obsidian) {
    if (view.schema.name !== "capture.obsidian.document" || view.schema.version !== 1) {
      fail("obsidian_schema_invalid", "Obsidian sources must use capture.obsidian.document@1", {
        ref: exactViewRef(view), schema: view.schema,
      });
    }
  }
  return { codex, obsidian };
}

function validateWorkingState(
  view: View,
  expected: PersonalizedWorkflowInput["authoring"],
  sources: ExactViewRef[],
  inheritedPolicy: ViewPolicy,
): void {
  if (view.schema.name !== expected.expected_output_schema.name || view.schema.version !== expected.expected_output_schema.version) {
    fail("working_state_schema_invalid", "Authored working-state output did not satisfy the expected Schema identity", {
      expected: expected.expected_output_schema,
      actual: { name: view.schema.name, version: view.schema.version },
    });
  }
  if (expected.expected_output_contract
    && canonicalJson(view.schema) !== canonicalJson(expected.expected_output_contract)) {
    fail("working_state_schema_contract_invalid", "Working-state View does not preserve the approved output Schema contract");
  }
  if (expected.expected_working_state_view_id && view.id !== expected.expected_working_state_view_id) {
    fail("working_state_identity_invalid", "Authored working-state output has an unexpected View id", {
      expected: expected.expected_working_state_view_id,
      actual: view.id,
    });
  }
  requireExactRefList(view.provenance.inputs, sources, "working-state provenance");
  if (view.representation.form !== "inline" || !isRecord(view.representation.value)) {
    fail("working_state_representation_invalid", "Working-state View must expose one inline object Representation");
  }
  const representedSources = (view.representation.value as Record<string, unknown>).sources;
  if (!Array.isArray(representedSources)) {
    fail("working_state_sources_missing", "Working-state Representation must freeze its exact source refs");
  }
  requireExactRefList(representedSources.map(requireExactViewRef), sources, "working-state represented sources");
  if (!isDeepStrictEqual(normalizePolicy(view.policy), normalizePolicy(inheritedPolicy))) {
    fail("working_state_policy_weakened", "Working-state policy must exactly inherit the strictest selected source policy", {
      expected: normalizePolicy(inheritedPolicy), actual: normalizePolicy(view.policy),
    });
  }
}

function applicationSpaceDraft(
  viewId: string,
  workflowId: string,
  createdAt: string,
  entriesValue: ApplicationSpaceEntry[],
  policy: ViewPolicy,
  actor: string,
): ViewDraft {
  const entries = normalizeApplicationSpaceEntries(entriesValue);
  return parseViewDraft({
    id: viewId,
    name: `Personalized working space ${workflowId}`,
    purpose: "Compose exact selected evidence, parser projections, and the current working-state View.",
    aliases: [],
    schema: applicationSpaceSchema,
    role: "derived",
    time: { created_at: tick(createdAt, 5) },
    representation: {
      form: "inline",
      kind: APPLICATION_SPACE_REPRESENTATION_KIND,
      media_type: "application/json",
      value: { version: 1, entries },
      metadata: {},
    },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
      alternatives: [],
    },
    relations: applicationSpaceRelations(entries),
    provenance: { inputs: entries.map(entry => entry.ref), actor },
    policy,
    metadata: {},
  });
}

async function search(input: PersonalizedWorkflowInput, suffix: string, request: SearchRequestV1): Promise<PersonalizedWorkflowSearchResult> {
  const envelope = await executeOk(input, "view.search", { request }, `search:${suffix}`);
  return envelope.data as PersonalizedWorkflowSearchResult;
}

type Surface = {
  name: "in-process" | "cli" | "http" | "mcp";
  call(operation: OperationName, input: unknown): Promise<OperationEnvelope>;
  close(): Promise<void>;
};

async function verifySurfaceParity(input: PersonalizedWorkflowInput, request: SearchRequestV1, workingState: View): Promise<void> {
  const surfaces = await createSurfaces(input);
  try {
    const searchResponses = await Promise.all(surfaces.map(surface => surface.call("view.search", { request })));
    requireEquivalentEnvelopes(searchResponses, "view.search");
    const exactResponses = await Promise.all(surfaces.map(surface => surface.call("view.get", { ref: exactViewRef(workingState) })));
    requireEquivalentEnvelopes(exactResponses, "view.get");
    for (const response of exactResponses) {
      if (!response.ok || !isDeepStrictEqual(response.data, workingState)) {
        fail("surface_exact_read_mismatch", "A shared Operation surface did not return the exact working-state View");
      }
    }
  } finally {
    await Promise.all(surfaces.map(surface => surface.close()));
  }
}

async function createSurfaces(input: PersonalizedWorkflowInput): Promise<Surface[]> {
  const contextProvider = () => operationContext(input, "surface:parity");
  const service = input.ports.operations;
  const cli = new CliOperationAdapter(service, contextProvider);
  const http = new HttpOperationAdapter(service, contextProvider);
  const server = createOperationMcpServer({ service, context: contextProvider });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "personalized-view-workflow", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  } catch (cause) {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    throw new PersonalizedWorkflowError("Failed to initialize the real in-memory MCP surface", "mcp_surface_start_failed", {}, { cause });
  }
  return [
    { name: "in-process", call: (operation, operationInput) => service.execute({ operation, input: operationInput }, contextProvider()), close: async () => undefined },
    { name: "cli", call: async (operation, operationInput) => (await cli.invoke([operation, JSON.stringify(operationInput)])).envelope, close: async () => undefined },
    { name: "http", call: async (operation, operationInput) => (await http.handle({ method: "POST", path: `/metaflow/v1/operations/${encodeURIComponent(operation)}`, body: operationInput })).body, close: async () => undefined },
    {
      name: "mcp",
      call: async (operation, operationInput) => {
        const result = await client.callTool({ name: operationMcpToolName(operation), arguments: operationInput as Record<string, unknown> });
        return OperationEnvelopeSchema.parse(result.structuredContent);
      },
      close: async () => { await client.close(); await server.close(); },
    },
  ];
}

async function executeOk(
  input: PersonalizedWorkflowInput,
  operation: OperationName,
  operationInput: unknown,
  requestSuffix: string,
): Promise<Extract<OperationEnvelope, { ok: true }>> {
  const envelope = await input.ports.operations.execute(
    { operation, input: operationInput },
    operationContext(input, requestSuffix),
  );
  if (!envelope.ok) {
    throw new PersonalizedWorkflowError(
      `Operation ${operation} failed: ${envelope.error.message}`,
      "operation_failed",
      { operation, request_id: envelope.request_id, error_code: envelope.error.code, category: envelope.error.category },
    );
  }
  return envelope;
}

function operationContext(input: PersonalizedWorkflowInput, suffix: string): OperationContext {
  return { request_id: `request:${input.workflow_id}:${suffix}`, principal: input.principal };
}

function executionOutputs(data: unknown): View[] {
  if (!isRecord(data) || !Array.isArray(data.outputs)) {
    fail("execution_outputs_invalid", "Execution response omitted its output Views");
  }
  return data.outputs.map(item => requireView(item, "Execution output"));
}

function requireEquivalentEnvelopes(responses: OperationEnvelope[], operation: OperationName): void {
  const first = responses[0];
  if (!first || !first.ok) fail("surface_operation_failed", `The first ${operation} surface failed`);
  for (const response of responses.slice(1)) {
    if (!isDeepStrictEqual(response, first)) {
      fail("surface_parity_mismatch", `CLI, HTTP, MCP, and in-process ${operation} envelopes differ`);
    }
  }
}

function requireSearchHit(result: PersonalizedWorkflowSearchResult, ref: ExactViewRef, mode: string) {
  const hit = result.hits.find(candidate => sameRef(candidate.ref, ref));
  if (!hit) fail(`${mode}_search_miss`, `${mode} Search did not return the required exact View`, { ref });
  return hit;
}

function requireGraphNode(nodes: Array<{ ref: ExactViewRef }>, ref: ExactViewRef, label: string): void {
  if (!nodes.some(node => sameRef(node.ref, ref))) {
    fail("graph_node_missing", `Graph projection omitted the ${label}`, { ref });
  }
}

function requireExactRefList(actual: ExactViewRef[], expected: ExactViewRef[], label: string): void {
  const normalizedActual = [...actual].sort(compareRefs);
  const normalizedExpected = [...expected].sort(compareRefs);
  if (new Set(normalizedActual.map(refKey)).size !== normalizedActual.length
    || !isDeepStrictEqual(normalizedActual, normalizedExpected)) {
    fail("exact_ref_mismatch", `${label} did not preserve the complete unique selected exact-ref set`, {
      actual: normalizedActual,
      expected: normalizedExpected,
    });
  }
}

function requireView(value: unknown, label: string): View {
  if (!isRecord(value) || typeof value.id !== "string" || !Number.isInteger(value.revision)) {
    fail("view_invalid", `${label} is not a committed View`);
  }
  return value as View;
}

function requireTransformation(value: unknown): Transformation {
  if (!isRecord(value) || typeof value.id !== "string" || !Number.isInteger(value.revision)) {
    fail("transformation_invalid", "Feedback apply did not return a committed Transformation");
  }
  return value as Transformation;
}

function requireTransformationRef(value: unknown): { transformation_id: string; revision: number } {
  if (!isRecord(value) || typeof value.transformation_id !== "string" || !Number.isInteger(value.revision)) {
    fail("transformation_ref_invalid", "Authoring receipt contains an invalid exact Transformation ref");
  }
  return { transformation_id: value.transformation_id, revision: value.revision as number };
}

function requireExactViewRef(value: unknown): ExactViewRef {
  if (!isRecord(value) || typeof value.view_id !== "string" || !Number.isInteger(value.revision)) {
    fail("view_ref_invalid", "Working-state Representation contains an invalid exact View ref");
  }
  return { view_id: value.view_id, revision: value.revision as number };
}

function workflowIds(workflowId: string) {
  return {
    authoringRequest: `view:${workflowId}:authoring:request`,
    authoringProposal: `view:${workflowId}:authoring:proposal`,
    authoringProposalFailure: `view:${workflowId}:authoring:proposal-failure`,
    authoringDecision: `view:${workflowId}:authoring:decision`,
    authoringReceipt: `view:${workflowId}:authoring:receipt`,
    applicationSpace: `view:${workflowId}:application-space`,
  };
}

function requireWorkflowId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(value)) {
    fail("workflow_id_invalid", "workflow_id must be a stable bounded identifier");
  }
  return value;
}

function requireTimestamp(value: string): void {
  if (!TimestampSchema.safeParse(value).success) fail("created_at_invalid", "created_at must be an ISO timestamp");
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) fail("text_empty", `${field} must not be empty`, { field });
}

function tick(timestamp: string, sequence: number): string {
  return new Date(Date.parse(timestamp) + sequence * 1_000).toISOString();
}

function normalizePolicy(policy: ViewPolicy): ViewPolicy {
  return { ...policy, labels: [...policy.labels].sort() };
}

function compareRefs(left: ExactViewRef, right: ExactViewRef): number {
  return left.view_id.localeCompare(right.view_id) || left.revision - right.revision;
}

function refKey(ref: ExactViewRef): string {
  return `${ref.view_id}@${ref.revision}`;
}

function sameRef(left: ExactViewRef, right: ExactViewRef): boolean {
  return left.view_id === right.view_id && left.revision === right.revision;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new PersonalizedWorkflowError(message, code, details);
}
