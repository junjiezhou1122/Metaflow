import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import {
  ViewDraftSchema,
  ViewRevisionSchema,
  SOURCE_TOMBSTONE_REPRESENTATION_KIND,
  SourceTombstoneRepresentationValueSchema,
  type JsonValue,
  type View,
  type ViewDraft,
  type ViewRepresentation,
  type ViewSchemaRef,
} from "./schema.js";

export type ViewValidationCode =
  | "invalid_envelope"
  | "invalid_strict_schema"
  | "representation_schema_mismatch";

export class ViewValidationError extends Error {
  constructor(
    message: string,
    readonly code: ViewValidationCode,
    readonly issues: z.ZodIssue[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ViewValidationError";
  }
}

const ajv = new Ajv2020({
  addUsedSchema: false,
  allErrors: true,
  strict: true,
  validateSchema: true,
});
const validators = new Map<string, ValidateFunction>();

export function representationSemanticValue(representation: ViewRepresentation): JsonValue {
  if (representation.form === "inline") return representation.value;
  return {
    uri: representation.uri,
    ...(representation.media_type ? { media_type: representation.media_type } : {}),
    ...(representation.digest ? { digest: representation.digest } : {}),
    ...(Object.keys(representation.metadata).length > 0 ? { metadata: representation.metadata } : {}),
  };
}

function validatorFor(schema: Extract<ViewSchemaRef, { mode: "strict" }>): ValidateFunction {
  const key = `${schema.name}@${schema.version}:${canonicalJson(schema.json_schema)}`;
  const cached = validators.get(key);
  if (cached) return cached;

  try {
    const validator = ajv.compile(schema.json_schema as boolean | object);
    validators.set(key, validator);
    return validator;
  } catch (error) {
    throw new ViewValidationError(
      `invalid strict View Schema ${schema.name}@${schema.version}`,
      "invalid_strict_schema",
      [customIssue(["schema", "json_schema"], error instanceof Error ? error.message : String(error))],
      { cause: error },
    );
  }
}

export function validateViewRepresentation(
  schema: ViewSchemaRef,
  representation: ViewRepresentation,
): void {
  if (representation.kind === SOURCE_TOMBSTONE_REPRESENTATION_KIND) {
    if (representation.form !== "inline") {
      throw new ViewValidationError(
        "Source tombstone Representation must be inline",
        "invalid_envelope",
        [customIssue(["representation", "form"], "source tombstone must be inline")],
      );
    }
    const tombstone = SourceTombstoneRepresentationValueSchema.safeParse(representation.value);
    if (!tombstone.success) {
      throw new ViewValidationError(
        "Source tombstone Representation is invalid",
        "invalid_envelope",
        tombstone.error.issues,
      );
    }
    return;
  }
  if (schema.mode === "freeform") return;
  const validator = validatorFor(schema);
  if (validator(representationSemanticValue(representation))) return;

  throw new ViewValidationError(
    `View Representation does not satisfy strict Schema ${schema.name}@${schema.version}`,
    "representation_schema_mismatch",
    (validator.errors ?? []).map(ajvIssue),
  );
}

function ajvIssue(error: ErrorObject): z.ZodIssue {
  const instancePath = error.instancePath
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  return customIssue(["representation", ...instancePath], `${error.keyword}: ${error.message ?? "validation failed"}`);
}

function customIssue(path: Array<string | number>, message: string): z.ZodIssue {
  return { code: z.ZodIssueCode.custom, path, message };
}

export function parseViewDraft(input: unknown): ViewDraft {
  const parsed = ViewDraftSchema.safeParse(input);
  if (!parsed.success) {
    throw new ViewValidationError("invalid View draft", "invalid_envelope", parsed.error.issues);
  }
  validateViewRepresentation(parsed.data.schema, parsed.data.representation);
  return parsed.data;
}

export function parseView(input: unknown): View {
  const parsed = ViewRevisionSchema.safeParse(input);
  if (!parsed.success) {
    throw new ViewValidationError("invalid View", "invalid_envelope", parsed.error.issues);
  }
  validateViewRepresentation(parsed.data.schema, parsed.data.representation);
  return parsed.data;
}
