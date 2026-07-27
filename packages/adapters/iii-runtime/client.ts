import {
  registerWorker,
  type IIIClient,
} from "iii-sdk";
import { readFileSync } from "node:fs";

export type IiiFunctionHandler = (input: unknown) => Promise<unknown>;
export type IiiFunctionRef = ReturnType<IIIClient["registerFunction"]>;
export type IiiRegisterFunctionOptions = NonNullable<Parameters<IIIClient["registerFunction"]>[2]>;
export type IiiTriggerRequest = Parameters<IIIClient["trigger"]>[0];

export interface IiiClientPort {
  registerFunction(
    functionId: string,
    handler: IiiFunctionHandler,
    options?: IiiRegisterFunctionOptions,
  ): IiiFunctionRef;
  trigger<TInput, TOutput>(request: IiiTriggerRequest): Promise<TOutput>;
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
  })
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
