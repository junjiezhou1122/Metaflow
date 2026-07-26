import type { ProcessorContext, ProcessorHandlerResult, ProcessorInput } from "../types.js";

export async function runLocalProcessor(
  input: ProcessorInput,
  context: ProcessorContext,
): Promise<ProcessorHandlerResult> {
  const handler = context.processor.handler;
  if (!handler) throw new Error(`Local processor is missing handler: ${context.processor.id}`);
  return handler(input, context);
}
