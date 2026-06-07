import { execFileSync } from "node:child_process";
import { buildAgentTaskPromptBlocks, promptTextFromBlocks } from "./acp/content.js";
import { parseAgentTaskOutput } from "./outputs/view-output.js";
import type { AgentCliJsonRuntimeOptions, AgentRuntimeAdapter, AgentRuntimeContext, AgentTaskRequest, AgentTaskResult } from "./types.js";

export class CliJsonAgentRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id: string;
  readonly kind = "cli_json" as const;

  constructor(private readonly options: AgentCliJsonRuntimeOptions) {
    this.id = options.id;
  }

  async capabilities() {
    return {
      runtimeId: this.id,
      kind: this.kind,
      supportsDryRun: true,
      supportsCancel: false,
      supportsMcpServers: false,
    };
  }

  async submit(task: AgentTaskRequest, context: AgentRuntimeContext): Promise<AgentTaskResult> {
    const prompt = promptTextFromBlocks(buildAgentTaskPromptBlocks({
      task,
      signal: context.signal,
      contextSources: contextSourcesForPrompt(task),
    }));

    if (task.dryRun) {
      return {
        ok: true,
        reason: `dry_run previewed ${this.id} agent task`,
        diagnostics: {
          runtime: this.id,
          dry_run: true,
          prompt_preview: prompt.slice(0, 4000),
          task_goal: task.goal,
          output_view_type: task.outputContract.viewType,
          ...(this.options.dryRunDiagnostics?.(task, prompt) ?? {}),
        },
      };
    }

    try {
      const stdout = execFileSync(this.options.command, this.options.buildArgs(task, prompt), {
        encoding: "utf8",
        timeout: this.options.timeoutMs ?? 0,
        maxBuffer: this.options.maxBuffer ?? 2 * 1024 * 1024,
        cwd: task.cwd ?? this.options.cwd ?? process.cwd(),
        env: this.options.env ?? process.env,
      });
      const output = parseAgentTaskOutput(stdout);
      return {
        ok: true,
        reason: `submitted agent task to ${this.id}`,
        output,
        diagnostics: {
          runtime: this.id,
          task_goal: task.goal,
          output_view_type: task.outputContract.viewType,
        },
      };
    } catch (error) {
      return {
        ok: false,
        reason: `${displayName(this.id)} agent task failed: ${errorMessage(error)}`,
        diagnostics: {
          runtime: this.id,
          error: errorMessage(error),
          task_goal: task.goal,
          output_view_type: task.outputContract.viewType,
        },
      };
    }
  }
}

export function createClaudeCodeRuntime(): CliJsonAgentRuntimeAdapter {
  const toolPolicy = claudeCodeToolPolicy();
  return new CliJsonAgentRuntimeAdapter({
    id: "claude_code",
    command: process.env.CLAUDE_CODE_BIN || "claude",
    timeoutMs: Number(process.env.AGENT_TASK_CLAUDE_CODE_TIMEOUT_MS ?? 0),
    env: { ...process.env, CLAUDE_CODE_SIMPLE: "1" },
    buildArgs(_task, prompt) {
      return [
        "-p",
        "--no-session-persistence",
        "--dangerously-skip-permissions",
        `--tools=${toolPolicy.tools}`,
        "--output-format=json",
        prompt,
      ];
    },
    dryRunDiagnostics() {
      return { tool_policy: toolPolicy };
    },
  });
}

export function claudeCodeToolPolicy() {
  return {
    tools: "default",
    permission_mode: "dangerously-skip-permissions",
    allowed_tools: [],
    disallowed_tools: [],
    reason: "local experiment trusts Claude Code as the external agent runtime with full tool permissions; task prompt still carries behavioral constraints",
  };
}

function contextSourcesForPrompt(task: AgentTaskRequest): unknown[] {
  return (task.contextPack?.sources ?? []).slice(0, 40);
}

function displayName(id: string): string {
  if (id === "claude_code") return "Claude Code";
  return id;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
