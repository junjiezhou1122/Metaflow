import type { ProcessorContext, ProcessorHandlerResult, ProcessorInput } from "../types.js";

export async function runLlmProcessor(
  input: ProcessorInput,
  context: ProcessorContext,
): Promise<ProcessorHandlerResult> {
  if (context.processor.handler) return context.processor.handler(input, context);
  throw new Error(`LLM processor runtime requires a handler or configured provider bridge: ${context.processor.id}`);
}
