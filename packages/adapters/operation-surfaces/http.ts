import {
  OperationEnvelopeSchema,
  type OperationContextProvider,
  type OperationEnvelope,
  type OperationService,
} from "@info/operations";
import { METAFLOW_HTTP_PROTOCOL_VERSION, operationHttpStatus } from "./daemon.js";

export type OperationHttpRequest = {
  method: string;
  path: string;
  body?: unknown;
};

export type OperationHttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: OperationEnvelope;
};

export class HttpOperationAdapter {
  constructor(
    private readonly service: OperationService,
    private readonly context: OperationContextProvider,
    private readonly prefix = "/metaflow/v1/operations/",
  ) {}

  async handle(request: OperationHttpRequest): Promise<OperationHttpResponse> {
    const operation = request.method.toUpperCase() === "POST" && request.path.startsWith(this.prefix)
      ? decodeURIComponent(request.path.slice(this.prefix.length))
      : undefined;
    const context = await this.context({ transport: "http", ...(operation ? { operation } : {}) });
    const envelope = OperationEnvelopeSchema.parse(await this.service.execute({
      operation,
      input: request.body ?? {},
    }, context));
    return {
      status: operationHttpStatus(envelope),
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-metaflow-protocol-version": String(METAFLOW_HTTP_PROTOCOL_VERSION),
      },
      body: envelope,
    };
  }
}
