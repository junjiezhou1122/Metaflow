import type { ContextView, StoredContextView } from "@info/core";

export type MemoryCandidateKind =
  | "preference"
  | "workflow_pattern"
  | "skill_gap"
  | "agent_collaboration_style"
  | "project_memory"
  | "agent_case";

export type DurableMemoryViewType =
  | "memory.preferences"
  | "memory.workflow_patterns"
  | "memory.skill_gaps"
  | "memory.agent_collaboration_style"
  | "project.memory"
  | "agent.case_memory";

export type MemoryPromotionPolicy = {
  min_confidence: number;
  min_evidence_count: number;
  allow_manual_promote: boolean;
  require_privacy_check: boolean;
};

export type MemoryCandidateContent = {
  memory_kind: MemoryCandidateKind;
  target_view_type: DurableMemoryViewType;
  claim: string;
  confidence: number;
  evidence_count: number;
  proposed_scope?: Record<string, unknown>;
  promotion_policy: MemoryPromotionPolicy;
  gate_status?: "candidate" | "promoted" | "held" | "rejected";
  durable_view_id?: string;
  rejection_reason?: string;
};

export type MemoryGateDecision =
  | { action: "promote"; candidate_id: string; target_view_type: DurableMemoryViewType; confidence: number }
  | { action: "merge"; candidate_id: string; target_view_id: string; confidence: number }
  | { action: "hold"; candidate_id: string; reason: string }
  | { action: "reject"; candidate_id: string; reason: string };

export type MemoryQuery = {
  query?: string;
  view_types?: DurableMemoryViewType[];
  project_path?: string;
  limit?: number;
};

export type MemoryResult = {
  view: StoredContextView;
  score?: number;
  match?: string;
};

export type MemoryPatch = {
  status?: ContextView["status"];
  content?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type MemoryTrace = {
  memory_id: string;
  source_records: string[];
  source_views: string[];
  supersedes?: string[];
  superseded_by?: string[];
};

export interface MemoryBackend {
  writeMemory(view: ContextView): Promise<void>;
  searchMemory(query: MemoryQuery): Promise<MemoryResult[]>;
  updateMemory(id: string, patch: MemoryPatch): Promise<void>;
  traceMemory(id: string): Promise<MemoryTrace>;
}

export const MEMORY_CANDIDATE_VIEW_TYPE = "memory.candidate";
export const MEMORY_CANDIDATE_COMPILER_ID = "processor.memory_candidate";
export const MEMORY_GATE_COMPILER_ID = "processor.memory_gate";

