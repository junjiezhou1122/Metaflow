import { createHash, type Hash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { CaptureRuntimeError } from "@info/capture";
import {
  CodexSafeRecordSchema,
  emptyCodexExcludedRecordCounts,
  type CodexExclusionCategory,
  type CodexHistoryConfiguration,
  type CodexSafeRecord,
} from "./contracts.js";
import { assertCodexContentSafe, type CodexContentGate } from "./secret-gate.js";

const OUTER_KEYS = new Set(["type", "timestamp", "ordinal", "payload"]);
const SESSION_META_KEYS = new Set([
  "session_id", "id", "timestamp", "cwd", "originator", "cli_version", "source", "thread_source",
  "model_provider", "base_instructions", "dynamic_tools", "forked_from_id", "parent_thread_id",
  "agent_nickname", "agent_role", "agent_type", "agent_path", "selected_capability_roots", "memory_mode",
  "history_mode", "history_base", "subagent_history_start_ordinal", "multi_agent_version", "context_window", "git",
]);
const GIT_INFO_KEYS = new Set(["commit_hash", "branch", "repository_url"]);
const HISTORY_POSITION_KEYS = new Set(["thread_id", "end_ordinal_exclusive", "end_byte_offset"]);
const SESSION_CONTEXT_WINDOW_KEYS = new Set(["window_id"]);
const SESSION_SOURCE_KEYS = new Set(["custom", "internal", "subagent"]);
const SUBAGENT_SOURCE_KEYS = new Set(["thread_spawn", "other"]);
const SUBAGENT_THREAD_SPAWN_KEYS = new Set([
  "parent_thread_id", "depth", "agent_path", "agent_nickname", "agent_role", "agent_type",
]);
const TURN_CONTEXT_KEYS = new Set([
  "turn_id", "cwd", "workspace_roots", "current_date", "timezone", "approval_policy", "sandbox_policy",
  "permission_profile", "model", "personality", "collaboration_mode", "multi_agent_version", "realtime_active",
  "approvals_reviewer", "network", "file_system_sandbox_policy", "comp_hash", "multi_agent_mode", "effort", "summary",
]);
const TURN_CONTEXT_NETWORK_KEYS = new Set(["allowed_domains", "denied_domains"]);
const MESSAGE_KEYS = new Set(["type", "id", "role", "content", "phase", "internal_chat_message_metadata_passthrough"]);
const TEXT_PART_KEYS = new Set(["type", "text"]);
const IMAGE_PART_KEYS = new Set(["type", "image_url", "detail"]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const RESPONSE_EXCLUSIONS: Readonly<Record<string, CodexExclusionCategory>> = {
  reasoning: "reasoning",
  function_call: "tool_call",
  custom_tool_call: "tool_call",
  web_search_call: "tool_call",
  tool_search_call: "tool_call",
  function_call_output: "tool_result",
  custom_tool_call_output: "tool_result",
  tool_search_output: "tool_result",
  agent_message: "event_duplicate",
};

const EVENT_EXCLUSIONS: Readonly<Record<string, CodexExclusionCategory>> = {
  user_message: "event_duplicate",
  agent_message: "event_duplicate",
  agent_reasoning: "reasoning",
  token_count: "token_or_rate_metadata",
  task_started: "instruction_or_context",
  task_complete: "instruction_or_context",
  turn_aborted: "instruction_or_context",
  thread_settings_applied: "instruction_or_context",
  thread_goal_updated: "instruction_or_context",
  sub_agent_activity: "instruction_or_context",
  context_compacted: "compaction",
  entered_review_mode: "instruction_or_context",
  exited_review_mode: "instruction_or_context",
  mcp_tool_call_end: "tool_result",
  patch_apply_end: "tool_result",
  web_search_end: "tool_result",
};

export type ParsedLineOutcome = {
  record?: CodexSafeRecord;
  exclusions: Partial<Record<CodexExclusionCategory, number>>;
  turn_id?: string;
  session_id?: string;
  history_parent_id?: string;
};

export type RolloutLine = {
  byte_offset: number;
  byte_length: number;
  bytes: Buffer;
  through_offset: number;
};

export async function openCodexRollout(path: string): Promise<FileHandle> {
  try {
    return await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isErrorCode(error, "ELOOP")) {
      throw new CaptureRuntimeError(
        "Symbolic links are forbidden for Codex rollout files",
        "codex_source_symlink_forbidden",
        "connector",
        false,
        {},
      );
    }
    throw new CaptureRuntimeError(
      "Codex rollout could not be opened without following links",
      "codex_source_open_failed",
      "connector",
      true,
      {},
    );
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export async function* readCompleteRolloutLines(input: {
  handle: FileHandle;
  start: number;
  end: number;
  max_record_bytes: number;
}): AsyncGenerator<RolloutLine> {
  const chunkSize = 64 * 1024;
  let position = input.start;
  let pending = Buffer.alloc(0);
  let pendingOffset = input.start;
  while (position < input.end) {
    const length = Math.min(chunkSize, input.end - position);
    const chunk = Buffer.allocUnsafe(length);
    const { bytesRead } = await input.handle.read(chunk, 0, length, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    pending = pending.length === 0 ? chunk.subarray(0, bytesRead) : Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
    let newline = pending.indexOf(0x0a);
    while (newline >= 0) {
      const bytes = pending.subarray(0, newline);
      if (bytes.length === 0 || bytes.length > input.max_record_bytes) {
        throw sourceContractError("Codex rollout record has an invalid byte length", pendingOffset, {
          byte_length: bytes.length,
          max_record_bytes: input.max_record_bytes,
        });
      }
      const throughOffset = pendingOffset + newline + 1;
      yield { byte_offset: pendingOffset, byte_length: bytes.length, bytes, through_offset: throughOffset };
      pending = pending.subarray(newline + 1);
      pendingOffset = throughOffset;
      newline = pending.indexOf(0x0a);
    }
    if (pending.length > input.max_record_bytes) {
      throw sourceContractError("Codex rollout record exceeds the configured byte limit", pendingOffset, {
        max_record_bytes: input.max_record_bytes,
      });
    }
  }
}

export async function inspectFirstSessionMetadata(input: {
  handle: FileHandle;
  observed_size: number;
  configuration: CodexHistoryConfiguration;
}): Promise<{ session_id: string; record: CodexSafeRecord } | undefined> {
  for await (const line of readCompleteRolloutLines({
    handle: input.handle,
    start: 0,
    end: input.observed_size,
    max_record_bytes: input.configuration.max_record_bytes,
  })) {
    const outcome = parseCodexRolloutLine({ line });
    if (outcome.record?.kind !== "session_meta" || !outcome.session_id) {
      throw sourceContractError("Codex rollout must begin with session metadata", line.byte_offset);
    }
    return { session_id: outcome.session_id, record: outcome.record };
  }
  return undefined;
}

export async function verifyCommittedPrefix(input: {
  handle: FileHandle;
  committed_offset: number;
  expected_sha256: string;
  expected_session_id: string;
  configuration: CodexHistoryConfiguration;
}): Promise<{ hash: Hash; turn_id?: string; history_thread_ids: string[] }> {
  const hash = createHash("sha256");
  let throughOffset = 0;
  let turnId: string | undefined;
  const historyThreadIds = new Set<string>();
  let sawSession = false;
  for await (const line of readCompleteRolloutLines({
    handle: input.handle,
    start: 0,
    end: input.committed_offset,
    max_record_bytes: input.configuration.max_record_bytes,
  })) {
    hash.update(line.bytes).update("\n");
    throughOffset = line.through_offset;
    const outcome = parseCodexRolloutLine({
      line,
      expected_session_id: input.expected_session_id,
      current_turn_id: turnId,
      allowed_history_thread_ids: historyThreadIds,
    });
    if (outcome.session_id) sawSession = true;
    if (outcome.turn_id !== undefined) turnId = outcome.turn_id;
    if (outcome.history_parent_id !== undefined) historyThreadIds.add(outcome.history_parent_id);
  }
  if (throughOffset !== input.committed_offset || (input.committed_offset > 0 && !sawSession)) {
    throw sourceContractError("Codex checkpoint does not end on a complete record", input.committed_offset);
  }
  const actual = hash.copy().digest("hex");
  if (actual !== input.expected_sha256) {
    throw new CaptureRuntimeError(
      "Codex rollout committed prefix was rewritten",
      "codex_append_history_rewritten",
      "connector",
      false,
      {
        session_id: input.expected_session_id,
        committed_offset: input.committed_offset,
        expected_prefix_sha256: input.expected_sha256,
        actual_prefix_sha256: actual,
      },
    );
  }
  return {
    hash,
    ...(turnId ? { turn_id: turnId } : {}),
    history_thread_ids: [...historyThreadIds].sort(),
  };
}

export async function parseAndGateCodexRolloutLine(input: {
  line: RolloutLine;
  expected_session_id: string;
  current_turn_id?: string;
  allowed_history_thread_ids?: ReadonlySet<string>;
  gate: CodexContentGate;
}): Promise<ParsedLineOutcome> {
  const outcome = parseCodexRolloutLine(input);
  if (!outcome.record) return outcome;
  const texts: string[] = outcome.record.kind === "session_meta"
    ? [
        outcome.record.timestamp,
        outcome.record.session_id,
        outcome.record.source,
        outcome.record.originator,
        outcome.record.cli_version,
        ...(outcome.record.model_provider ? [outcome.record.model_provider] : []),
        outcome.record.workspace_path,
      ]
    : [
        outcome.record.timestamp,
        outcome.record.session_id,
        ...(outcome.record.turn_id ? [outcome.record.turn_id] : []),
        outcome.record.role,
        ...outcome.record.text_parts,
      ];
  if (outcome.record.kind === "message" && outcome.record.text_parts.length > 1) {
    texts.push(outcome.record.text_parts.join(""), outcome.record.text_parts.join("\n"));
  }
  await assertCodexContentSafe({
    gate: input.gate,
    texts,
    session_id: input.expected_session_id,
    byte_offset: input.line.byte_offset,
    record_sha256: outcome.record.record_sha256,
  });
  return outcome;
}

export function parseCodexRolloutLine(input: {
  line: RolloutLine;
  expected_session_id?: string;
  current_turn_id?: string;
  allowed_history_thread_ids?: ReadonlySet<string>;
}): ParsedLineOutcome {
  let value: unknown;
  try {
    value = JSON.parse(UTF8_DECODER.decode(input.line.bytes));
  } catch {
    throw sourceContractError("Codex rollout contains invalid JSON before its partial tail", input.line.byte_offset);
  }
  const envelope = requireObject(value, input.line.byte_offset, "rollout envelope");
  assertKnownKeys(envelope, OUTER_KEYS, input.line.byte_offset, "rollout envelope");
  const outerType = requireString(envelope.type, input.line.byte_offset, "envelope type");
  const timestamp = requireTimestamp(envelope.timestamp, input.line.byte_offset);
  if (envelope.ordinal !== undefined) requireNonnegativeInteger(envelope.ordinal, input.line.byte_offset, "rollout ordinal");
  const payload = requireObject(envelope.payload, input.line.byte_offset, `${outerType} payload`);
  const recordSha256 = createHash("sha256").update(input.line.bytes).digest("hex");

  if (outerType === "session_meta") {
    assertKnownKeys(payload, SESSION_META_KEYS, input.line.byte_offset, "session metadata");
    const threadId = requireString(payload.id, input.line.byte_offset, "session metadata id");
    if (payload.session_id !== undefined) requireString(payload.session_id, input.line.byte_offset, "session id");
    requireTimestamp(payload.timestamp, input.line.byte_offset);
    validateOptionalSessionContext(payload, input.line.byte_offset);
    const source = normalizeSessionSource(payload.source, input.line.byte_offset);
    const declaredForkedFromId = payload.forked_from_id === undefined
      ? undefined
      : requireString(payload.forked_from_id, input.line.byte_offset, "forked session id");
    if (payload.multi_agent_version !== undefined) requireString(payload.multi_agent_version, input.line.byte_offset, "multi-agent version");
    if (input.expected_session_id && input.expected_session_id !== threadId) {
      if (input.allowed_history_thread_ids?.has(threadId)) {
        return {
          exclusions: { instruction_or_context: 1 },
          ...(declaredForkedFromId ? { history_parent_id: declaredForkedFromId } : {}),
        };
      }
      throw sourceContractError("Codex rollout changed session identity", input.line.byte_offset, {
        expected_session_id: input.expected_session_id,
      });
    }
    if (input.expected_session_id && input.line.byte_offset > 0) {
      return {
        exclusions: { instruction_or_context: 1 },
        ...(declaredForkedFromId ? { history_parent_id: declaredForkedFromId } : {}),
      };
    }
    const record = parseSafeRecord({
      kind: "session_meta",
      byte_offset: input.line.byte_offset,
      byte_length: input.line.byte_length,
      record_sha256: recordSha256,
      timestamp,
      session_id: threadId,
      source,
      originator: requireString(payload.originator, input.line.byte_offset, "session originator"),
      cli_version: requireString(payload.cli_version, input.line.byte_offset, "CLI version"),
      ...(payload.model_provider === undefined || payload.model_provider === null
        ? {}
        : { model_provider: requireString(payload.model_provider, input.line.byte_offset, "model provider") }),
      workspace_path: requireString(payload.cwd, input.line.byte_offset, "workspace path"),
    }, input.line.byte_offset);
    return {
      record,
      exclusions: { instruction_or_context: 1 },
      session_id: threadId,
      ...(declaredForkedFromId ? { history_parent_id: declaredForkedFromId } : {}),
    };
  }

  if (outerType === "turn_context") {
    assertKnownKeys(payload, TURN_CONTEXT_KEYS, input.line.byte_offset, "turn context");
    validateOptionalTurnContext(payload, input.line.byte_offset);
    const turnId = payload.turn_id === undefined || payload.turn_id === null
      ? undefined
      : requireString(payload.turn_id, input.line.byte_offset, "turn id");
    return { exclusions: { instruction_or_context: 1 }, ...(turnId ? { turn_id: turnId } : {}) };
  }

  if (outerType === "response_item") {
    const responseType = requireString(payload.type, input.line.byte_offset, "response item type");
    if (responseType !== "message") {
      const category = RESPONSE_EXCLUSIONS[responseType];
      if (!category) throw sourceContractError("Codex response item type is not in the parser contract", input.line.byte_offset);
      return { exclusions: { [category]: 1 } };
    }
    assertKnownKeys(payload, MESSAGE_KEYS, input.line.byte_offset, "message");
    const role = requireString(payload.role, input.line.byte_offset, "message role");
    if (!["user", "assistant", "developer", "system"].includes(role)) {
      throw sourceContractError("Codex message role is not in the parser contract", input.line.byte_offset);
    }
    if (!Array.isArray(payload.content)) throw sourceContractError("Codex message content must be an array", input.line.byte_offset);
    if (payload.content.length === 0) throw sourceContractError("Codex message content cannot be empty", input.line.byte_offset);
    const textParts: string[] = [];
    let omitted = 0;
    for (const partValue of payload.content) {
      const part = requireObject(partValue, input.line.byte_offset, "message content part");
      const partType = requireString(part.type, input.line.byte_offset, "message content type");
      if (partType === "input_image") {
        assertKnownKeys(part, IMAGE_PART_KEYS, input.line.byte_offset, "image content part");
        requireString(part.image_url, input.line.byte_offset, "image URL");
        if (part.detail !== undefined) requireString(part.detail, input.line.byte_offset, "image detail");
        omitted += 1;
        continue;
      }
      if (partType !== "input_text" && partType !== "output_text") {
        throw sourceContractError("Codex message content type is not in the parser contract", input.line.byte_offset);
      }
      assertKnownKeys(part, TEXT_PART_KEYS, input.line.byte_offset, "text content part");
      if ((role === "assistant" && partType !== "output_text") || (role !== "assistant" && partType !== "input_text")) {
        throw sourceContractError("Codex message role and text content type disagree", input.line.byte_offset);
      }
      textParts.push(requireStringAllowEmpty(part.text, input.line.byte_offset, "message text"));
    }
    if (role === "developer" || role === "system") {
      return { exclusions: { developer_or_system_message: 1, ...(omitted > 0 ? { image_or_attachment: omitted } : {}) } };
    }
    if (textParts.length === 0) return { exclusions: { image_or_attachment: Math.max(1, omitted) } };
    const record = parseSafeRecord({
      kind: "message",
      byte_offset: input.line.byte_offset,
      byte_length: input.line.byte_length,
      record_sha256: recordSha256,
      timestamp,
      session_id: input.expected_session_id,
      ...(input.current_turn_id ? { turn_id: input.current_turn_id } : {}),
      role,
      text_parts: textParts,
      omitted_non_text_parts: omitted,
    }, input.line.byte_offset);
    return { record, exclusions: omitted > 0 ? { image_or_attachment: omitted } : {} };
  }

  if (outerType === "event_msg") {
    const eventType = requireString(payload.type, input.line.byte_offset, "event type");
    const category = EVENT_EXCLUSIONS[eventType];
    if (!category) throw sourceContractError("Codex event type is not in the parser contract", input.line.byte_offset);
    return { exclusions: { [category]: 1 } };
  }
  if (outerType === "world_state") return { exclusions: { world_state: 1 } };
  if (outerType === "compacted") return { exclusions: { compaction: 1 } };
  if (outerType === "inter_agent_communication_metadata") return { exclusions: { instruction_or_context: 1 } };
  throw sourceContractError("Codex rollout envelope type is not in the parser contract", input.line.byte_offset);
}

function normalizeSessionSource(value: unknown, byteOffset: number): string {
  if (value === undefined) return "vscode";
  if (typeof value === "string") {
    const source = requireString(value, byteOffset, "session source");
    return source.length <= 120 ? source : "unknown";
  }
  const source = requireObject(value, byteOffset, "session source");
  assertExactlyOneKnownKey(source, SESSION_SOURCE_KEYS, byteOffset, "session source");
  if ("custom" in source) {
    const custom = requireString(source.custom, byteOffset, "custom session source");
    return custom.length <= 120 ? custom : "custom";
  }
  if ("internal" in source) {
    if (source.internal !== "memory_consolidation") {
      throw sourceContractError("Codex internal session source is not in the parser contract", byteOffset);
    }
    return "internal_memory_consolidation";
  }
  return normalizeSubagentSource(source.subagent, byteOffset);
}

function normalizeSubagentSource(value: unknown, byteOffset: number): string {
  if (typeof value === "string") {
    if (!["review", "compact", "memory_consolidation"].includes(value)) {
      throw sourceContractError("Codex subagent session source is not in the parser contract", byteOffset);
    }
    return `subagent_${value}`;
  }
  const source = requireObject(value, byteOffset, "subagent session source");
  assertExactlyOneKnownKey(source, SUBAGENT_SOURCE_KEYS, byteOffset, "subagent session source");
  if ("other" in source) {
    requireString(source.other, byteOffset, "other subagent source");
    return "subagent_other";
  }
  const threadSpawn = requireObject(source.thread_spawn, byteOffset, "thread-spawn session source");
  assertKnownKeys(threadSpawn, SUBAGENT_THREAD_SPAWN_KEYS, byteOffset, "thread-spawn session source");
  requireString(threadSpawn.parent_thread_id, byteOffset, "thread-spawn parent thread id");
  requireIntegerInRange(threadSpawn.depth, -(2 ** 31), 2 ** 31 - 1, byteOffset, "thread-spawn depth");
  for (const [key, label] of [
    ["agent_path", "thread-spawn agent path"],
    ["agent_nickname", "thread-spawn agent nickname"],
    ["agent_role", "thread-spawn agent role"],
    ["agent_type", "thread-spawn legacy agent type"],
  ] as const) {
    if (threadSpawn[key] !== undefined && threadSpawn[key] !== null) {
      requireString(threadSpawn[key], byteOffset, label);
    }
  }
  if (threadSpawn.agent_role !== undefined && threadSpawn.agent_type !== undefined) {
    throw sourceContractError("Codex thread-spawn source cannot contain both agent_role and agent_type", byteOffset);
  }
  return "subagent_thread_spawn";
}

function assertExactlyOneKnownKey(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  byteOffset: number,
  label: string,
): void {
  assertKnownKeys(value, allowed, byteOffset, label);
  if (Object.keys(value).length !== 1) {
    throw sourceContractError(`Codex ${label} must contain exactly one variant`, byteOffset);
  }
}

function validateOptionalSessionContext(payload: Record<string, unknown>, byteOffset: number): void {
  for (const [key, label] of [
    ["thread_source", "thread source"],
    ["parent_thread_id", "parent thread id"],
    ["agent_nickname", "agent nickname"],
    ["agent_role", "agent role"],
    ["agent_type", "agent type"],
    ["agent_path", "agent path"],
    ["memory_mode", "memory mode"],
    ["multi_agent_version", "multi-agent version"],
  ] as const) {
    if (payload[key] !== undefined && payload[key] !== null) requireString(payload[key], byteOffset, label);
  }
  if (payload.agent_role !== undefined && payload.agent_type !== undefined) {
    throw sourceContractError("Codex session metadata cannot contain both agent_role and agent_type", byteOffset);
  }
  if (payload.base_instructions !== undefined && payload.base_instructions !== null) {
    requireObject(payload.base_instructions, byteOffset, "base instructions");
  }
  if (payload.dynamic_tools !== undefined && payload.dynamic_tools !== null && !Array.isArray(payload.dynamic_tools)) {
    throw sourceContractError("Codex dynamic_tools must be an array", byteOffset);
  }
  if (payload.selected_capability_roots !== undefined && !Array.isArray(payload.selected_capability_roots)) {
    throw sourceContractError("Codex selected_capability_roots must be an array", byteOffset);
  }
  if (payload.history_mode !== undefined && !["legacy", "paginated"].includes(requireString(payload.history_mode, byteOffset, "history mode"))) {
    throw sourceContractError("Codex history_mode is not in the parser contract", byteOffset);
  }
  if (payload.subagent_history_start_ordinal !== undefined) {
    requireNonnegativeInteger(payload.subagent_history_start_ordinal, byteOffset, "subagent history start ordinal");
  }
  validateExactOptionalObject(payload.history_base, HISTORY_POSITION_KEYS, byteOffset, "history base", value => {
    requireString(value.thread_id, byteOffset, "history base thread id");
    requireNonnegativeInteger(value.end_ordinal_exclusive, byteOffset, "history base end ordinal");
    requireNonnegativeInteger(value.end_byte_offset, byteOffset, "history base end byte offset");
  });
  validateExactOptionalObject(payload.context_window, SESSION_CONTEXT_WINDOW_KEYS, byteOffset, "context window", value => {
    requireString(value.window_id, byteOffset, "context window id");
  });
  validateExactOptionalObject(payload.git, GIT_INFO_KEYS, byteOffset, "git metadata", value => {
    for (const [key, label] of [
      ["commit_hash", "git commit hash"],
      ["branch", "git branch"],
      ["repository_url", "git repository URL"],
    ] as const) {
      if (value[key] !== undefined && value[key] !== null) requireString(value[key], byteOffset, label);
    }
  });
}

function validateOptionalTurnContext(payload: Record<string, unknown>, byteOffset: number): void {
  for (const [key, label] of [
    ["cwd", "turn context cwd"],
    ["current_date", "turn context current date"],
    ["timezone", "turn context timezone"],
    ["approval_policy", "turn context approval policy"],
    ["approvals_reviewer", "turn context approvals reviewer"],
    ["model", "turn context model"],
    ["comp_hash", "turn context comp hash"],
    ["personality", "turn context personality"],
    ["multi_agent_mode", "turn context multi-agent mode"],
    ["effort", "turn context effort"],
    ["summary", "turn context summary"],
  ] as const) {
    if (payload[key] !== undefined && payload[key] !== null) requireString(payload[key], byteOffset, label);
  }
  if (payload.workspace_roots !== undefined && payload.workspace_roots !== null) {
    requireStringArray(payload.workspace_roots, byteOffset, "turn context workspace roots");
  }
  for (const [key, label] of [
    ["sandbox_policy", "turn context sandbox policy"],
    ["permission_profile", "turn context permission profile"],
    ["file_system_sandbox_policy", "turn context file-system sandbox policy"],
    ["collaboration_mode", "turn context collaboration mode"],
  ] as const) {
    if (payload[key] !== undefined && payload[key] !== null) requireObject(payload[key], byteOffset, label);
  }
  if (payload.multi_agent_version !== undefined && payload.multi_agent_version !== null) {
    const version = requireString(payload.multi_agent_version, byteOffset, "turn context multi-agent version");
    if (!["disabled", "v1", "v2"].includes(version)) {
      throw sourceContractError("Codex turn context multi-agent version is not in the parser contract", byteOffset);
    }
  }
  if (payload.realtime_active !== undefined && payload.realtime_active !== null && typeof payload.realtime_active !== "boolean") {
    throw sourceContractError("Codex turn context realtime_active must be boolean", byteOffset);
  }
  if (payload.network !== undefined && payload.network !== null) {
    const network = requireObject(payload.network, byteOffset, "turn context network");
    assertKnownKeys(network, TURN_CONTEXT_NETWORK_KEYS, byteOffset, "turn context network");
    requireStringArray(network.allowed_domains, byteOffset, "turn context allowed domains");
    requireStringArray(network.denied_domains, byteOffset, "turn context denied domains");
  }
}

function requireStringArray(value: unknown, byteOffset: number, label: string): string[] {
  if (!Array.isArray(value)) throw sourceContractError(`Codex ${label} must be an array`, byteOffset);
  return value.map(item => requireString(item, byteOffset, label));
}

function validateExactOptionalObject(
  value: unknown,
  keys: ReadonlySet<string>,
  byteOffset: number,
  label: string,
  validate: (value: Record<string, unknown>) => void,
): void {
  if (value === undefined || value === null) return;
  const object = requireObject(value, byteOffset, label);
  assertKnownKeys(object, keys, byteOffset, label);
  validate(object);
}

function requireNonnegativeInteger(value: unknown, byteOffset: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw sourceContractError(`Codex ${label} must be a nonnegative safe integer`, byteOffset);
  }
  return value as number;
}

function requireIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  byteOffset: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw sourceContractError(`Codex ${label} must be an integer between ${minimum} and ${maximum}`, byteOffset);
  }
  return value as number;
}

export function applyExclusions(
  target: ReturnType<typeof emptyCodexExcludedRecordCounts>,
  additions: Partial<Record<CodexExclusionCategory, number>>,
): void {
  for (const [category, count] of Object.entries(additions) as Array<[CodexExclusionCategory, number]>) {
    target[category] += count;
  }
}

function requireObject(value: unknown, byteOffset: number, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw sourceContractError(`Codex ${label} must be an object`, byteOffset);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, byteOffset: number, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw sourceContractError(`Codex ${label} must be a non-empty string`, byteOffset);
  return value;
}

function requireStringAllowEmpty(value: unknown, byteOffset: number, label: string): string {
  if (typeof value !== "string") throw sourceContractError(`Codex ${label} must be a string`, byteOffset);
  return value;
}

function requireTimestamp(value: unknown, byteOffset: number): string {
  const timestamp = requireString(value, byteOffset, "timestamp");
  if (!Number.isFinite(Date.parse(timestamp))) throw sourceContractError("Codex timestamp is invalid", byteOffset);
  return timestamp;
}

function assertKnownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, byteOffset: number, label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) {
    throw sourceContractError(`Codex ${label} contains fields outside the parser contract`, byteOffset, {
      unknown_field_count: unknown.length,
    });
  }
}

function parseSafeRecord(value: unknown, byteOffset: number): CodexSafeRecord {
  const parsed = CodexSafeRecordSchema.safeParse(value);
  if (!parsed.success) {
    throw sourceContractError("Codex safe record failed its exact parser contract", byteOffset, {
      issue_count: parsed.error.issues.length,
    });
  }
  return parsed.data;
}

function sourceContractError(message: string, byteOffset: number, details: Record<string, string | number> = {}): CaptureRuntimeError {
  return new CaptureRuntimeError(
    message,
    "codex_source_contract_incompatible",
    "connector",
    false,
    { byte_offset: byteOffset, ...details },
  );
}
