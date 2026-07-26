import type { ProcessorContext, ProcessorHandlerResult, ProcessorInput } from "../types.js";
import { parseProcessorHandlerResult, processorRuntimePayload } from "./result.js";

export async function runHttpProcessor(
  input: ProcessorInput,
  context: ProcessorContext,
): Promise<ProcessorHandlerResult> {
  const runtime = context.processor.runtime;
  if (runtime.kind !== "http") throw new Error(`HTTP processor runtime expected http config: ${context.processor.id}`);
  const res = await fetch(runtime.url, {
    method: runtime.method ?? "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(processorRuntimePayload(input, context.processor)),
  });
  if (!res.ok) throw new Error(`HTTP processor failed: ${res.status} ${await res.text()}`);
  return parseProcessorHandlerResult(await res.json(), `http processor ${context.processor.id}`);
}
