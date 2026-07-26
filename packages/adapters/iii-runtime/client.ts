import {
  registerWorker,
  type FunctionRef,
  type ISdk,
  type RegisterFunctionOptions,
  type TriggerRequest,
} from "iii-sdk";
import { readFileSync } from "node:fs";

export type IiiFunctionHandler = (input: unknown) => Promise<unknown>;

export interface IiiClientPort {
  registerFunction(
    functionId: string,
    handler: IiiFunctionHandler,
    options?: RegisterFunctionOptions,
  ): FunctionRef;
  trigger<TInput, TOutput>(request: TriggerRequest<TInput>): Promise<TOutput>;
  shutdown(): Promise<void>;
}

export type IiiClientFactory = (input: {
  engine_url: string;
  worker_name: string;
}) => IiiClientPort;

export const defaultIiiClientFactory: IiiClientFactory = ({ engine_url, worker_name }) => (
  registerWorker(engine_url, {
    workerName: worker_name,
    workerDescription: "Metaflow v1 Operator Worker and durable Automation queue adapter",
    reconnectionConfig: { maxRetries: -1 },
  }) as Pick<ISdk, "registerFunction" | "trigger" | "shutdown">
);

export function enforceIiiTracePayloadProtection(): void {
  process.env.III_DISABLE_TRACE_PAYLOADS = "true";
}

export function installedIiiSdkVersion(): string {
  const entry = import.meta.resolve("iii-sdk");
  const manifestUrl = new URL("../package.json", entry);
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error(`iii-sdk package has no valid version at ${manifestUrl.pathname}`);
  }
  return manifest.version;
}
