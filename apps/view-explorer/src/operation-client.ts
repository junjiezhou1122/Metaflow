import {
  EXPLORER_MAX_RESPONSE_BYTES,
  OperationEnvelopeSchema,
  SearchRequestV1Schema,
  SearchResponseV1Schema,
  ViewGraphProjectionRequestSchema,
  ViewGraphProjectionResultSchema,
  ViewRevisionSchema,
  type ExplorerOperation,
  type OperationEnvelope,
  type SearchRequestV1,
  type SearchResponseV1,
  type View,
  type ViewGraphProjectionRequest,
  type ViewGraphProjectionResult,
} from "./contracts.js";

export type OperationTransport = {
  call(operation: ExplorerOperation, input: unknown, signal: AbortSignal): Promise<unknown>;
};

export class ExplorerClientError extends Error {
  constructor(
    message: string,
    readonly code: "operation_failed" | "invalid_response" | "response_too_large" | "network_failed" | "aborted",
    readonly operation: ExplorerOperation,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExplorerClientError";
  }
}

export class ViewExplorerOperationClient {
  constructor(private readonly transport: OperationTransport = createHttpOperationTransport()) {}

  async project(requestInput: ViewGraphProjectionRequest, signal: AbortSignal): Promise<ViewGraphProjectionResult> {
    const request = ViewGraphProjectionRequestSchema.parse(requestInput);
    return ViewGraphProjectionResultSchema.parse(await this.success("view.graph.project", { request }, signal));
  }

  async getView(ref: { view_id: string; revision: number }, signal: AbortSignal): Promise<View> {
    return ViewRevisionSchema.parse(await this.success("view.get", { ref }, signal));
  }

  async search(requestInput: SearchRequestV1, signal: AbortSignal): Promise<SearchResponseV1> {
    const request = SearchRequestV1Schema.parse(requestInput);
    return SearchResponseV1Schema.parse(await this.success("view.search", { request }, signal));
  }

  private async success(operation: ExplorerOperation, input: unknown, signal: AbortSignal): Promise<unknown> {
    let envelope: OperationEnvelope;
    try {
      envelope = OperationEnvelopeSchema.parse(await this.transport.call(operation, input, signal));
    } catch (cause) {
      if (signal.aborted) throw new ExplorerClientError("Operation was aborted", "aborted", operation, {}, { cause });
      if (cause instanceof ExplorerClientError) throw cause;
      throw new ExplorerClientError("Operation returned an invalid envelope", "invalid_response", operation, {}, { cause });
    }
    if (!envelope.ok) {
      throw new ExplorerClientError(envelope.error.message, "operation_failed", operation, {
        request_id: envelope.request_id,
        operation_code: envelope.error.code,
        category: envelope.error.category,
      });
    }
    if (envelope.operation !== operation) {
      throw new ExplorerClientError("Operation response identity did not match the request", "invalid_response", operation, {
        actual_operation: envelope.operation,
      });
    }
    return envelope.data;
  }
}

export function createHttpOperationTransport(prefix = "/metaflow/v1/operations/"): OperationTransport {
  return {
    async call(operation, input, signal) {
      let response: Response;
      try {
        response = await fetch(`${prefix}${encodeURIComponent(operation)}`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
          signal,
        });
      } catch (cause) {
        if (signal.aborted) throw new ExplorerClientError("Operation was aborted", "aborted", operation, {}, { cause });
        throw new ExplorerClientError("Operation transport failed", "network_failed", operation, {}, { cause });
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > EXPLORER_MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        throw new ExplorerClientError("Operation response exceeded the explorer byte limit", "response_too_large", operation, { declared_length: declaredLength });
      }
      const bytes = await readBounded(response, operation, signal);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
      } catch (cause) {
        throw new ExplorerClientError("Operation response was not JSON", "invalid_response", operation, {}, { cause });
      }
      return parsed;
    },
  };
}

async function readBounded(response: Response, operation: ExplorerOperation, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel(signal.reason);
        throw new ExplorerClientError("Operation was aborted", "aborted", operation);
      }
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > EXPLORER_MAX_RESPONSE_BYTES) {
        await reader.cancel(new Error("Explorer response byte limit exceeded"));
        throw new ExplorerClientError("Operation response exceeded the explorer byte limit", "response_too_large", operation, { received_bytes: length });
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
