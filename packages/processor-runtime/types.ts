import type {
  ContextRecord,
  ContextStore,
  ContextView,
  StoredContextRecord,
  StoredContextView,
} from "@info/core";

export type ProcessorSourceKind = "observation" | "view";

export type ProcessorPattern = string;

export type ProcessorConsumptionSpec = {
  observations?: ProcessorPattern[];
  views?: ProcessorPattern[];
};

export type ProcessorProductionSpec = {
  views?: ProcessorPattern[];
  observations?: ProcessorPattern[];
  events?: ProcessorPattern[];
};

export type ProcessorRuntimeKind = "local" | "llm" | "agent_task" | "http" | "cli";

export type LocalProcessorRuntime = {
  kind: "local";
};

export type LlmProcessorRuntime = {
  kind: "llm";
  provider?: string;
  model?: string;
  prompt_id?: string;
};

export type AgentTaskProcessorRuntime = {
  kind: "agent_task";
  agent?: "claude_code" | "acp" | string;
  task_template?: string;
};

export type HttpProcessorRuntime = {
  kind: "http";
  url: string;
  method?: "POST";
};

export type CliProcessorRuntime = {
  kind: "cli";
  command: string;
  args?: string[];
};

export type ProcessorRuntimeConfig =
  | LocalProcessorRuntime
  | LlmProcessorRuntime
  | AgentTaskProcessorRuntime
  | HttpProcessorRuntime
  | CliProcessorRuntime;

export type ProcessorInput = {
  kind: ProcessorSourceKind;
  observation?: StoredContextRecord;
  view?: StoredContextView;
  payload?: Record<string, unknown>;
};

export type ProcessorContext = {
  store: ContextStore;
  processor: ProcessorDefinition;
  signal?: Record<string, unknown>;
};

export type ViewDraft = Omit<ContextView, "view_type"> & {
  type: string;
};

export type ObservationDraft = ContextRecord;

export type ProcessorHandlerResult = {
  views?: ViewDraft[];
  observations?: ObservationDraft[];
  events?: Array<{
    type: string;
    payload?: Record<string, unknown>;
  }>;
  diagnostics?: Record<string, unknown>;
};

export type ProcessorHandler = (
  input: ProcessorInput,
  context: ProcessorContext,
) => Promise<ProcessorHandlerResult> | ProcessorHandlerResult;

export type ProcessorDefinition = {
  id: string;
  title?: string;
  version?: string;
  description?: string;
  consumes: ProcessorConsumptionSpec;
  produces: ProcessorProductionSpec;
  runtime: ProcessorRuntimeConfig;
  policy?: {
    speed?: "reflex" | "glance" | "think" | "work" | "background";
    autonomy?: "manual" | "suggest" | "draft" | "sandbox_auto" | "full_auto";
    privacy?: "inherit" | "private" | "workspace" | "public";
  };
  handler?: ProcessorHandler;
};

export type ProcessorRun = {
  processor_id: string;
  runtime: ProcessorRuntimeKind;
  ok: boolean;
  source: {
    kind: ProcessorSourceKind;
    id?: string;
    type?: string;
  };
  view_drafts: number;
  observation_drafts?: number;
  views_written: string[];
  observations_written?: string[];
  diagnostics: Record<string, unknown>;
  error?: string;
};

export type ProcessorRunResult = {
  ok: true;
  generated_at: string;
  source: ProcessorRun["source"];
  processors_matched: string[];
  runs: ProcessorRun[];
  views_written: string[];
  observations_written?: string[];
};

export type WriteViewDraftContext = {
  processor: ProcessorDefinition;
  source_record_ids?: string[];
  source_view_ids?: string[];
};
