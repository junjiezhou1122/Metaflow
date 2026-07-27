import { createHash } from "node:crypto";
import {
  OperatorExecutionFailure,
  type OperatorExecutionInvocation,
  type OperatorCandidateEnvelope,
} from "@info/execution";
import {
  canonicalJson,
  exactViewRef,
  type JsonObject,
  type View,
} from "@info/view";
import {
  MARKDOWN_FRAGMENT_SET_SCHEMA,
  MARKDOWN_PARSER_REF,
  MarkdownParserConfigurationSchema,
} from "./contracts.js";
import { parseMarkdownView } from "./parser.js";

export const MARKDOWN_PARSER_FUNCTION = {
  kind: "function",
  function_id: "parser.markdown",
  version: 1,
} as const;

export async function executeMarkdownParser(
  invocation: OperatorExecutionInvocation,
  context: { signal: AbortSignal },
): Promise<OperatorCandidateEnvelope> {
  const reference = invocation.run.frozen.transformation.operator.reference;
  if (canonicalJson(reference) !== canonicalJson(MARKDOWN_PARSER_FUNCTION)) {
    throw new OperatorExecutionFailure("parser_operator_mismatch", "Markdown Parser received a different frozen Function Operator");
  }
  const configurationResult = MarkdownParserConfigurationSchema.safeParse(
    invocation.run.frozen.transformation.operator.configuration,
  );
  if (!configurationResult.success) {
    throw new OperatorExecutionFailure(
      "parser_configuration_invalid",
      "Markdown Parser Operator configuration does not satisfy the exact Parser contract",
      { issue_count: configurationResult.error.issues.length },
      { cause: configurationResult.error },
    );
  }
  const configuration = configurationResult.data;
  if (canonicalJson(invocation.run.frozen.transformation.output.schema) !== canonicalJson(MARKDOWN_FRAGMENT_SET_SCHEMA)) {
    throw new OperatorExecutionFailure(
      "parser_output_schema_mismatch",
      "Markdown Parser requires the exact metaflow.view.fragment-set@1 output Schema",
    );
  }
  const source = onlySource(invocation);
  const result = await parseMarkdownView({
    contract_version: 1,
    parser: MARKDOWN_PARSER_REF,
    run_id: invocation.run.id,
    attempt_id: invocation.attempt.id,
    input: { ref: exactViewRef(source), representation: source.representation },
    limits: configuration.limits,
  }, {
    signal: context.signal,
    timeout_ms: invocation.run.frozen.transformation.budget?.limits.timeout_ms,
  });
  const sourceRef = exactViewRef(source);
  if (canonicalJson(result.source) !== canonicalJson(sourceRef)) {
    throw new Error("Markdown Parser result changed the frozen exact source");
  }
  const outputIdentity = createHash("sha256").update(canonicalJson({
    run_id: invocation.run.id,
    parser: MARKDOWN_PARSER_REF,
    source: sourceRef,
  })).digest("hex");
  const viewId = `view:fragment-set:${outputIdentity}`;
  const value: JsonObject = {
    contract_version: 1,
    parser: MARKDOWN_PARSER_REF,
    sources: [{ relation: "derived_from", view: sourceRef }],
    fragments: result.fragments,
    diagnostics: { warnings: result.diagnostics.warnings },
  };
  return {
    outputs: [{
      draft: {
        id: viewId,
        name: `Search fragments for ${source.name}`,
        purpose: `Deterministic Markdown search projection for ${source.id}@${source.revision}`,
        aliases: [],
        schema: MARKDOWN_FRAGMENT_SET_SCHEMA,
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
          actor: `${MARKDOWN_PARSER_REF.parser_id}@${MARKDOWN_PARSER_REF.version}`,
          trace_id: invocation.run.trace_id,
        },
        policy: source.policy,
        metadata: {
          parser_id: MARKDOWN_PARSER_REF.parser_id,
          parser_version: MARKDOWN_PARSER_REF.version,
          parser_abi_version: MARKDOWN_PARSER_REF.abi_version,
        },
      },
      expected_revision: 0,
      idempotency_key: `fragment-set:${outputIdentity}`,
    }],
    diagnostics: {
      parser_id: MARKDOWN_PARSER_REF.parser_id,
      parser_version: MARKDOWN_PARSER_REF.version,
      fragment_count: result.fragments.length,
    },
  };
}

function onlySource(invocation: OperatorExecutionInvocation): View {
  const sourceBindings = invocation.inputs.filter(binding => binding.role === "source");
  const unexpected = invocation.inputs.filter(binding => binding.role !== "source" && binding.views.length > 0);
  if (sourceBindings.length !== 1 || sourceBindings[0]!.views.length !== 1 || unexpected.length > 0) {
    throw new OperatorExecutionFailure(
      "parser_input_invalid",
      "Markdown Parser requires exactly one View in the source role and no other selected inputs",
      {
        source_binding_count: sourceBindings.length,
        source_view_count: sourceBindings[0]?.views.length ?? 0,
        unexpected_role_count: unexpected.length,
      },
    );
  }
  return sourceBindings[0]!.views[0]!;
}
