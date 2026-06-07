import type { ContextRecord, ContextView, RuntimeEvent, StoredContextRecord, StoredContextView } from "@info/core";
import type { ContextBrokerPack, ContextQuery } from "@info/core";
import type { ContextStore } from "@info/core";

export type SpeedTier = "reflex" | "glance" | "think" | "work" | "background";

export type AutonomyProfile = "manual" | "suggest" | "draft" | "sandbox_auto" | "full_auto";

export type ContextSignal = {
  object_id: string;
  object_kind: "observation" | "view";
  object_type: string;
  source?: string;
  connector?: string;
  title?: string;
  text_preview?: string;
  url?: string;
  path?: string;
  domain?: string;
  app?: string;
  project?: string;
  project_path?: string;
  repo?: string;
  language?: string;
  keywords?: string[];
  topics?: string[];
  produced_by?: string;
  source_records?: string[];
  source_views?: string[];
  observed_at?: string;
  created_at?: string;
  privacy_level?: string;
  confidence?: number;
  importance?: number;
};

export type AttentionInfluence = {
  kind: string;
  view_id?: string;
  preference?: string;
  target_view_type?: string;
};

type AttentionDecisionBase = {
  reason?: string;
  confidence?: number;
  attention_influences?: AttentionInfluence[];
};

export type AttentionDecision =
  | (AttentionDecisionBase & { action: "ignore" })
  | (AttentionDecisionBase & { action: "defer"; reason: string; until?: string })
  | (AttentionDecisionBase & { action: "attach"; reason: string; confidence: number; view?: ContextView })
  | (AttentionDecisionBase & { action: "run"; reason: string; confidence: number; capability_ids?: string[]; speed?: SpeedTier });

export type ProgramRunInput = {
  program: Program;
  signal: ContextSignal;
  store: ContextStore;
  speed?: SpeedTier;
  autonomy?: AutonomyProfile;
  context_plugin_id?: string;
  buildContextPack(query?: ContextQuery): ContextBrokerPack;
  runCapability(capabilityId: string, input?: { signal?: ContextSignal; speed?: SpeedTier; autonomy?: AutonomyProfile; dry_run?: boolean; payload?: Record<string, unknown> }): Promise<CapabilityRunResult & { written_records?: string[]; written_views?: string[] }>;
};

export type CapabilityRunInput = {
  capability: Capability;
  program?: Program;
  signal: ContextSignal;
  store: ContextStore;
  speed?: SpeedTier;
  autonomy?: AutonomyProfile;
  context_plugin_id?: string;
  dry_run?: boolean;
  payload?: Record<string, unknown>;
};

export type ContextWriteSet = {
  records?: ContextRecord[];
  views?: ContextView[];
  events?: RuntimeEvent[];
};

export type ProgramRunResult = ContextWriteSet & {
  ok: boolean;
  reason?: string;
  diagnostics?: Record<string, unknown>;
};

export type CapabilityRunResult = ContextWriteSet & {
  ok: boolean;
  reason?: string;
  diagnostics?: Record<string, unknown>;
};

export type ProgramDefinition = {
  id: string;
  title: string;
  purpose: string;
  version?: string;
  default_speed?: SpeedTier;
  default_autonomy?: AutonomyProfile;
  produces?: string[];
  capabilities?: string[];
  applications?: string[];
  learns_from?: string[];
};

export type Program = ProgramDefinition & {
  attention(signal: ContextSignal, store: ContextStore): AttentionDecision | Promise<AttentionDecision>;
  run(input: ProgramRunInput): ProgramRunResult | Promise<ProgramRunResult>;
};

export type CapabilityDefinition = {
  id: string;
  title: string;
  purpose: string;
  version?: string;
  mode: "deterministic" | "llm" | "agent" | "external";
  default_speed?: SpeedTier;
  default_autonomy?: AutonomyProfile;
  produces?: string[];
};

export type Capability = CapabilityDefinition & {
  run(input: CapabilityRunInput): CapabilityRunResult | Promise<CapabilityRunResult>;
};

export type ProgramRegistry = {
  programs: Program[];
  capabilities: Capability[];
};

export type StoredContextObject = StoredContextRecord | StoredContextView;
