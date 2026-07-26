import type { ProcessorContext, ProcessorHandlerResult, ProcessorInput } from "../types.js";

export async function runAgentTaskProcessor(
  input: ProcessorInput,
  context: ProcessorContext,
): Promise<ProcessorHandlerResult> {
  if (context.processor.handler) return context.processor.handler(input, context);
  throw new Error(`Agent task processor runtime requires a handler or configured AgentTask bridge: ${context.processor.id}`);
}
