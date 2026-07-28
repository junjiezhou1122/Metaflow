import { createHash } from "node:crypto";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { z } from "zod";
import {
  ExactViewRefSchema,
  IdentifierSchema,
  JsonValueSchema,
  TimestampSchema,
  canonicalJson,
  exactViewRef,
  type ExactViewRef,
  type JsonValue,
  type View,
} from "@info/view";
import type {
  SearchPrincipal,
  ViewReadAuthorizationDecision,
  ViewReadAuthorizationPort,
} from "@info/search";
import { ViewReadAuthorizationDecisionSchema } from "@info/search";

export const VIEW_QUERY_CONTRACT_VERSION = 1 as const;
export const VIEW_QUERY_MAX_PAGE_SIZE = 100;

export const ViewQueryProfileSchema = z.object({
  id: IdentifierSchema,
  version: z.number().int().positive(),
}).strict();

export const ViewQueryMethodParametersContractSchema = z.object({
  dialect: z.literal("https://json-schema.org/draft/2020-12/schema"),
  json_schema: JsonValueSchema,
  pagination: z.object({
    kind: z.literal("cursor"),
    max_page_size: z.number().int().positive().max(1_000),
  }).strict().optional(),
}).strict();

export const ViewQueryRequestSchema = z.object({
  contract_version: z.literal(VIEW_QUERY_CONTRACT_VERSION),
  subject: ExactViewRefSchema,
  profile: ViewQueryProfileSchema,
  parameters: JsonValueSchema,
  page: z.object({
    limit: z.number().int().positive().max(VIEW_QUERY_MAX_PAGE_SIZE),
    cursor: z.string().trim().min(1).max(8_192).optional(),
  }).strict(),
}).strict();

export const ViewQueryItemSchema = z.object({
  key: IdentifierSchema,
  evidence: z.array(ExactViewRefSchema).min(1).max(128),
  value: JsonValueSchema,
}).strict();

export const ViewQueryResponseSchema = z.object({
  contract_version: z.literal(VIEW_QUERY_CONTRACT_VERSION),
  subject: ExactViewRefSchema,
  profile: ViewQueryProfileSchema,
  items: z.array(ViewQueryItemSchema).max(VIEW_QUERY_MAX_PAGE_SIZE),
  next_cursor: z.string().trim().min(1).max(8_192).optional(),
  redacted_boundary: z.boolean(),
}).strict();

const CursorPayloadSchema = z.object({
  version: z.literal(1),
  subject: ExactViewRefSchema,
  profile: ViewQueryProfileSchema,
  parameters_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  method_cursor: JsonValueSchema,
}).strict();

const CursorEnvelopeSchema = z.object({
  payload: CursorPayloadSchema,
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export type ViewQueryRequest = z.infer<typeof ViewQueryRequestSchema>;
export type ViewQueryItem = z.infer<typeof ViewQueryItemSchema>;
export type ViewQueryResponse = z.infer<typeof ViewQueryResponseSchema>;
export type ViewQueryProfile = z.infer<typeof ViewQueryProfileSchema>;
export type ViewQueryMethodParametersContract = z.infer<typeof ViewQueryMethodParametersContractSchema>;

export type ViewQueryMethodResult = {
  items: ViewQueryItem[];
  next_cursor?: JsonValue;
  redacted_boundary: boolean;
};

export interface ViewQueryMethod {
  readonly profile: ViewQueryProfile;
  readonly subject_schema: { name: string; version: number };
  readonly parameters: ViewQueryMethodParametersContract;
  query(input: {
    subject: View;
    parameters: JsonValue;
    page: { limit: number; cursor?: JsonValue };
    principal: SearchPrincipal;
    authorize(refs: ExactViewRef[]): Promise<ViewReadAuthorizationDecision[]>;
  }): Promise<ViewQueryMethodResult>;
}

export class ViewQueryError extends Error {
  constructor(
    message: string,
    readonly code:
      | "view_query_profile_unknown"
      | "view_query_subject_mismatch"
      | "view_query_cursor_invalid"
      | "view_query_cursor_mismatch"
      | "view_query_parameters_invalid"
      | "view_query_method_invalid",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ViewQueryError";
  }
}

export class ViewQueryRegistry {
  private readonly methods = new Map<string, { method: ViewQueryMethod; validate: ValidateFunction }>();

  constructor(methods: readonly ViewQueryMethod[]) {
    const ajv = new Ajv2020({ addUsedSchema: false, allErrors: true, strict: true, validateSchema: true });
    ajv.addFormat("date-time", { type: "string", validate: value => TimestampSchema.safeParse(value).success });
    for (const method of methods) {
      const key = profileKey(method.profile);
      if (this.methods.has(key)) throw new TypeError(`Duplicate View query profile: ${key}`);
      const parameters = ViewQueryMethodParametersContractSchema.parse(method.parameters);
      let validate: ValidateFunction;
      try {
        validate = ajv.compile(parameters.json_schema as boolean | object);
      } catch (cause) {
        throw new TypeError(`View query profile ${key} has an invalid parameter JSON Schema`, { cause });
      }
      this.methods.set(key, { method, validate });
    }
  }

  async query(input: {
    request: ViewQueryRequest;
    subject: View;
    principal: SearchPrincipal;
    authorization: ViewReadAuthorizationPort;
  }): Promise<ViewQueryResponse> {
    const request = ViewQueryRequestSchema.parse(input.request);
    if (canonicalJson(exactViewRef(input.subject)) !== canonicalJson(request.subject)) {
      throw new ViewQueryError("View query subject does not match the resolved exact View", "view_query_subject_mismatch");
    }
    const registered = this.methods.get(profileKey(request.profile));
    if (!registered) throw new ViewQueryError("View query profile is not registered", "view_query_profile_unknown");
    const { method, validate } = registered;
    if (method.subject_schema.name !== input.subject.schema.name
      || method.subject_schema.version !== input.subject.schema.version) {
      throw new ViewQueryError("View query profile does not support the subject Schema", "view_query_subject_mismatch");
    }
    if (method.parameters.pagination && request.page.limit > method.parameters.pagination.max_page_size) {
      throw new ViewQueryError("View query page exceeds the Method contract", "view_query_parameters_invalid");
    }
    if (!validate(request.parameters)) {
      throw new ViewQueryError("View query parameters do not satisfy the Method contract", "view_query_parameters_invalid", {
        cause: new Error(ajvErrors(validate)),
      });
    }
    const parametersDigest = digest(canonicalJson(request.parameters));
    const methodCursor = request.page.cursor
      ? decodeCursor(request.page.cursor, request, parametersDigest)
      : undefined;
    const authorize = async (refs: ExactViewRef[]) => {
      const requested = uniqueRefs(refs);
      let decisions: ViewReadAuthorizationDecision[];
      try {
        decisions = z.array(ViewReadAuthorizationDecisionSchema).parse(await input.authorization.authorize({
          principal: input.principal,
          refs: requested,
          purpose: "query",
        }));
      } catch (cause) {
        throw new ViewQueryError("View query authorizer returned invalid decisions", "view_query_method_invalid", { cause });
      }
      const expectedKeys = requested.map(refKey);
      const actualKeys = decisions.map(decision => refKey(decision.ref));
      if (actualKeys.length !== expectedKeys.length
        || new Set(actualKeys).size !== actualKeys.length
        || actualKeys.some(key => !expectedKeys.includes(key))) {
        throw new ViewQueryError("View query authorizer returned incomplete or mismatched decisions", "view_query_method_invalid");
      }
      return decisions;
    };
    const result = await method.query({
      subject: input.subject,
      parameters: request.parameters,
      page: { limit: request.page.limit, ...(methodCursor === undefined ? {} : { cursor: methodCursor }) },
      principal: input.principal,
      authorize,
    });
    const parsedItems = z.array(ViewQueryItemSchema).max(request.page.limit).parse(result.items);
    const evidence = uniqueRefs(parsedItems.flatMap(item => item.evidence));
    const decisions = evidence.length === 0 ? [] : await authorize(evidence);
    if (decisions.some(decision => decision.status !== "allowed")) {
      throw new ViewQueryError("View query method returned unauthorized evidence", "view_query_method_invalid");
    }
    return ViewQueryResponseSchema.parse({
      contract_version: VIEW_QUERY_CONTRACT_VERSION,
      subject: request.subject,
      profile: request.profile,
      items: parsedItems,
      ...(result.next_cursor === undefined ? {} : {
        next_cursor: encodeCursor({
          version: 1,
          subject: request.subject,
          profile: request.profile,
          parameters_digest: parametersDigest,
          method_cursor: result.next_cursor,
        }),
      }),
      redacted_boundary: result.redacted_boundary,
    });
  }
}

function encodeCursor(payloadInput: z.infer<typeof CursorPayloadSchema>): string {
  const payload = CursorPayloadSchema.parse(payloadInput);
  const serialized = canonicalJson(payload);
  return Buffer.from(canonicalJson({ payload, checksum: digest(serialized) }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, request: ViewQueryRequest, parametersDigest: string): JsonValue {
  let payload: z.infer<typeof CursorPayloadSchema>;
  try {
    const envelope = CursorEnvelopeSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    if (envelope.checksum !== digest(canonicalJson(envelope.payload))) throw new Error("checksum mismatch");
    payload = envelope.payload;
  } catch (cause) {
    throw new ViewQueryError("View query cursor is malformed", "view_query_cursor_invalid", { cause });
  }
  if (canonicalJson(payload.subject) !== canonicalJson(request.subject)
    || canonicalJson(payload.profile) !== canonicalJson(request.profile)
    || payload.parameters_digest !== parametersDigest) {
    throw new ViewQueryError("View query cursor does not belong to this request", "view_query_cursor_mismatch");
  }
  return payload.method_cursor;
}

function profileKey(profile: ViewQueryProfile): string {
  return `${profile.id}@${profile.version}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function uniqueRefs(refs: ExactViewRef[]): ExactViewRef[] {
  const values = new Map(refs.map(ref => [refKey(ref), ref]));
  return [...values.values()].sort((left, right) => left.view_id.localeCompare(right.view_id) || left.revision - right.revision);
}

function refKey(ref: ExactViewRef): string {
  return `${ref.view_id}@${ref.revision}`;
}

function ajvErrors(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map(issue => `${issue.instancePath || "/"} ${issue.message ?? issue.keyword}`)
    .join("; ");
}
