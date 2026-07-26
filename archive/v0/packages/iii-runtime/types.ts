import type { ContextStore, StoredContextRecord, StoredContextView } from "@info/core";
import type { ViewProcessorDefinition, ViewProcessorInput, ViewProcessorResult } from "@info/views/processors.js";

export type IiiRuntimeClient = {
  registerFunction(id: string, handler: (input: unknown) => Promise<any>, options?: unknown): unknown | Promise<unknown>;
  registerTrigger?(trigger: { type: string; function_id: string; config: Record<string, unknown>; metadata?: Record<string, unknown> }): unknown | Promise<unknown>;
  trigger?(input: { function_id: string; payload?: unknown; action?: unknown }): Promise<unknown> | unknown;
};

export type InfoIiiRuntimeOptions = {
  store?: ContextStore;
  engineUrl?: string;
  workerName?: string;
};

export type ViewWorkerInput = ViewProcessorInput;

export type InfoWorkerKind = "ingest" | "context" | "processor" | "view_compiler" | "program" | "capability" | "runtime" | "router";

export type InfoWorkerInputSpec = {
  topics?: string[];
  observations?: string[];
  views?: string[];
  filters?: {
    source?: string;
    connector?: string;
    domain?: string;
    app?: string;
    project_path?: string;
    repo?: string;
  };
};

export type InfoWorkerDefinition = {
  id: string;
  title: string;
  kind: InfoWorkerKind;
  processor: {
    function_id: string;
  };
  subscribes: InfoWorkerInputSpec;
  produces: {
    observations?: string[];
    views?: string[];
    events?: string[];
    topics?: string[];
  };
  policy?: {
    speed?: "reflex" | "glance" | "think" | "work" | "background";
    autonomy?: "manual" | "suggest" | "draft" | "sandbox_auto" | "full_auto";
  };
  program_id?: string;
  capability_id?: string;
};

export type ViewWorkerResult = ViewProcessorResult;

export type ViewWorkerContext = {
  store: ContextStore;
  iii?: IiiRuntimeClient;
};

export type ViewWorkerDefinition = Omit<ViewProcessorDefinition, "process"> & {
  handler: (input: ViewWorkerInput, context: ViewWorkerContext) => Promise<ViewWorkerResult>;
};

export type ViewDependencySpec = {
  function_id: string;
  view_type: string;
  depends_on: string[];
  source_records?: StoredContextRecord[];
  source_views?: StoredContextView[];
};

export type IiiCascadeInput = ViewWorkerInput & {
  record_id?: string;
  record_ids?: string[];
  view_id?: string;
  view_ids?: string[];
  view_type?: string;
};

export type IiiCascadeStep = {
  function_id: string;
  view_type: string;
  depth: number;
  input: ViewWorkerInput;
  result?: ViewWorkerResult;
  raw_result?: unknown;
  skipped?: string;
};

export type IiiCascadeResult = {
  ok: true;
  mode: "iii_cascade";
  generated_at: string;
  root_records: string[];
  root_views: string[];
  steps: IiiCascadeStep[];
  views_written: string[];
};
