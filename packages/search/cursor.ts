import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@info/view";
import { SearchError } from "./errors.js";
import type { SearchSortTuple } from "./fusion.js";

const CursorPayloadSchema = z.object({
  version: z.literal(1),
  scope_fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  strategy_fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  last: z.tuple([
    z.number().finite().nonnegative(),
    z.number().int().nonnegative(),
    z.string().min(1),
    z.number().int().positive(),
    z.string(),
  ]),
}).strict();

const CursorEnvelopeSchema = z.object({
  payload: CursorPayloadSchema,
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export type SearchCursorPayload = z.infer<typeof CursorPayloadSchema>;

export function encodeSearchCursor(payload: SearchCursorPayload): string {
  const parsed = CursorPayloadSchema.parse(payload);
  const serialized = canonicalJson(parsed);
  return Buffer.from(canonicalJson({ payload: parsed, checksum: digest(serialized) }), "utf8").toString("base64url");
}

export function decodeSearchCursor(cursor: string): SearchCursorPayload {
  try {
    const envelope = CursorEnvelopeSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    if (envelope.checksum !== digest(canonicalJson(envelope.payload))) {
      throw new Error("cursor checksum mismatch");
    }
    return envelope.payload;
  } catch (cause) {
    throw new SearchError("Search cursor is malformed", "cursor_invalid", "cursor", false, { cause });
  }
}

export function sameSortTuple(left: SearchSortTuple, right: SearchSortTuple): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
