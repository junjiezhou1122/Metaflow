import { createHash } from "node:crypto";
import { canonicalJson, type JsonObject } from "@info/view";
import {
  IiiRuntimeError,
  IiiRuntimeEventSchema,
  type IiiRuntimeEvent,
  type IiiRuntimeEventSink,
} from "./contracts.js";

export type IiiEventWriterOptions = {
  sink: IiiRuntimeEventSink;
  worker: string;
  now: () => string;
};

export class IiiEventWriter {
  private sequence = 0;

  constructor(private readonly options: IiiEventWriterOptions) {}

  async emit(input: Omit<IiiRuntimeEvent, "schema_version" | "id" | "occurred_at" | "worker" | "payload"> & {
    payload?: JsonObject;
  }): Promise<void> {
    const occurredAt = this.options.now();
    const event = IiiRuntimeEventSchema.parse({
      schema_version: 1,
      id: `iii-event:${createHash("sha256").update(canonicalJson({
        worker: this.options.worker,
        type: input.type,
        occurred_at: occurredAt,
        sequence: ++this.sequence,
        message_id: input.message_id ?? null,
        attempt_id: input.attempt_id ?? null,
      })).digest("hex")}`,
      occurred_at: occurredAt,
      worker: this.options.worker,
      ...input,
      payload: input.payload ?? {},
    });
    try {
      await this.options.sink.emit(event);
    } catch (cause) {
      throw new IiiRuntimeError(`failed to persist III runtime event ${event.type}`, "trace_persistence_failed", { cause });
    }
  }
}
