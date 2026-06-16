import { ContextStore } from "@info/core";
import type { StoredContextRecord, StoredContextView } from "@info/core";
import { createProcessorRegistry, type ProcessorRegistry } from "./registry.js";
import { runAgentTaskProcessor } from "./runtimes/agent-task.js";
import { runCliProcessor } from "./runtimes/cli.js";
import { runHttpProcessor } from "./runtimes/http.js";
import { runLlmProcessor } from "./runtimes/llm.js";
import { runLocalProcessor } from "./runtimes/local.js";
import type {
  ProcessorDefinition,
  ProcessorHandlerResult,
  ProcessorInput,
  ProcessorRun,
  ProcessorRunResult,
} from "./types.js";
import { writeViewDrafts } from "./view-writer.js";

export type ProcessorRuntimeOptions = {
  store?: ContextStore;
  processors?: ProcessorDefinition[];
  registry?: ProcessorRegistry;
};

export class ProcessorRuntime {
  readonly store: ContextStore;
  readonly registry: ProcessorRegistry;

  constructor(options: ProcessorRuntimeOptions = {}) {
    this.store = options.store ?? new ContextStore();
    this.registry = options.registry ?? createProcessorRegistry(options.processors ?? []);
  }

  async processObservation(
    observation: StoredContextRecord,
    payload: Record<string, unknown> = {},
  ): Promise<ProcessorRunResult> {
    const processors = this.registry.matchingObservation(observation.schema.name);
    return this.process({ kind: "observation", observation, payload }, processors);
  }

  async processView(
    view: StoredContextView,
    payload: Record<string, unknown> = {},
  ): Promise<ProcessorRunResult> {
    const processors = this.registry.matchingView(view.view_type);
    return this.process({ kind: "view", view, payload }, processors);
  }

  private async process(input: ProcessorInput, processors: ProcessorDefinition[]): Promise<ProcessorRunResult> {
    const runs: ProcessorRun[] = [];
    const source = sourceSummary(input);

    for (const processor of processors) {
      const started = this.store.appendRuntimeEvent({
        event_type: "processor.run.started",
        actor: "system",
        status: "started",
        subject_type: input.kind === "observation" ? "record" : "view",
        subject_id: source.id,
        plugin_id: processor.id,
        related_records: input.observation ? [input.observation.id] : [],
        related_views: input.view ? [input.view.id] : [],
        payload: {
          processor_id: processor.id,
          runtime: processor.runtime.kind,
          source_type: source.type,
        },
      });

      try {
        const result = await executeProcessor(processor, input, this.store);
        const sourceRecordIds = input.observation ? [input.observation.id] : [];
        const sourceViewIds = input.view ? [input.view.id] : [];
        const written = writeViewDrafts(this.store, result.views ?? [], {
          processor,
          source_record_ids: sourceRecordIds,
          source_view_ids: sourceViewIds,
        });
        const writtenObservations = (result.observations ?? []).map(observation => this.store.insertRecord(observation));
        const diagnostics = result.diagnostics ?? {};
        const run: ProcessorRun = {
          processor_id: processor.id,
          runtime: processor.runtime.kind,
          ok: true,
          source,
          view_drafts: result.views?.length ?? 0,
          observation_drafts: result.observations?.length ?? 0,
          views_written: written.map(view => view.id),
          observations_written: writtenObservations.map(record => record.id),
          diagnostics,
        };
        runs.push(run);
        this.store.appendRuntimeEvent({
          event_type: "processor.run.completed",
          actor: "system",
          status: "completed",
          subject_type: input.kind === "observation" ? "record" : "view",
          subject_id: source.id,
          plugin_id: processor.id,
          related_records: sourceRecordIds,
          related_views: [...sourceViewIds, ...written.map(view => view.id)],
          payload: {
            processor_id: processor.id,
            runtime: processor.runtime.kind,
            started_event_id: started.id,
            views_written: written.map(view => view.id),
            observations_written: writtenObservations.map(record => record.id),
            diagnostics,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        runs.push({
          processor_id: processor.id,
          runtime: processor.runtime.kind,
          ok: false,
          source,
          view_drafts: 0,
          observation_drafts: 0,
          views_written: [],
          observations_written: [],
          diagnostics: {},
          error: message,
        });
        this.store.appendRuntimeEvent({
          event_type: "processor.run.failed",
          actor: "system",
          status: "failed",
          subject_type: input.kind === "observation" ? "record" : "view",
          subject_id: source.id,
          plugin_id: processor.id,
          related_records: input.observation ? [input.observation.id] : [],
          related_views: input.view ? [input.view.id] : [],
          payload: {
            processor_id: processor.id,
            runtime: processor.runtime.kind,
            started_event_id: started.id,
            error: message,
          },
        });
      }
    }

    return {
      ok: true,
      generated_at: new Date().toISOString(),
      source,
      processors_matched: processors.map(processor => processor.id),
      runs,
      views_written: runs.flatMap(run => run.views_written),
      observations_written: runs.flatMap(run => run.observations_written ?? []),
    };
  }
}

async function executeProcessor(
  processor: ProcessorDefinition,
  input: ProcessorInput,
  store: ContextStore,
): Promise<ProcessorHandlerResult> {
  const context = { store, processor };
  switch (processor.runtime.kind) {
    case "local":
      return runLocalProcessor(input, context);
    case "llm":
      return runLlmProcessor(input, context);
    case "agent_task":
      return runAgentTaskProcessor(input, context);
    case "http":
      return runHttpProcessor(input, context);
    case "cli":
      return runCliProcessor(input, context);
  }
}

function sourceSummary(input: ProcessorInput): ProcessorRun["source"] {
  if (input.observation) {
    return {
      kind: "observation",
      id: input.observation.id,
      type: input.observation.schema.name,
    };
  }
  return {
    kind: "view",
    id: input.view?.id,
    type: input.view?.view_type,
  };
}
