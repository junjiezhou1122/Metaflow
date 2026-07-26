import type { IiiRuntimeClient } from "./types.js";

export class InProcessIiiRuntimeClient implements IiiRuntimeClient {
  readonly functions = new Map<string, (input: unknown) => Promise<any>>();
  readonly triggers: Array<{ type: string; function_id: string; config: Record<string, unknown>; metadata?: Record<string, unknown> }> = [];

  async registerFunction(id: string, handler: (input: unknown) => Promise<any>) {
    this.functions.set(id, handler);
  }

  async registerTrigger(trigger: { type: string; function_id: string; config: Record<string, unknown>; metadata?: Record<string, unknown> }) {
    this.triggers.push(trigger);
  }

  async trigger(input: { function_id: string; payload?: unknown }) {
    const handler = this.functions.get(input.function_id);
    if (!handler) throw new Error(`iii function not registered: ${input.function_id}`);
    return handler(input.payload ?? {});
  }
}
