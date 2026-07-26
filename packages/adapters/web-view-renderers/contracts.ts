import { z } from "zod";
import {
  ExactViewRefSchema,
  IdentifierSchema,
  JsonValueSchema,
  TimestampSchema,
  ViewSchemaRefSchema,
  type ExactViewRef,
  type JsonValue,
  type ViewSchemaRef,
} from "@info/view/schema";
import type { OperationEnvelope } from "@info/operations";

export const WEB_RENDERER_ABI_VERSION = 1 as const;
export const MAX_WEB_RENDERER_ASSET_BYTES = 64 * 1024 * 1024;

export const WebRendererIdentitySchema = z.object({
  id: IdentifierSchema,
  version: z.number().int().positive(),
  abi_version: z.number().int().positive(),
}).strict();

export const WebRendererDescriptorSchema = z.object({
  ...WebRendererIdentitySchema.shape,
  schema: z.object({
    name: IdentifierSchema,
    version: z.number().int().positive(),
  }).strict(),
  surfaces: z.array(z.enum(["web", "native", "generic"])).min(1),
  representation_kinds: z.array(IdentifierSchema).min(1),
  media_types: z.array(z.string().trim().min(1)).min(1).optional(),
  priority: z.number().int(),
}).strict();

export const WebViewEnvelopeSummarySchema = z.object({
  contract_version: z.literal(1),
  name: z.string().trim().min(1).max(500),
  purpose: z.string().trim().min(1).max(2_000),
  schema: ViewSchemaRefSchema,
  role: z.enum(["raw", "derived"]),
  time: z.object({
    observed_at: TimestampSchema.optional(),
    created_at: TimestampSchema,
  }).strict(),
}).strict();

export const AuthorizedMaterializationSchema = z.object({
  asset_id: IdentifierSchema,
  format: IdentifierSchema,
  media_type: z.string().trim().min(1),
  max_bytes: z.number().int().positive().max(MAX_WEB_RENDERER_ASSET_BYTES),
  byte_length: z.number().int().nonnegative().max(MAX_WEB_RENDERER_ASSET_BYTES).optional(),
}).strict().superRefine((materialization, context) => {
  if (materialization.byte_length !== undefined && materialization.byte_length > materialization.max_bytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["byte_length"],
      message: "materialization byte length exceeds its authorized maximum",
    });
  }
});

const RendererRepresentationBaseShape = {
  kind: IdentifierSchema,
  media_type: z.string().trim().min(1).optional(),
} as const;

export const RendererRepresentationSchema = z.discriminatedUnion("form", [
  z.object({
    ...RendererRepresentationBaseShape,
    form: z.literal("inline"),
    value: JsonValueSchema,
  }).strict(),
  z.object({
    ...RendererRepresentationBaseShape,
    form: z.literal("external_reference"),
    asset_id: IdentifierSchema,
  }).strict(),
]);

export const WebRendererInputSchema = z.object({
  contract_version: z.literal(1),
  view: ExactViewRefSchema,
  envelope: WebViewEnvelopeSummarySchema,
  representation: RendererRepresentationSchema,
  materializations: z.array(AuthorizedMaterializationSchema).max(64),
  mode: z.enum(["preview", "full"]),
}).strict().superRefine((input, context) => {
  const assetIds = input.materializations.map(item => item.asset_id);
  if (new Set(assetIds).size !== assetIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["materializations"],
      message: "authorized materialization asset ids must be unique",
    });
  }
  if (input.representation.form === "external_reference"
    && !assetIds.includes(input.representation.asset_id)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["representation", "asset_id"],
      message: "external renderer Representation must name an authorized materialization asset",
    });
  }
});

export const DeclaredMethodIdsSchema = z.array(IdentifierSchema).max(128).superRefine((methodIds, context) => {
  if (new Set(methodIds).size !== methodIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "declared Renderer Method ids must be unique" });
  }
});

const RendererOperationErrorSchema = z.object({
  code: IdentifierSchema,
  message: z.string().trim().min(1).max(2_000),
  category: z.enum(["invalid_request", "forbidden", "not_found", "conflict", "failed_dependency", "internal"]),
  details: z.record(JsonValueSchema),
}).strict();

export const RendererOperationEnvelopeSchema = z.union([
  z.object({
    ok: z.literal(true),
    request_id: IdentifierSchema,
    operation: IdentifierSchema,
    data: JsonValueSchema,
  }).strict(),
  z.object({
    ok: z.literal(false),
    request_id: IdentifierSchema,
    operation: IdentifierSchema.optional(),
    error: RendererOperationErrorSchema,
  }).strict(),
]);

export const AuthorizedAssetRequestSchema = z.object({
  contract_version: z.literal(1),
  asset_id: IdentifierSchema,
  accepted_media_types: z.array(z.string().trim().min(1)).min(1).max(32),
  max_bytes: z.number().int().positive().max(MAX_WEB_RENDERER_ASSET_BYTES),
}).strict();

export const ResolvedAssetSchema = z.object({
  contract_version: z.literal(1),
  asset_id: IdentifierSchema,
  object_url: z.string().trim().min(1).refine(value => value.startsWith("blob:"), {
    message: "renderer assets must use host-created blob URLs",
  }),
  media_type: z.string().trim().min(1),
  byte_length: z.number().int().nonnegative(),
}).strict();

export const SafeLinkRequestSchema = z.object({
  contract_version: z.literal(1),
  href: z.string().trim().min(1).max(8_192),
  disposition: z.enum(["same_context", "new_context"]),
}).strict().superRefine((request, context) => {
  let url: URL;
  try {
    url = new URL(request.href);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["href"], message: "link must be an absolute URL" });
    return;
  }
  if (url.protocol !== "https:" && url.protocol !== "mailto:") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["href"], message: "link protocol is not allowed" });
  }
  if (url.username || url.password) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["href"], message: "link credentials are not allowed" });
  }
});

const LifecycleBaseShape = {
  contract_version: z.literal(1),
  occurred_at: TimestampSchema,
  renderer: WebRendererIdentitySchema,
  view: ExactViewRefSchema,
  surface: z.literal("web"),
  mode: z.enum(["preview", "full"]),
} as const;

const DurationSchema = z.number().finite().nonnegative();
const ErrorCodeSchema = IdentifierSchema;

export const RendererLifecycleEventSchema = z.discriminatedUnion("event", [
  z.object({ ...LifecycleBaseShape, event: z.literal("renderer.load.started") }).strict(),
  z.object({ ...LifecycleBaseShape, event: z.literal("renderer.load.succeeded"), duration_ms: DurationSchema }).strict(),
  z.object({ ...LifecycleBaseShape, event: z.literal("renderer.load.failed"), duration_ms: DurationSchema, error_code: ErrorCodeSchema }).strict(),
  z.object({ ...LifecycleBaseShape, event: z.literal("renderer.mount.started") }).strict(),
  z.object({ ...LifecycleBaseShape, event: z.literal("renderer.ready"), duration_ms: DurationSchema }).strict(),
  z.object({ ...LifecycleBaseShape, event: z.literal("renderer.mount.failed"), duration_ms: DurationSchema, error_code: ErrorCodeSchema }).strict(),
  z.object({ ...LifecycleBaseShape, event: z.literal("renderer.aborted"), stage: z.enum(["load", "mount", "active"]) }).strict(),
  z.object({
    ...LifecycleBaseShape,
    event: z.literal("renderer.asset.resolved"),
    asset_id: IdentifierSchema,
    media_type: z.string().trim().min(1),
    byte_length: z.number().int().nonnegative(),
    duration_ms: DurationSchema,
  }).strict(),
  z.object({
    ...LifecycleBaseShape,
    event: z.literal("renderer.asset.failed"),
    error_code: z.enum(["asset_not_authorized", "asset_resolution_failed"]),
    duration_ms: DurationSchema,
  }).strict(),
  z.object({
    ...LifecycleBaseShape,
    event: z.literal("renderer.method.invoked"),
    method_id: IdentifierSchema,
    ok: z.boolean(),
    duration_ms: DurationSchema,
  }).strict(),
  z.object({
    ...LifecycleBaseShape,
    event: z.literal("renderer.method.failed"),
    error_code: z.enum(["method_not_declared", "method_invocation_failed"]),
    duration_ms: DurationSchema,
  }).strict(),
  z.object({
    ...LifecycleBaseShape,
    event: z.literal("renderer.link.opened"),
    protocol: z.enum(["https:", "mailto:"]),
    duration_ms: DurationSchema,
  }).strict(),
  z.object({
    ...LifecycleBaseShape,
    event: z.literal("renderer.link.failed"),
    error_code: z.enum(["unsafe_link", "link_open_failed"]),
    duration_ms: DurationSchema,
  }).strict(),
  z.object({ ...LifecycleBaseShape, event: z.literal("renderer.dispose.started") }).strict(),
  z.object({ ...LifecycleBaseShape, event: z.literal("renderer.dispose.succeeded"), duration_ms: DurationSchema }).strict(),
  z.object({ ...LifecycleBaseShape, event: z.literal("renderer.dispose.failed"), duration_ms: DurationSchema, error_code: ErrorCodeSchema }).strict(),
]);

export type WebRendererIdentity = z.infer<typeof WebRendererIdentitySchema>;
export type WebRendererDescriptor = z.infer<typeof WebRendererDescriptorSchema>;
export type WebViewEnvelopeSummary = z.infer<typeof WebViewEnvelopeSummarySchema>;
export type AuthorizedMaterialization = z.infer<typeof AuthorizedMaterializationSchema>;
export type RendererRepresentation = z.infer<typeof RendererRepresentationSchema>;
export type WebRendererInput = z.infer<typeof WebRendererInputSchema>;
export type AuthorizedAssetRequest = z.infer<typeof AuthorizedAssetRequestSchema>;
export type ResolvedAsset = z.infer<typeof ResolvedAssetSchema>;
export type SafeLinkRequest = z.infer<typeof SafeLinkRequestSchema>;
export type RendererLifecycleEvent = z.infer<typeof RendererLifecycleEventSchema>;

export interface WebRendererHostV1 {
  resolveAsset(request: AuthorizedAssetRequest, signal: AbortSignal): Promise<ResolvedAsset>;
  invokeMethod(methodId: string, input: JsonValue, signal: AbortSignal): Promise<OperationEnvelope>;
  openLink(request: SafeLinkRequest, signal: AbortSignal): Promise<void>;
}

export interface WebRendererDisposableV1 {
  dispose(): void | Promise<void>;
}

export interface WebRendererFactoryV1 {
  mount(
    container: HTMLElement,
    input: WebRendererInput,
    host: WebRendererHostV1,
    signal: AbortSignal,
  ): Promise<WebRendererDisposableV1>;
}

export type WebRendererRegistration = {
  descriptor: WebRendererIdentity;
  load(): Promise<unknown>;
};

export type RendererHostServices = {
  resolveAsset(input: {
    request: AuthorizedAssetRequest;
    materialization: AuthorizedMaterialization;
  }, signal: AbortSignal): Promise<ResolvedAsset>;
  releaseAsset(asset: ResolvedAsset): void | Promise<void>;
  invokeMethod(input: { method_id: string; input: JsonValue }, signal: AbortSignal): Promise<OperationEnvelope>;
  openLink(request: SafeLinkRequest, signal: AbortSignal): void | Promise<void>;
  emit(event: RendererLifecycleEvent): void;
  reportBackgroundError(error: Error): void;
  now?: () => Date;
  monotonicNow?: () => number;
};

export type MountWebRendererRequest = {
  descriptors: readonly unknown[];
  input: unknown;
  declared_method_ids: readonly string[];
  container: HTMLElement;
  services: RendererHostServices;
  signal: AbortSignal;
};

export type MountedWebRenderer = {
  descriptor: WebRendererDescriptor;
  disposed: Promise<void>;
  dispose(): Promise<void>;
};

export function rendererIdentityKey(identity: WebRendererIdentity): string {
  return `${identity.id}@${identity.version}@${identity.abi_version}`;
}

export function operationEnvelope(value: unknown): OperationEnvelope {
  return RendererOperationEnvelopeSchema.parse(value) as OperationEnvelope;
}

export type RendererViewRef = ExactViewRef;
export type RendererSchema = ViewSchemaRef;
