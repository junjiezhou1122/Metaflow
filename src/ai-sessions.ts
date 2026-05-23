import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { StoredContextRecord } from "./types.js";

export type AiSessionTool = "codex" | "claude-code";

export type AiSessionLocateRequest = {
  project_path: string;
  start_time?: string;
  end_time?: string;
  minutes?: number;
  tools?: AiSessionTool[];
  limit?: number;
  include_snippets?: boolean;
};

export type AiSessionRef = {
  tool: AiSessionTool;
  session_id: string;
  title?: string;
  project_path?: string;
  cwd?: string;
  git_branch?: string;
  started_at?: string;
  ended_at?: string;
  last_activity_at?: string;
  message_count: number;
  user_message_count: number;
  assistant_message_count: number;
  tool_call_count: number;
  files_touched: string[];
  commands_run: string[];
  source_uri: string;
  source_path: string;
  source_kind: "jsonl";
  transcript_format: string;
  confidence: number;
  reasons: string[];
  snippets?: string[];
  privacy: {
    level: "private";
    raw_transcript_imported: false;
  };
};

export type AiSessionLocateResult = {
  ok: true;
  project_path: string;
  time_window: { start_time?: string; end_time?: string; minutes?: number };
  sessions: AiSessionRef[];
  diagnostics: Record<string, unknown>;
};

const MAX_FILE_BYTES = 8_000_000;
const MAX_LINES = 4000;

export function locateAiSessions(req: AiSessionLocateRequest): AiSessionLocateResult {
  const projectPath = resolve(req.project_path);
  const timeWindow = normalizeTimeWindow(req);
  const tools = req.tools ?? ["codex", "claude-code"];
  const sessions: AiSessionRef[] = [];
  const diagnostics: Record<string, unknown> = {};

  if (tools.includes("claude-code")) {
    const claude = locateClaudeSessions(projectPath, timeWindow, Boolean(req.include_snippets));
    sessions.push(...claude.sessions);
    diagnostics.claude = claude.diagnostics;
  }

  if (tools.includes("codex")) {
    const codex = locateCodexSessions(projectPath, timeWindow, Boolean(req.include_snippets));
    sessions.push(...codex.sessions);
    diagnostics.codex = codex.diagnostics;
  }

  const ranked = sessions
    .filter(s => s.confidence >= 0.45)
    .sort((a, b) => b.confidence - a.confidence || Date.parse(b.last_activity_at ?? b.ended_at ?? "") - Date.parse(a.last_activity_at ?? a.ended_at ?? ""))
    .slice(0, req.limit ?? 12);

  return { ok: true, project_path: projectPath, time_window: timeWindow, sessions: ranked, diagnostics };
}

export function aiSessionRefToRecord(session: AiSessionRef): StoredContextRecord {
  const now = new Date().toISOString();
  const text = [
    `${session.tool} session ${session.session_id}`,
    session.title ? `title: ${session.title}` : undefined,
    session.cwd ? `cwd: ${session.cwd}` : undefined,
    session.started_at || session.ended_at ? `time: ${session.started_at ?? "..."} → ${session.ended_at ?? "..."}` : undefined,
    `messages: ${session.message_count}, tool calls: ${session.tool_call_count}`,
    session.files_touched.length ? `files touched:\n${session.files_touched.slice(0, 20).join("\n")}` : undefined,
    session.commands_run.length ? `commands:\n${session.commands_run.slice(0, 12).join("\n")}` : undefined,
    `source: ${session.source_uri}`,
    `raw_transcript_imported: false`,
  ].filter(Boolean).join("\n\n");

  return {
    id: `ai-session:${session.tool}:${session.session_id}`,
    schema: { name: "observation.ai_session_locator_result", version: 1 },
    source: { type: "ai_session", id: session.session_id, connector: `${session.tool}-locator` },
    scope: { project: session.project_path ? basename(session.project_path) : undefined, session: session.session_id },
    time: { observed_at: session.started_at ?? session.last_activity_at ?? now, captured_at: now },
    content: { title: session.title ?? `${session.tool} session ${session.session_id}`, text, path: session.source_path },
    acquisition: { mode: "sync", actor: "connector", reason: "Located AI coding session metadata by project path and time window; raw transcript not imported." },
    signal: { importance: Math.min(0.9, session.confidence), confidence: session.confidence, status: "candidate" },
    privacy: { level: "private", retention: "normal", allow_embedding: false, allow_llm_summary: true, allow_external_llm: false, allow_external_reader: false },
    memory: { kind: "observation", stability: "session" },
    payload: session as unknown as Record<string, unknown>,
    created_at: now,
    updated_at: now,
  };
}

function locateClaudeSessions(projectPath: string, timeWindow: ReturnType<typeof normalizeTimeWindow>, includeSnippets: boolean) {
  const root = join(homedir(), ".claude", "projects");
  const dir = join(root, encodeClaudeProjectPath(projectPath));
  const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".jsonl")).map(f => join(dir, f)) : [];
  const sessions = files.map(file => parseSessionFile("claude-code", file, projectPath, timeWindow, includeSnippets)).filter(Boolean) as AiSessionRef[];
  return { sessions, diagnostics: { root, dir, files_considered: files.length } };
}

function locateCodexSessions(projectPath: string, timeWindow: ReturnType<typeof normalizeTimeWindow>, includeSnippets: boolean) {
  const root = join(homedir(), ".codex", "sessions");
  const dirs = codexDateDirs(root, timeWindow);
  const files = dirs.flatMap(dir => existsSync(dir) ? readdirSync(dir).filter(f => f.startsWith("rollout-") && f.endsWith(".jsonl")).map(f => join(dir, f)) : []);
  const sessions = files.map(file => parseSessionFile("codex", file, projectPath, timeWindow, includeSnippets)).filter(Boolean) as AiSessionRef[];
  return { sessions, diagnostics: { root, dirs_considered: dirs, files_considered: files.length } };
}

function parseSessionFile(tool: AiSessionTool, file: string, projectPath: string, timeWindow: ReturnType<typeof normalizeTimeWindow>, includeSnippets: boolean): AiSessionRef | undefined {
  let st;
  try { st = statSync(file); } catch { return undefined; }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined;
  if (!fileCouldOverlap(st.mtime.toISOString(), timeWindow)) return undefined;

  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(0, MAX_LINES);
  const sessionIdFromName = basename(file).replace(/\.jsonl$/, "").split("-").slice(-5).join("-");
  let session_id = sessionIdFromName;
  let cwd: string | undefined;
  let git_branch: string | undefined;
  let started_at: string | undefined;
  let ended_at: string | undefined;
  let title: string | undefined;
  let message_count = 0;
  let user_message_count = 0;
  let assistant_message_count = 0;
  let tool_call_count = 0;
  const files = new Set<string>();
  const commands = new Set<string>();
  const snippets: string[] = [];

  for (const line of lines) {
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const ts = obj.timestamp ?? obj.created_at ?? obj.payload?.timestamp;
    if (ts) {
      if (!started_at || Date.parse(ts) < Date.parse(started_at)) started_at = ts;
      if (!ended_at || Date.parse(ts) > Date.parse(ended_at)) ended_at = ts;
    }
    const sid = obj.sessionId ?? obj.session_id ?? obj.payload?.id ?? obj.payload?.session_id;
    if (sid) session_id = String(sid);
    const c = obj.cwd ?? obj.payload?.cwd ?? obj.message?.cwd;
    if (typeof c === "string") cwd = c;
    const branch = obj.gitBranch ?? obj.git_branch ?? obj.payload?.gitBranch;
    if (typeof branch === "string") git_branch = branch;

    const role = obj.message?.role ?? obj.role ?? obj.payload?.role ?? obj.payload?.role;
    const type = obj.type ?? obj.payload?.type;
    if (type === "response_item" || type === "message" || obj.message) message_count += 1;
    if (role === "user") user_message_count += 1;
    if (role === "assistant") assistant_message_count += 1;

    const text = extractText(obj);
    if (!title && role === "user" && text) title = text.replace(/\s+/g, " ").slice(0, 90);
    for (const f of extractFilePaths(text)) files.add(f);
    for (const cmd of extractCommands(text, obj)) commands.add(cmd);
    if (isToolCall(obj)) tool_call_count += 1;
    if (includeSnippets && snippets.length < 6 && text && (role === "user" || isToolCall(obj))) snippets.push(text.slice(0, 600));
  }

  const reasons: string[] = [];
  let confidence = 0;
  if (cwd && sameOrInside(cwd, projectPath)) { confidence += 0.5; reasons.push("cwd matches project path"); }
  const touchedInside = [...files].filter(f => isInsideProjectFile(f, projectPath));
  if (touchedInside.length) { confidence += Math.min(0.35, 0.15 + touchedInside.length * 0.03); reasons.push(`files touched inside project: ${touchedInside.slice(0, 5).join(", ")}`); }
  if (timeOverlaps(started_at, ended_at ?? st.mtime.toISOString(), timeWindow)) { confidence += 0.3; reasons.push("session overlaps requested time window"); }
  else if (fileCouldOverlap(st.mtime.toISOString(), timeWindow)) { confidence += 0.1; reasons.push("session file mtime near requested time window"); }
  if (commands.size) { confidence += 0.05; reasons.push("commands detected"); }
  if (basename(projectPath) && (title?.toLowerCase().includes(basename(projectPath).toLowerCase()) || file.includes(encodeClaudeProjectPath(projectPath)))) { confidence += 0.1; reasons.push("project name/path appears in session location or title"); }

  confidence = Math.min(1, Number(confidence.toFixed(3)));
  return {
    tool,
    session_id,
    title,
    project_path: cwd && sameOrInside(cwd, projectPath) ? projectPath : undefined,
    cwd,
    git_branch,
    started_at,
    ended_at,
    last_activity_at: ended_at ?? st.mtime.toISOString(),
    message_count,
    user_message_count,
    assistant_message_count,
    tool_call_count,
    files_touched: [...files].slice(0, 80),
    commands_run: [...commands].slice(0, 40),
    source_uri: `file://${file}`,
    source_path: file,
    source_kind: "jsonl",
    transcript_format: tool === "codex" ? "codex-rollout-jsonl" : "claude-code-jsonl",
    confidence,
    reasons,
    snippets: includeSnippets ? snippets : undefined,
    privacy: { level: "private", raw_transcript_imported: false },
  };
}

function normalizeTimeWindow(req: { start_time?: string; end_time?: string; minutes?: number }) {
  const end_time = req.end_time ?? new Date().toISOString();
  const start_time = req.start_time ?? (req.minutes ? new Date(Date.parse(end_time) - req.minutes * 60_000).toISOString() : undefined);
  return { start_time, end_time, minutes: req.minutes };
}

function encodeClaudeProjectPath(projectPath: string): string {
  return resolve(projectPath).replace(/\//g, "-");
}

function codexDateDirs(root: string, timeWindow: ReturnType<typeof normalizeTimeWindow>): string[] {
  const rawStart = timeWindow.start_time ? new Date(timeWindow.start_time) : new Date(Date.parse(timeWindow.end_time) - 24 * 60 * 60_000);
  const rawEnd = new Date(timeWindow.end_time);
  const start = Date.UTC(rawStart.getUTCFullYear(), rawStart.getUTCMonth(), rawStart.getUTCDate());
  const end = Date.UTC(rawEnd.getUTCFullYear(), rawEnd.getUTCMonth(), rawEnd.getUTCDate());
  const dirs: string[] = [];
  for (let t = start; t <= end; t += 24 * 60 * 60_000) {
    const d = new Date(t);
    dirs.push(join(root, String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0")));
  }
  return [...new Set(dirs)];
}

function fileCouldOverlap(mtime: string, timeWindow: ReturnType<typeof normalizeTimeWindow>): boolean {
  const t = Date.parse(mtime);
  const start = timeWindow.start_time ? Date.parse(timeWindow.start_time) - 6 * 60 * 60_000 : -Infinity;
  const end = timeWindow.end_time ? Date.parse(timeWindow.end_time) + 6 * 60 * 60_000 : Infinity;
  return t >= start && t <= end;
}

function timeOverlaps(start?: string, end?: string, timeWindow?: ReturnType<typeof normalizeTimeWindow>): boolean {
  if (!timeWindow) return true;
  const s = start ? Date.parse(start) : undefined;
  const e = end ? Date.parse(end) : s;
  const ws = timeWindow.start_time ? Date.parse(timeWindow.start_time) : -Infinity;
  const we = timeWindow.end_time ? Date.parse(timeWindow.end_time) : Infinity;
  if (s === undefined || e === undefined || Number.isNaN(s) || Number.isNaN(e)) return false;
  return s <= we && e >= ws;
}

function sameOrInside(a: string, b: string): boolean {
  const ra = resolve(a);
  const rb = resolve(b);
  return ra === rb || ra.startsWith(`${rb}/`);
}

function isInsideProjectFile(file: string, projectPath: string): boolean {
  if (file.startsWith("/")) return sameOrInside(dirname(file), projectPath);
  return Boolean(file.match(/\.(ts|tsx|js|jsx|py|rs|go|md|json|yaml|yml|toml|css|html)$/));
}

function extractText(obj: any): string {
  const texts: string[] = [];
  collectText(obj, texts, 0);
  return texts.join("\n");
}

function collectText(value: any, out: string[], depth: number) {
  if (depth > 5 || out.join("\n").length > 20_000) return;
  if (typeof value === "string") { out.push(value); return; }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) collectText(item, out, depth + 1); return; }
  for (const key of ["text", "content", "command", "cmd", "path", "file_path", "stdout", "stderr"]) {
    if (typeof value[key] === "string") out.push(value[key]);
  }
  for (const key of ["message", "payload", "toolUseResult", "tool_use", "params", "arguments", "items"]) {
    if (value[key]) collectText(value[key], out, depth + 1);
  }
}

function extractFilePaths(text: string): string[] {
  const matches = text.match(/(?:\.?\.?\/?[\w.-]+\/)+(?:[\w.-]+)(?:\.[a-zA-Z0-9]+)?|[\w.-]+\.(?:ts|tsx|js|jsx|py|rs|go|md|json|yaml|yml|toml|css|html)/g) ?? [];
  return [...new Set(matches)]
    .filter(p => !p.startsWith("http") && !p.includes("://"))
    .filter(p => p.startsWith("/") || p.startsWith("./") || p.startsWith("../") || /\.(ts|tsx|js|jsx|py|rs|go|md|json|yaml|yml|toml|css|html)$/.test(p))
    .slice(0, 100);
}

function extractCommands(text: string, obj: any): string[] {
  const commands = new Set<string>();
  const maybe = [obj.command, obj.payload?.command, obj.message?.command, obj.toolUseResult?.command].filter((x): x is string => typeof x === "string");
  for (const c of maybe) commands.add(c.slice(0, 500));
  const patterns = text.match(/(?:pnpm|npm|yarn|bun|uv|python3?|node|cargo|go|git|docker|curl)\s+[^\n]{1,200}/g) ?? [];
  for (const c of patterns) commands.add(c.trim());
  return [...commands].slice(0, 20);
}

function isToolCall(obj: any): boolean {
  const name = obj.name ?? obj.toolName ?? obj.payload?.name ?? obj.message?.name;
  const type = obj.type ?? obj.payload?.type;
  return Boolean(name) || String(type).includes("tool") || Boolean(obj.toolUseResult);
}
