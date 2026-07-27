import { createHash } from "node:crypto";
import {
  OperatorExecutionFailure,
  type OperatorCandidateEnvelope,
  type OperatorExecutionInvocation,
} from "@info/execution";
import { canonicalJson, exactViewRef, type JsonObject, type View } from "@info/view";
import {
  STRUCTURED_FRAGMENT_SET_SCHEMA,
  STRUCTURED_PARSER_REFS,
  StructuredParserConfigurationSchema,
  type ExactStructuredParserRef,
} from "./contracts.js";
import { parseStructuredView, structuredParserRefForId } from "./parser.js";

export const STRUCTURED_PARSER_FUNCTIONS = {
  json: { kind: "function", function_id: "parser.json", version: 1 },
  table: { kind: "function", function_id: "parser.table", version: 1 },
  graph: { kind: "function", function_id: "parser.graph", version: 1 },
  external_reference: { kind: "function", function_id: "parser.external-reference", version: 1 },
} as const;

export async function executeStructuredParser(
  invocation: OperatorExecutionInvocation,
  context: { signal: AbortSignal },
): Promise<OperatorCandidateEnvelope> {
  const configuration = parseConfiguration(invocation);
  assertFunctionMatchesParser(invocation, configuration.parser);
  if (canonicalJson(invocation.run.frozen.transformation.output.schema) !== canonicalJson(STRUCTURED_FRAGMENT_SET_SCHEMA)) {
    throw new OperatorExecutionFailure(
      "parser_output_schema_mismatch",
      "Structured Parser requires the exact metaflow.view.fragment-set@2 output Schema",
    );
  }
  const source = onlySource(invocation);
  const result = await parseStructuredView({
    contract_version: 2,
    parser: configuration.parser,
    run_id: invocation.run.id,
    attempt_id: invocation.attempt.id,
    input: {
      ref: exactViewRef(source),
      representation: source.representation,
      materialization: source.materialization,
    },
    limits: configuration.limits,
  }, {
    signal: context.signal,
  });
  const sourceRef = exactViewRef(source);
  if (canonicalJson(result.source) !== canonicalJson(sourceRef)) {
    throw new OperatorExecutionFailure("parser_source_mismatch", "Structured Parser changed the frozen exact source");
  }
  const outputIdentity = createHash("sha256").update(canonicalJson({
    run_id: invocation.run.id,
    parser: configuration.parser,
    source: sourceRef,
  })).digest("hex");
  const value: JsonObject = {
    contract_version: 2,
    parser: configuration.parser,
    sources: [{ relation: "derived_from", view: sourceRef }],
    fragments: result.fragments,
    diagnostics: { warnings: result.diagnostics.warnings },
  };
  return {
    outputs: [{
      draft: {
        id: `view:fragment-set:${outputIdentity}`,
        name: `Search fragments for ${source.name}`,
        purpose: `Deterministic ${configuration.parser.parser_id} projection for ${source.id}@${source.revision}`,
        aliases: [],
        schema: STRUCTURED_FRAGMENT_SET_SCHEMA,
        role: "derived",
        time: { created_at: invocation.attempt.started_at },
        representation: {
          form: "inline",
          kind: "metaflow.view.fragment-set",
          media_type: "application/json",
          value,
          metadata: {},
        },
        materialization: {
          primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
          alternatives: [],
        },
        relations: [{ type: "derived_from", target: sourceRef, metadata: {} }],
        provenance: {
          inputs: [sourceRef],
          operator_run_id: invocation.run.id,
          actor: `${configuration.parser.parser_id}@${configuration.parser.version}`,
          trace_id: invocation.run.trace_id,
        },
        policy: source.policy,
        metadata: {
          parser_id: configuration.parser.parser_id,
          parser_version: configuration.parser.version,
          parser_abi_version: configuration.parser.abi_version,
        },
      },
      expected_revision: 0,
      idempotency_key: `fragment-set:${outputIdentity}`,
    }],
    diagnostics: {
      parser_id: configuration.parser.parser_id,
      parser_version: configuration.parser.version,
      fragment_count: result.fragments.length,
    },
  };
}

function parseConfiguration(invocation: OperatorExecutionInvocation) {
  const result = StructuredParserConfigurationSchema.safeParse(invocation.run.frozen.transformation.operator.configuration);
  if (!result.success) {
    throw new OperatorExecutionFailure(
      "parser_configuration_invalid",
      "Structured Parser Operator configuration does not satisfy the exact Parser contract",
      { issue_count: result.error.issues.length },
      { cause: result.error },
    );
  }
  return result.data;
}

function assertFunctionMatchesParser(
  invocation: OperatorExecutionInvocation,
  parser: ExactStructuredParserRef,
): void {
  const expectedParser = structuredParserRefForId(parser.parser_id);
  if (!expectedParser || canonicalJson(expectedParser) !== canonicalJson(parser)) {
    throw new OperatorExecutionFailure("parser_contract_mismatch", "Structured Parser reference is not supported");
  }
  const expectedFunction = Object.values(STRUCTURED_PARSER_FUNCTIONS).find(item => item.function_id === parser.parser_id);
  if (!expectedFunction || canonicalJson(invocation.run.frozen.transformation.operator.reference) !== canonicalJson(expectedFunction)) {
    throw new OperatorExecutionFailure("parser_operator_mismatch", "Structured Parser received a different frozen Function Operator");
  }
  if (!Object.values(STRUCTURED_PARSER_REFS).some(ref => canonicalJson(ref) === canonicalJson(parser))) {
    throw new OperatorExecutionFailure("parser_contract_mismatch", "Structured Parser reference is not registered");
  }
}

function onlySource(invocation: OperatorExecutionInvocation): View {
  const sourceBindings = invocation.inputs.filter(binding => binding.role === "source");
  const unexpected = invocation.inputs.filter(binding => binding.role !== "source" && binding.views.length > 0);
  if (sourceBindings.length !== 1 || sourceBindings[0]!.views.length !== 1 || unexpected.length > 0) {
    throw new OperatorExecutionFailure(
      "parser_input_invalid",
      "Structured Parser requires exactly one View in the source role and no other selected inputs",
      {
        source_binding_count: sourceBindings.length,
        source_view_count: sourceBindings[0]?.views.length ?? 0,
        unexpected_role_count: unexpected.length,
      },
    );
  }
  return sourceBindings[0]!.views[0]!;
}
