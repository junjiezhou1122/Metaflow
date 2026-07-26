import { randomUUID } from "node:crypto";
import { BrowserDomSnapshotSchema, type BrowserDomSnapshot, type MacVoiceCaptureEvent } from "./contracts.js";

export type BrowserDomRequest = {
  request_id: string;
  session_id: string;
  requested_at: string;
  expires_at: string;
  app: {
    name: string;
    bundle_identifier: string;
    window_title?: string;
  };
};

export interface MacBrowserContextBridge {
  request(event: MacVoiceCaptureEvent): Promise<BrowserDomSnapshot>;
}

type Pending = {
  request: BrowserDomRequest;
  resolve(value: BrowserDomSnapshot): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

export class BrowserDomRequestBroker implements MacBrowserContextBridge {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly options: {
      timeout_ms?: number;
      now?: () => Date;
      id?: () => string;
    } = {},
  ) {}

  request(event: MacVoiceCaptureEvent): Promise<BrowserDomSnapshot> {
    if (event.accessibility.status !== "trusted") {
      throw new Error("Browser DOM request requires trusted Accessibility context");
    }
    const now = (this.options.now ?? (() => new Date()))();
    const timeoutMs = this.options.timeout_ms ?? 2_000;
    const request: BrowserDomRequest = {
      request_id: (this.options.id ?? randomUUID)(),
      session_id: event.session_id,
      requested_at: now.toISOString(),
      expires_at: new Date(now.getTime() + timeoutMs).toISOString(),
      app: {
        name: event.accessibility.app_name,
        bundle_identifier: event.accessibility.bundle_identifier,
        ...(event.accessibility.window_title ? { window_title: event.accessibility.window_title } : {}),
      },
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.request_id);
        reject(new Error(`Browser DOM request timed out: ${request.request_id}`));
      }, timeoutMs);
      this.pending.set(request.request_id, { request, resolve, reject, timer });
    });
  }

  list(): BrowserDomRequest[] {
    const now = (this.options.now ?? (() => new Date()))().getTime();
    return [...this.pending.values()]
      .map(item => item.request)
      .filter(item => Date.parse(item.expires_at) > now)
      .sort((left, right) => left.requested_at.localeCompare(right.requested_at));
  }

  respond(input: unknown): BrowserDomSnapshot {
    const response = BrowserDomSnapshotSchema.parse(input);
    const pending = this.pending.get(response.request_id);
    if (!pending) throw new Error(`Unknown or expired Browser DOM request: ${response.request_id}`);
    clearTimeout(pending.timer);
    this.pending.delete(response.request_id);
    pending.resolve(response);
    return response;
  }

  fail(input: { request_id: string; code: string; message: string }): void {
    const pending = this.pending.get(input.request_id);
    if (!pending) throw new Error(`Unknown or expired Browser DOM request: ${input.request_id}`);
    clearTimeout(pending.timer);
    this.pending.delete(input.request_id);
    pending.reject(new Error(`Browser DOM bridge failed (${input.code}): ${input.message}`));
  }

  close(): void {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("Browser DOM request broker closed"));
    }
    this.pending.clear();
  }
}
