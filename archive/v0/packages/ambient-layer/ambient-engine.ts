import { randomUUID } from "node:crypto";
import type { ContextRecord, ContextStore, ContextView, LlmOptions, StoredContextRecord, StoredContextView } from "@info/core";
import { ProcessorRuntime, createProcessorRegistry } from "@info/processor-runtime";

// ======================================================================
// Speed Tiers
// ======================================================================

export type SpeedTier = "reflex" | "glance" | "think" | "work" | "background";

export const SPEED_TIER_DEFINITIONS: Record<SpeedTier, { label: string; maxLatencyMs: number; description: string }> = {
  reflex: { label: "Reflex", maxLatencyMs: 50, description: "Immediate response, no IO." },
  glance: { label: "Glance", maxLatencyMs: 500, description: "Quick context check, local reads." },
  think: { label: "Think", maxLatencyMs: 3000, description: "Involved processing, LLM call." },
  work: { label: "Work", maxLatencyMs: 15000, description: "Heavier processing, agent task." },
  background: { label: "Background", maxLatencyMs: 60000, description: "Out-of-band, async processing." },
};

export function speedTierOf(intentName: string): SpeedTier {
  switch (intentName) {
    case "attach_local_file":
      return "glance";
    case "check_or_cite_fact":
      return "think";
    case "project_context":
      return "glance";
    default:
      return "background";
  }
}

// ======================================================================
// Intent Resolver
// ======================================================================

export type ResolvedIntent = {
  name: string;
  confidence: number;
  args: Record<string, unknown>;
  speed: SpeedTier;
  sourceText: string;
  resolvedAt: string;
};

export type InlineIntent = {
  name: string;
  confidence: number;
  args: Record<string, unknown>;
};

export type ResolveIntentsResult = {
  ok: true;
  sourceText: string;
  intents: InlineIntent[];
  speedMapping: SpeedTier[];
};

const INTENT_PATTERNS: Array<{ name: string; regex: RegExp; extractor: (match: RegExpExecArray, text: string) => InlineIntent }> = [
  {
    name: "attach_local_file",
    regex: /@info\s+(?:attach|file)\s+["']?(.+?)["']?(?:\s|$)/i,
    extractor: (match) => ({
      name: "attach_local_file",
      confidence: 0.95,
      args: { filePath: match[1] },
    }),
  },
  {
    name: "check_or_cite_fact",
    regex: /@info\s+(?:check|cite|verify)\s+(.+)/i,
    extractor: (match) => ({
      name: "check_or_cite_fact",
      confidence: 0.88,
      args: { claim: match[1] },
    }),
  },
  {
    name: "project_context",
    regex: /@info\s*(?:context|project|ctx)?\s*$/i,
    extractor: () => ({
      name: "project_context",
      confidence: 0.85,
      args: {},
    }),
  },
];

export function parseInlineIntent(text: string): InlineIntent[] {
  const intents: InlineIntent[] = [];
  for (const pattern of INTENT_PATTERNS) {
    const match = pattern.regex.exec(text);
    if (match) intents.push(pattern.extractor(match, text));
  }
  return intents;
}

export function resolveIntents(text: string): ResolveIntentsResult {
  const intents = parseInlineIntent(text);
  return {
    ok: true,
    sourceText: text,
    intents,
    speedMapping: intents.map((intent) => speedTierOf(intent.name)),
  };
}

// ======================================================================
// Ambient Layer Core
// ======================================================================

export type AmbientLayerOptions = {
  store: ContextStore;
  processors?: AmbientIntentProcessor[];
  llm?: LlmOptions;
};

export type AmbientIntentProcessor = {
  id: string;
  title: string;
  intentName: string;
  speed: SpeedTier;
  handler: (input: AmbientIntentInput) => Promise<AmbientIntentResult>;
};

export type AmbientIntentInput = {
  intent: InlineIntent;
  sourceText: string;
  store: ContextStore;
  llm?: LlmOptions;
};

export type AmbientIntentResult = {
  ok: true;
  view_type: string;
  intent_name: string;
  confidence: number;
  content: Record<string, unknown>;
  source_observations?: string[];
  diagnostics?: Record<string, unknown>;
};

export class AmbientLayer {
  private store: ContextStore;
  private processors: Map<string, AmbientIntentProcessor>;
  private llm?: LlmOptions;

  constructor(options: AmbientLayerOptions) {
    this.store = options.store;
    this.processors = new Map(options.processors?.map((p) => [p.intentName, p]) ?? []);
    this.llm = options.llm;
  }

  register(processor: AmbientIntentProcessor): void {
    this.processors.set(processor.intentName, processor);
  }

  resolve(text: string): ResolveIntentsResult {
    return resolveIntents(text);
  }

  async handle(intent: InlineIntent, sourceText: string): Promise<AmbientIntentResult> {
    const processor = this.processors.get(intent.name);
    if (!processor) {
      throw new Error(`No processor registered for intent: ${intent.name}`);
    }
    return processor.handler({ intent, sourceText, store: this.store, llm: this.llm });
  }

  async resolveAndHandle(text: string): Promise<Array<{ intent: InlineIntent; result: AmbientIntentResult }>> {
    const resolved = this.resolve(text);
    const out: Array<{ intent: InlineIntent; result: AmbientIntentResult }> = [];
    for (const intent of resolved.intents) {
      const result = await this.handle(intent, text);
      out.push({ intent, result });
    }
    return out;
  }
}

// ======================================================================
// Built-in Intent Handlers
// ======================================================================

export async function handleAttachLocalFile(input: AmbientIntentInput): Promise<AmbientIntentResult> {
  const filePath = String(input.intent.args.filePath ?? "");
  const observations = input.store.recent(100);
  const matched = observations.find((record) => {
    const text = `${record.content?.text ?? ""}\n${record.content?.path ?? ""}\n${JSON.stringify(record.payload ?? {})}`;
    return text.includes(filePath) || filePath.includes(record.content?.title ?? "");
  });

  const outputObservations: string[] = [];
  if (matched) outputObservations.push(matched.id);

  return {
    ok: true,
    view_type: "ambient.result",
    intent_name: "attach_local_file",
    confidence: 0.92,
    content: {
      file_path: filePath,
      matched_record_id: matched?.id ?? null,
      preview: matched?.content?.text?.slice(0, 200) ?? null,
    },
    source_observations: outputObservations,
    diagnostics: { records_scanned: observations.length, matched: !!matched },
  };
}

export async function handleCheckOrCiteFact(input: AmbientIntentInput): Promise<AmbientIntentResult> {
  const claim = String(input.intent.args.claim ?? "");
  const observations = input.store.recent(200);
  const matches = observations.filter((record) => {
    const text = `${record.content?.title ?? ""}\n${record.content?.text ?? ""}`;
    return text.toLowerCase().includes(claim.toLowerCase().slice(0, 40));
  });

  const recordIds = matches.map((record) => record.id);

  return {
    ok: true,
    view_type: "ambient.result",
    intent_name: "check_or_cite_fact",
    confidence: 0.85,
    content: {
      claim,
      match_count: matches.length,
      top_records: matches.slice(0, 5).map((record) => ({
        id: record.id,
        title: record.content?.title ?? record.id,
      })),
    },
    source_observations: recordIds,
    diagnostics: { records_scanned: observations.length, match_count: matches.length },
  };
}

export async function handleProjectContext(input: AmbientIntentInput): Promise<AmbientIntentResult> {
  const project = input.store.getRuntimeState("active_thread")?.value;
  const observations = input.store.recent(50, { project_path: typeof project?.project_path === "string" ? project.project_path : undefined });

  return {
    ok: true,
    view_type: "ambient.result",
    intent_name: "project_context",
    confidence: 0.88,
    content: {
      active_thread: project ?? null,
      recent_observations: observations.map((record) => ({
        id: record.id,
        title: record.content?.title ?? record.id,
      })),
    },
    source_observations: observations.map((record) => record.id),
    diagnostics: { records_scanned: observations.length, project_path: project?.project_path },
  };
}

// ======================================================================
// Default Processor Instances
// ======================================================================

export function createDefaultAmbientProcessors(): AmbientIntentProcessor[] {
  return [
    {
      id: "ambient.attach_local_file",
      title: "Attach Local File",
      intentName: "attach_local_file",
      speed: "glance",
      handler: handleAttachLocalFile,
    },
    {
      id: "ambient.check_or_cite_fact",
      title: "Check or Cite Fact",
      intentName: "check_or_cite_fact",
      speed: "think",
      handler: handleCheckOrCiteFact,
    },
    {
      id: "ambient.project_context",
      title: "Project Context",
      intentName: "project_context",
      speed: "glance",
      handler: handleProjectContext,
    },
  ];
}
