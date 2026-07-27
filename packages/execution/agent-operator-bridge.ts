import {
  JsonValueSchema,
  exactViewRef,
  type JsonObject,
  type JsonValue,
  type View,
  type ViewDraft,
} from "@info/view";
import { inheritStrictestViewPolicy } from "./view-access-policy.js";
import type { AgentOperatorInvocation, AgentOperatorPort, AgentOperatorViewTool } from "./agent-operator.js";
import type {
  OperatorExecutionInvocation,
  OperatorExecutionPort,
  OperatorExecutionResult,
} from "./runtime-contracts.js";

export type AgentOperatorExecutionBridgeOptions = {
  now?: () => string;
  output_view_id?: (invocation: OperatorExecutionInvocation) => string;
};

/**
 * Adapts semantic Agent output into an untrusted View candidate. The shared
 * Execution Runtime still validates the envelope, policy, Schema, provenance,
 * base revision, and atomic commit.
 */
export class AgentOperatorExecutionBridge implements OperatorExecutionPort {
  private readonly now: () => string;
  private readonly outputViewId: (invocation: OperatorExecutionInvocation) => string;

  constructor(
    private readonly agent: AgentOperatorPort,
    options: AgentOperatorExecutionBridgeOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.outputViewId = options.output_view_id ?? (invocation => `view:derived:${invocation.run.id}`);
  }

  async execute(
    invocation: OperatorExecutionInvocation,
    context: Parameters<OperatorExecutionPort["execute"]>[1],
  ): Promise<OperatorExecutionResult> {
    const transformation = invocation.run.frozen.transformation;
    if (transformation.operator.reference.kind !== "agent") {
      return {
        status: "failed",
        error: {
          code: "operator_kind_mismatch",
          message: `Agent bridge cannot execute ${transformation.operator.reference.kind} Operator`,
        },
      };
    }
    const policies = invocation.inputs.flatMap(binding => binding.views.map(view => view.policy));
    const outputPolicy = inheritedOrFrozenOutputPolicy(
      policies,
      invocation.run.frozen.output_policy ?? invocation.run.frozen.failure_policy,
    );
    const configuration = transformation.operator.configuration;
    const outputMode = agentOutputMode(configuration.output_mode);
    if (outputMode === "schema_value" && transformation.output.schema.mode !== "strict") {
      return {
        status: "failed",
        error: {
          code: "agent_schema_value_requires_strict_schema",
          message: "schema_value Agent output requires a strict View output Schema",
        },
      };
    }
    let currentContext: JsonObject;
    try {
      currentContext = deriveCurrentContext(
        invocation.inputs,
        objectValue(configuration.current_context),
        contextCharacterBudget(transformation.budget?.limits.max_input_tokens),
      );
    } catch (error) {
      if (!(error instanceof CurrentContextBudgetError)) throw error;
      return {
        status: "failed",
        error: {
          code: "input_context_budget_exceeded",
          message: error.message,
          details: {
            character_budget: error.characterBudget,
            minimum_characters: error.minimumCharacters,
          },
        },
      };
    }
    const agentInvocation: AgentOperatorInvocation = {
      invocation_id: invocation.attempt.id,
      run_id: invocation.run.id,
      correlation_id: invocation.run.correlation_id,
      transformation: { transformation_id: transformation.id, revision: transformation.revision },
      mode: agentMode(configuration.execution_mode),
      prompt: transformation.instruction.text,
      ...(invocation.run.frozen.runtime_override?.runtime
        ? { runtime_override: invocation.run.frozen.runtime_override.runtime }
        : stringValue(configuration.runtime_override)
          ? { runtime_override: stringValue(configuration.runtime_override) }
          : {}),
      ...(stringValue(configuration.cwd) ? { cwd: stringValue(configuration.cwd) } : {}),
      current_context: currentContext,
      inputs: invocation.inputs.map(binding => ({
        role: binding.role,
        views: binding.views.map(view => ({ ref: exactViewRef(view), policy: view.policy })),
      })),
      view_tools: viewTools(configuration.view_tools),
      output_contract: {
        mode: outputMode,
        view_type: transformation.output.schema.name,
        title: transformation.name,
        purpose: transformation.instruction.text,
        ...(outputMode === "schema_value" && transformation.output.schema.mode === "strict"
          ? { schema: transformation.output.schema.json_schema }
          : {}),
      },
      policy_snapshot: {
        autonomy: autonomy(configuration.autonomy),
        allow_external_model: outputPolicy.allow_external_model,
        allow_network: booleanValue(configuration.allow_network),
        allow_write: booleanValue(configuration.allow_write),
      },
      ...(transformation.budget?.limits.timeout_ms
        ? { timeout_ms: transformation.budget.limits.timeout_ms }
        : {}),
    };

    const result = await this.agent.execute(agentInvocation, {
      events: {
        emit: event => context.emit({
          type: event.type,
          occurred_at: event.occurred_at,
          payload: jsonObject({
            runtime: event.runtime,
            invocation_id: event.invocation_id,
            ...(event.payload ? { agent_payload: event.payload } : {}),
          }),
        }),
      },
    });
    if (result.status === "failed") {
      return {
        status: "failed",
        error: {
          code: result.failure.code,
          message: result.failure.message,
          ...(result.failure.diagnostics ? { details: jsonObject(result.failure.diagnostics) } : {}),
        },
      };
    }

    let semantic: JsonValue;
    try {
      semantic = jsonValue(result.candidate);
    } catch (error) {
      return {
        status: "failed",
        error: {
          code: "agent_candidate_not_json",
          message: error instanceof Error ? error.message : "Agent candidate is not JSON",
        },
      };
    }
    const inputs = invocation.inputs.flatMap(binding => binding.views.map(view => exactViewRef(view)));
    const draft: ViewDraft = {
      id: this.outputViewId(invocation),
      name: transformation.name,
      purpose: transformation.instruction.text,
      aliases: [],
      schema: transformation.output.schema,
      role: "derived",
      time: { created_at: this.now() },
      representation: { form: "inline", kind: "agent_output", value: semantic, metadata: {} },
      materialization: {
        primary: {
          id: "canonical-json",
          format: "json",
          media_type: "application/json",
          location: { kind: "inline" },
        },
        alternatives: [],
      },
      relations: inputs.map(target => ({ type: "derived_from", target, metadata: {} })),
      provenance: {
        inputs,
        operator_run_id: invocation.run.id,
        actor: `agent:${result.runtime}`,
        trace_id: invocation.run.trace_id,
      },
      policy: outputPolicy,
      metadata: { agent_runtime: result.runtime },
    };
    return {
      status: "succeeded",
      candidate: {
        outputs: [{ draft, expected_revision: 0 }],
        diagnostics: {
          runtime: result.runtime,
          ...(result.diagnostics ? { agent: jsonObject(result.diagnostics) } : {}),
        },
      },
    };
  }

  async cancel(attemptId: string): Promise<void> {
    const result = await this.agent.cancel(attemptId);
    if (result.status === "failed" && result.failure.code !== "not_running") {
      throw new Error(result.failure.message);
    }
  }
}

function jsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Agent candidate cannot be serialized as JSON");
  return JsonValueSchema.parse(JSON.parse(serialized));
}

function jsonObject(value: unknown): JsonObject {
  const parsed = jsonValue(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("Expected a JSON object");
  }
  return parsed;
}

function objectValue(value: JsonValue | undefined): JsonObject {
  if (value === undefined) return {};
  return jsonObject(value);
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanValue(value: JsonValue | undefined): boolean {
  return value === true;
}

function agentMode(value: JsonValue | undefined): AgentOperatorInvocation["mode"] {
  return value === "interactive" || value === "background" ? value : "invoke";
}

function agentOutputMode(value: JsonValue | undefined): NonNullable<AgentOperatorInvocation["output_contract"]["mode"]> {
  if (value === undefined || value === "agent_task_output") return "agent_task_output";
  if (value === "schema_value") return "schema_value";
  throw new TypeError(`Agent Operator configuration.output_mode is unsupported: ${String(value)}`);
}

function inheritedOrFrozenOutputPolicy(policies: View["policy"][], frozen?: View["policy"]): View["policy"] {
  if (policies.length > 0) return inheritStrictestViewPolicy(policies);
  if (frozen) return frozen;
  throw new TypeError("A zero-input Agent Operator requires a frozen output policy");
}

function autonomy(value: JsonValue | undefined): AgentOperatorInvocation["policy_snapshot"]["autonomy"] {
  return value === "act" || value === "autonomous" ? value : "suggest";
}

function viewTools(value: JsonValue | undefined): AgentOperatorViewTool[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("Agent Operator configuration.view_tools must be an array");
  return value.map((tool, index) => {
    const object = jsonObject(tool);
    if (typeof object.name !== "string" || typeof object.kind !== "string") {
      throw new TypeError(`Agent View tool ${index} requires name and kind`);
    }
    if (!(["cli", "mcp", "http", "native"] as string[]).includes(object.kind)) {
      throw new TypeError(`Agent View tool ${index} has unsupported kind ${object.kind}`);
    }
    return object as AgentOperatorViewTool;
  });
}

function deriveCurrentContext(
  inputs: OperatorExecutionInvocation["inputs"],
  configured: JsonObject,
  characterBudget: number,
): JsonObject {
  const records: ContextEvidenceRecord[] = [];
  let page: View | undefined;
  let selection: View | undefined;
  let voice: View | undefined;
  let app: View | undefined;
  for (const binding of inputs) {
    for (const view of binding.views) {
      records.push({ role: binding.role, view });
      if (binding.role === "current_page" && !page) page = view;
      if (binding.role === "current_selection" && !selection) selection = view;
      if (binding.role === "voice_utterance" && !voice) voice = view;
      if (binding.role === "current_app" && !app) app = view;
    }
  }

  const fullEvidence = records.map(record => contextEvidence(record, fullRepresentation(record.view)));
  const full = assembleCurrentContext({
    configured,
    evidence: fullEvidence,
    page,
    selection,
    voice,
    app,
    characterBudget,
    includeSemanticText: true,
    truncated: false,
  });
  if (serializedLength(full) <= characterBudget) return full;

  const evidence = records.map(record => contextEvidence(record, minimumRepresentation(record.view)));
  let bounded = assembleCurrentContext({
    configured,
    evidence,
    page,
    selection,
    voice,
    app,
    characterBudget,
    includeSemanticText: false,
    truncated: true,
  });
  const minimumCharacters = serializedLength(bounded);
  if (minimumCharacters > characterBudget) {
    throw new CurrentContextBudgetError(characterBudget, minimumCharacters);
  }

  const expansionOrder = records
    .map((record, index) => ({ index, external: record.view.representation.form === "external_reference" }))
    .sort((left, right) => Number(right.external) - Number(left.external));
  for (const { index } of expansionOrder) {
    const record = records[index]!;
    const complete = contextEvidence(record, fullRepresentation(record.view));
    const completeCandidate = replaceEvidence(bounded, index, complete);
    if (serializedLength(completeCandidate) <= characterBudget) {
      bounded = completeCandidate;
      continue;
    }
    bounded = maximizeEvidencePreview(bounded, index, record, characterBudget);
  }
  return bounded;
}

type ContextEvidenceRecord = {
  role: string;
  view: View;
};

type AssembleCurrentContextInput = {
  configured: JsonObject;
  evidence: JsonValue[];
  page?: View;
  selection?: View;
  voice?: View;
  app?: View;
  characterBudget: number;
  includeSemanticText: boolean;
  truncated: boolean;
};

function assembleCurrentContext(input: AssembleCurrentContextInput): JsonObject {
  const {
    configured,
    evidence,
    page,
    selection,
    voice,
    app,
    characterBudget,
    includeSemanticText,
    truncated,
  } = input;
  const configuredScreen = omitKeys(
    isJsonObject(configured.screen) ? configured.screen : {},
    [
      ...(page ? ["title", "app", "url", "text", "view_ref"] : []),
      ...(selection ? ["selected_text", "view_ref"] : []),
    ],
  );
  const configuredVoice = omitKeys(
    isJsonObject(configured.voice) ? configured.voice : {},
    voice ? ["transcript", "language", "audio_view_ref"] : [],
  );
  const configuredApp = omitKeys(
    isJsonObject(configured.app) ? configured.app : {},
    app ? ["name", "bundle_id", "window_title", "project_path"] : [],
  );
  const configuredRaw = isJsonObject(configured.raw) ? configured.raw : {};
  const pageObject = inlineObject(page);
  const selectionObject = inlineObject(selection);
  const voiceObject = inlineObject(voice);
  const appObject = inlineObject(app);
  const pageDetails = objectField(pageObject, "page");
  const pageContent = objectField(pageObject, "content");
  const pageFacts = objectField(pageObject, "facts");
  const selectionDetails = objectField(selectionObject, "page");
  const selectionContent = objectField(selectionObject, "content");
  const selectionText = inlineText(selection, selectionObject, ["selected_text", "text", "content"])
    ?? stringFromFields(selectionContent, ["selected_text", "text", "content"])
    ?? stringFromFields(pageContent, ["selected_text"])
    ?? inlineText(app, appObject, ["selected_text"]);
  const pageText = inlineText(page, pageObject, ["text", "content", "body"])
    ?? stringFromFields(pageContent, ["text", "content", "body"]);
  const transcript = inlineText(voice, voiceObject, ["transcript", "text"]);
  const derivedScreen: JsonObject = {
    ...(stringField(pageObject, "title") ?? stringField(pageDetails, "title")
      ?? stringField(selectionDetails, "title") ?? stringField(appObject, "window_title")
      ? { title: (stringField(pageObject, "title") ?? stringField(pageDetails, "title")
          ?? stringField(selectionDetails, "title") ?? stringField(appObject, "window_title"))! }
      : {}),
    ...(stringField(pageObject, "app") ?? stringField(pageFacts, "app_name") ?? stringField(appObject, "app_name")
      ? { app: (stringField(pageObject, "app") ?? stringField(pageFacts, "app_name") ?? stringField(appObject, "app_name"))! }
      : {}),
    ...(stringField(pageObject, "url") ?? stringField(pageDetails, "url") ?? stringField(selectionDetails, "url")
      ? { url: (stringField(pageObject, "url") ?? stringField(pageDetails, "url") ?? stringField(selectionDetails, "url"))! }
      : {}),
    ...(includeSemanticText && pageText ? { text: pageText } : {}),
    ...(includeSemanticText && selectionText ? { selected_text: selectionText } : {}),
    ...(page ? { view_ref: `${page.id}@${page.revision}` } : selection ? { view_ref: `${selection.id}@${selection.revision}` } : {}),
  };
  const derivedVoice: JsonObject = {
    ...(includeSemanticText && transcript ? { transcript } : {}),
    ...(stringField(voiceObject, "language") ?? stringField(voiceObject, "locale")
      ? { language: (stringField(voiceObject, "language") ?? stringField(voiceObject, "locale"))! }
      : {}),
    ...(voice ? { audio_view_ref: `${voice.id}@${voice.revision}` } : {}),
  };
  const derivedApp: JsonObject = {
    ...(stringField(appObject, "app_name") ? { name: stringField(appObject, "app_name")! } : {}),
    ...(stringField(appObject, "window_title") ? { window_title: stringField(appObject, "window_title")! } : {}),
    ...(stringField(appObject, "bundle_id") ?? stringField(appObject, "bundle_identifier")
      ? { bundle_id: (stringField(appObject, "bundle_id") ?? stringField(appObject, "bundle_identifier"))! }
      : {}),
    ...(stringField(appObject, "project_path") ? { project_path: stringField(appObject, "project_path")! } : {}),
  };
  return {
    ...configured,
    voice: { ...configuredVoice, ...derivedVoice },
    screen: { ...configuredScreen, ...derivedScreen },
    app: { ...configuredApp, ...derivedApp },
    raw: {
      ...configuredRaw,
      metaflow_inputs: evidence,
      metaflow_context_budget: {
        max_characters: characterBudget,
        truncated,
      },
    },
  };
}

function contextEvidence(record: ContextEvidenceRecord, representation: JsonValue): JsonValue {
  return {
    role: record.role,
    ref: exactViewRef(record.view),
    schema: record.view.schema,
    representation,
  };
}

function fullRepresentation(view: View): JsonValue {
  if (view.representation.form === "external_reference") {
    return {
      form: "external_reference",
      kind: view.representation.kind,
      uri: view.representation.uri,
      ...(view.representation.digest ? { digest: view.representation.digest } : {}),
      ...(view.representation.media_type ? { media_type: view.representation.media_type } : {}),
    };
  }
  return { form: "inline", kind: view.representation.kind, value: view.representation.value };
}

function minimumRepresentation(view: View): JsonValue {
  if (view.representation.form === "external_reference") {
    return {
      form: "external_reference",
      kind: view.representation.kind,
      referenced_by_exact_view: true,
      uri_characters: view.representation.uri.length,
      ...(view.representation.digest ? { digest: view.representation.digest } : {}),
      ...(view.representation.media_type ? { media_type: view.representation.media_type } : {}),
      truncated: true,
    };
  }
  const serialized = JSON.stringify(view.representation.value);
  return {
    form: "inline",
    kind: view.representation.kind,
    truncated: true,
    original_characters: serialized.length,
  };
}

function maximizeEvidencePreview(
  context: JsonObject,
  index: number,
  record: ContextEvidenceRecord,
  characterBudget: number,
): JsonObject {
  const representation = record.view.representation;
  const source = representation.form === "inline"
    ? JSON.stringify(representation.value)
    : representation.uri;
  let low = 0;
  let high = source.length;
  let best = context;
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const preview = representation.form === "inline"
      ? {
          ...minimumRepresentation(record.view) as JsonObject,
          preview: source.slice(0, length),
        }
      : {
          ...minimumRepresentation(record.view) as JsonObject,
          uri_preview: source.slice(0, length),
        };
    const candidate = replaceEvidence(context, index, contextEvidence(record, preview));
    if (serializedLength(candidate) <= characterBudget) {
      best = candidate;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  return best;
}

function replaceEvidence(context: JsonObject, index: number, replacement: JsonValue): JsonObject {
  const raw = isJsonObject(context.raw) ? context.raw : {};
  const evidence = Array.isArray(raw.metaflow_inputs) ? [...raw.metaflow_inputs] : [];
  evidence[index] = replacement;
  return {
    ...context,
    raw: { ...raw, metaflow_inputs: evidence },
  };
}

function serializedLength(value: JsonValue): number {
  return JSON.stringify(value).length;
}

class CurrentContextBudgetError extends Error {
  constructor(
    readonly characterBudget: number,
    readonly minimumCharacters: number,
  ) {
    super(`Agent current_context requires at least ${minimumCharacters} characters but the frozen budget allows ${characterBudget}`);
    this.name = "CurrentContextBudgetError";
  }
}

function contextCharacterBudget(maxInputTokens: number | undefined): number {
  if (maxInputTokens === undefined) return 32_000;
  return Math.max(256, Math.min(100_000, maxInputTokens * 4));
}

function inlineObject(view: View | undefined): JsonObject | undefined {
  if (!view || view.representation.form !== "inline") return undefined;
  return isJsonObject(view.representation.value) ? view.representation.value : undefined;
}

function inlineText(view: View | undefined, object: JsonObject | undefined, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = object?.[field];
    if (typeof value === "string" && value) return value;
  }
  if (view?.representation.form === "inline" && typeof view.representation.value === "string") {
    return view.representation.value;
  }
  return undefined;
}

function stringField(object: JsonObject | undefined, field: string): string | undefined {
  const value = object?.[field];
  return typeof value === "string" && value ? value : undefined;
}

function stringFromFields(object: JsonObject | undefined, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = stringField(object, field);
    if (value) return value;
  }
  return undefined;
}

function objectField(object: JsonObject | undefined, field: string): JsonObject | undefined {
  const value = object?.[field];
  return isJsonObject(value) ? value : undefined;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function omitKeys(object: JsonObject, keys: string[]): JsonObject {
  const result = { ...object };
  for (const key of keys) delete result[key];
  return result;
}
