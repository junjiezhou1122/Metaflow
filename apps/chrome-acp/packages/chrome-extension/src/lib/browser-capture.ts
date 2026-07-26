import {
  parseBrowserCaptureWireEvent,
  type BrowserCaptureEvent as BrowserCaptureEventPayload,
} from "@info/browser-capture-adapter/wire";

export {
  BrowserCaptureEventSchema,
  parseBrowserCaptureWireEvent,
  type BrowserCaptureEvent as BrowserCaptureEventPayload,
} from "@info/browser-capture-adapter/wire";

export type BrowserCaptureTransportFailure = {
  id: string;
  status: "pending" | "resolved";
  event: BrowserCaptureEventPayload;
  endpoint: string;
  attempts: number;
  failed_at: string;
  error: { code: string; http_status?: number; message?: string };
  resolved_at?: string;
};

export interface BrowserCaptureOutbox {
  put(failure: BrowserCaptureTransportFailure): Promise<void>;
  resolve(id: string, resolvedAt: string): Promise<void>;
}

export interface BrowserCaptureFailureStorage {
  read(): Promise<unknown>;
  write(records: BrowserCaptureTransportFailure[]): Promise<void>;
}

export class SerializedBrowserCaptureOutbox implements BrowserCaptureOutbox {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly storage: BrowserCaptureFailureStorage) {}

  async put(failure: BrowserCaptureTransportFailure): Promise<void> {
    await this.withMutation(async () => {
      const records = await this.readRecords();
      const next = records.filter(item => item.id !== failure.id);
      await this.storage.write([...next, parseTransportFailure(failure)]);
    });
  }

  async resolve(id: string, resolvedAt: string): Promise<void> {
    await this.withMutation(async () => {
      const records = await this.readRecords();
      let found = false;
      const next = records.map(item => {
        if (item.id !== id) return item;
        found = true;
        return { ...item, status: "resolved" as const, resolved_at: resolvedAt };
      });
      if (!found) throw new Error(`Browser Capture transport failure is missing: ${id}`);
      await this.storage.write(next);
    });
  }

  async list(): Promise<BrowserCaptureTransportFailure[]> {
    return this.withMutation(() => this.readRecords());
  }

  private async readRecords(): Promise<BrowserCaptureTransportFailure[]> {
    const value = await this.storage.read();
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("Browser Capture outbox storage must contain an array");
    return value.map(parseTransportFailure);
  }

  private async withMutation<Result>(operation: () => Promise<Result>): Promise<Result> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function browserCaptureEndpoint(configuredEndpoint: string): string {
  const url = new URL(configuredEndpoint);
  url.pathname = "/capture/v1/browser-events";
  url.search = "";
  return url.toString();
}

export function buildBrowserCaptureEvent(input: unknown): BrowserCaptureEventPayload {
  return parseBrowserCaptureWireEvent(input);
}

export async function deliverBrowserCaptureEvent(input: {
  event: BrowserCaptureEventPayload;
  endpoint: string;
  outbox: BrowserCaptureOutbox;
  fetch?: typeof fetch;
  now?: () => string;
  previous?: BrowserCaptureTransportFailure;
}): Promise<{
  ok: boolean;
  status: number;
  body?: any;
  failure?: BrowserCaptureTransportFailure;
  error?: BrowserCaptureTransportFailure["error"];
}> {
  const event = parseBrowserCaptureWireEvent(input.event);
  const fetcher = input.fetch ?? fetch;
  const now = input.now ?? (() => new Date().toISOString());
  try {
    const response = await fetcher(input.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok || !body || body.ok !== true) {
      const error = {
        code: body && typeof body.code === "string" ? body.code : `http_${response.status}`,
        http_status: response.status,
      };
      if (isRetryableCaptureResponse(response.status)) {
        const failure = await persistTransportFailure({ ...input, event }, now(), error);
        return { ok: false, status: response.status, body, failure, error };
      }
      return { ok: false, status: response.status, body, error };
    }
    if (input.previous) await input.outbox.resolve(input.previous.id, now());
    return { ok: true, status: response.status, body };
  } catch (cause) {
    const failure = await persistTransportFailure(
      { ...input, event },
      now(),
      { code: "transport_unreachable", message: cause instanceof Error ? cause.message : String(cause) },
    );
    return { ok: false, status: 0, failure, error: failure.error };
  }
}

function isRetryableCaptureResponse(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function persistTransportFailure(
  input: Parameters<typeof deliverBrowserCaptureEvent>[0],
  failedAt: string,
  error: BrowserCaptureTransportFailure["error"],
): Promise<BrowserCaptureTransportFailure> {
  const failure: BrowserCaptureTransportFailure = {
    id: input.previous?.id ?? `browser-capture:${input.event.event_id}`,
    status: "pending",
    event: input.event,
    endpoint: input.endpoint,
    attempts: (input.previous?.attempts ?? 0) + 1,
    failed_at: failedAt,
    error,
  };
  await input.outbox.put(failure);
  return failure;
}

function parseTransportFailure(input: unknown): BrowserCaptureTransportFailure {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Browser Capture outbox record must be an object");
  }
  const value = input as Partial<BrowserCaptureTransportFailure>;
  if (typeof value.id !== "string" || !value.id
    || (value.status !== "pending" && value.status !== "resolved")
    || typeof value.endpoint !== "string" || !value.endpoint
    || !Number.isInteger(value.attempts) || Number(value.attempts) < 1
    || typeof value.failed_at !== "string" || Number.isNaN(Date.parse(value.failed_at))
    || !value.error || typeof value.error.code !== "string") {
    throw new Error("Browser Capture outbox record is malformed");
  }
  return {
    id: value.id,
    status: value.status,
    event: parseBrowserCaptureWireEvent(value.event),
    endpoint: value.endpoint,
    attempts: value.attempts!,
    failed_at: new Date(value.failed_at).toISOString(),
    error: {
      code: value.error.code,
      ...(value.error.http_status !== undefined ? { http_status: value.error.http_status } : {}),
      ...(value.error.message !== undefined ? { message: value.error.message } : {}),
    },
    ...(value.resolved_at ? { resolved_at: new Date(value.resolved_at).toISOString() } : {}),
  };
}
