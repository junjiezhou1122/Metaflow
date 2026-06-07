import type { AgentRuntimeAdapter, AgentRuntimeContext, AgentTaskRequest, AgentTaskResult } from "./types.js";

export class MockAgentRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id = "local_mock";
  readonly kind = "mock" as const;

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
    const text = signalText(context.signal);
    const base = text ? firstSentence(text, 220) : "Agent task completed.";
    return {
      ok: true,
      reason: `submitted agent task to ${this.id}`,
      output: {
        summary: `${base} Goal: ${task.goal}`.slice(0, 360),
        key_points: [
          `Agent runtime: ${this.id}`,
          `Output View type: ${task.outputContract.viewType}`,
        ],
        confidence: 0.5,
      },
      diagnostics: { runtime: this.id },
    };
  }
}

function signalText(signal: unknown): string | undefined {
  if (!signal || typeof signal !== "object") return undefined;
  const record = signal as Record<string, unknown>;
  return typeof record.text_preview === "string" ? record.text_preview : undefined;
}

function firstSentence(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const sentence = normalized.split(/(?<=[.!?。！？])\s+/)[0] || normalized;
  return sentence.slice(0, max);
}
