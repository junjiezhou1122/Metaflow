import { IdentifierSchema, JsonValueSchema, type JsonValue } from "@info/view/schema";
import {
  AuthorizedAssetRequestSchema,
  MAX_WEB_RENDERER_ASSET_BYTES,
  ResolvedAssetSchema,
  SafeLinkRequestSchema,
  operationEnvelope,
  type AuthorizedAssetRequest,
  type RendererHostServices,
  type ResolvedAsset,
  type SafeLinkRequest,
  type WebRendererHostV1,
  type WebRendererInput,
} from "./contracts.js";
import { WebRendererError } from "./errors.js";

export type HostLifecycleDetail = Readonly<Record<string, unknown>> & { event: string };

export type WebRendererHostSession = {
  host: WebRendererHostV1;
  releaseAssets(): Promise<void>;
};

export function createWebRendererHostSession(input: {
  rendererInput: WebRendererInput;
  declaredMethodIds: readonly string[];
  services: RendererHostServices;
  emit(detail: HostLifecycleDetail): void;
}): WebRendererHostSession {
  const declaredMethods = parseDeclaredMethods(input.declaredMethodIds);
  const materializations = new Map(input.rendererInput.materializations.map(item => [item.asset_id, item]));
  const resolvedAssets = new Map<string, ResolvedAsset>();
  const now = input.services.monotonicNow ?? defaultMonotonicNow;
  const host: WebRendererHostV1 = Object.freeze({
    async resolveAsset(requestInput: AuthorizedAssetRequest, signal: AbortSignal): Promise<ResolvedAsset> {
      assertNotAborted(signal);
      const startedAt = now();
      const parsed = AuthorizedAssetRequestSchema.safeParse(requestInput);
      if (!parsed.success) {
        input.emit({ event: "renderer.asset.failed", error_code: "asset_not_authorized", duration_ms: elapsed(startedAt, now()) });
        throw new WebRendererError("Renderer asset request failed validation", "asset_not_authorized", {
          issue_count: parsed.error.issues.length,
        }, { cause: parsed.error });
      }
      const request = parsed.data;
      const materialization = materializations.get(request.asset_id);
      if (!materialization
        || !request.accepted_media_types.includes(materialization.media_type)
        || request.max_bytes > MAX_WEB_RENDERER_ASSET_BYTES
        || materialization.max_bytes > MAX_WEB_RENDERER_ASSET_BYTES
        || request.max_bytes > materialization.max_bytes
        || (materialization.byte_length !== undefined && materialization.byte_length > request.max_bytes)) {
        input.emit({ event: "renderer.asset.failed", error_code: "asset_not_authorized", duration_ms: elapsed(startedAt, now()) });
        throw new WebRendererError(`Renderer asset is not authorized: ${request.asset_id}`, "asset_not_authorized", {
          asset_id: request.asset_id,
        });
      }

      let resolved: ResolvedAsset;
      try {
        resolved = ResolvedAssetSchema.parse(await input.services.resolveAsset({ request, materialization }, signal));
      } catch (error) {
        if (signal.aborted) throw abortedError();
        input.emit({ event: "renderer.asset.failed", error_code: "asset_resolution_failed", duration_ms: elapsed(startedAt, now()) });
        throw new WebRendererError(`Renderer asset resolution failed: ${request.asset_id}`, "asset_resolution_failed", {
          asset_id: request.asset_id,
        }, { cause: error });
      }
      if (signal.aborted) {
        await releaseRejectedAsset(input.services, resolved);
        throw abortedError();
      }
      if (resolved.asset_id !== materialization.asset_id
        || resolved.media_type !== materialization.media_type
        || resolved.byte_length > MAX_WEB_RENDERER_ASSET_BYTES
        || resolved.byte_length > request.max_bytes
        || resolved.byte_length > materialization.max_bytes
        || (materialization.byte_length !== undefined && resolved.byte_length !== materialization.byte_length)) {
        const cleanupFailures: unknown[] = [];
        try {
          await releaseRejectedAsset(input.services, resolved);
        } catch (error) {
          cleanupFailures.push(error);
        }
        const emissionFailure = captureFailure(() => input.emit({
          event: "renderer.asset.failed",
          error_code: "asset_resolution_failed",
          duration_ms: elapsed(startedAt, now()),
        }));
        if (emissionFailure !== undefined) cleanupFailures.push(emissionFailure);
        throw new WebRendererError(`Renderer asset response exceeded its authorization: ${request.asset_id}`, "asset_resolution_failed", {
          asset_id: request.asset_id,
        }, { cause: aggregateFailures(cleanupFailures, "Rejected asset cleanup failed") });
      }
      resolvedAssets.set(`${resolved.asset_id}:${resolved.object_url}`, resolved);
      input.emit({
        event: "renderer.asset.resolved",
        asset_id: resolved.asset_id,
        media_type: resolved.media_type,
        byte_length: resolved.byte_length,
        duration_ms: elapsed(startedAt, now()),
      });
      return resolved;
    },

    async invokeMethod(methodIdInput: string, methodInput: JsonValue, signal: AbortSignal) {
      assertNotAborted(signal);
      const startedAt = now();
      const methodId = IdentifierSchema.safeParse(methodIdInput);
      const methodValue = JsonValueSchema.safeParse(methodInput);
      if (!methodId.success || !methodValue.success || !declaredMethods.has(methodIdInput)) {
        input.emit({ event: "renderer.method.failed", error_code: "method_not_declared", duration_ms: elapsed(startedAt, now()) });
        throw new WebRendererError(`Renderer Method is not declared: ${String(methodIdInput)}`, "method_not_declared", {
          method_id: String(methodIdInput).slice(0, 240),
        });
      }
      try {
        const envelope = operationEnvelope(await input.services.invokeMethod({
          method_id: methodId.data,
          input: methodValue.data,
        }, signal));
        assertNotAborted(signal);
        input.emit({
          event: "renderer.method.invoked",
          method_id: methodId.data,
          ok: envelope.ok,
          duration_ms: elapsed(startedAt, now()),
        });
        return envelope;
      } catch (error) {
        if (signal.aborted) throw abortedError();
        input.emit({ event: "renderer.method.failed", error_code: "method_invocation_failed", duration_ms: elapsed(startedAt, now()) });
        throw new WebRendererError(`Renderer Method invocation failed: ${methodId.data}`, "method_invocation_failed", {
          method_id: methodId.data,
        }, { cause: error });
      }
    },

    async openLink(requestInput: SafeLinkRequest, signal: AbortSignal): Promise<void> {
      assertNotAborted(signal);
      const startedAt = now();
      const parsed = SafeLinkRequestSchema.safeParse(requestInput);
      if (!parsed.success) {
        input.emit({ event: "renderer.link.failed", error_code: "unsafe_link", duration_ms: elapsed(startedAt, now()) });
        throw new WebRendererError("Renderer link request is unsafe", "unsafe_link", {
          issue_count: parsed.error.issues.length,
        }, { cause: parsed.error });
      }
      try {
        await input.services.openLink(parsed.data, signal);
        assertNotAborted(signal);
      } catch (error) {
        if (signal.aborted) throw abortedError();
        input.emit({ event: "renderer.link.failed", error_code: "link_open_failed", duration_ms: elapsed(startedAt, now()) });
        throw new WebRendererError("Renderer link open failed", "link_open_failed", {}, { cause: error });
      }
      input.emit({
        event: "renderer.link.opened",
        protocol: new URL(parsed.data.href).protocol,
        duration_ms: elapsed(startedAt, now()),
      });
    },
  });

  return {
    host,
    async releaseAssets(): Promise<void> {
      if (resolvedAssets.size === 0) return;
      const assets = [...resolvedAssets.values()];
      resolvedAssets.clear();
      const results = await Promise.allSettled(assets.map(asset => input.services.releaseAsset(asset)));
      const failures = results.filter(result => result.status === "rejected");
      if (failures.length > 0) {
        throw new AggregateError(failures.map(result => (result as PromiseRejectedResult).reason), "Renderer asset release failed");
      }
    },
  };
}

function parseDeclaredMethods(values: readonly string[]): ReadonlySet<string> {
  const parsed = IdentifierSchema.array().safeParse(values);
  if (!parsed.success || new Set(parsed.success ? parsed.data : []).size !== values.length) {
    throw new WebRendererError("Declared Renderer Methods failed validation", "invalid_input", {
      method_count: values.length,
    }, parsed.success ? undefined : { cause: parsed.error });
  }
  return new Set(parsed.data);
}

function captureFailure(operation: () => void): unknown | undefined {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error ?? new Error("Renderer lifecycle observer threw without an error value");
  }
}

function aggregateFailures(failures: readonly unknown[], message: string): unknown | undefined {
  if (failures.length === 0) return undefined;
  if (failures.length === 1) return failures[0];
  return new AggregateError(failures, message);
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortedError();
}

function abortedError(): WebRendererError {
  return new WebRendererError("Renderer operation was aborted", "aborted");
}

function defaultMonotonicNow(): number {
  return performance.now();
}

function elapsed(startedAt: number, endedAt: number): number {
  return Math.max(0, endedAt - startedAt);
}

async function releaseRejectedAsset(services: RendererHostServices, asset: ResolvedAsset): Promise<void> {
  try {
    await services.releaseAsset(asset);
  } catch (error) {
    throw new WebRendererError(`Rejected Renderer asset could not be released: ${asset.asset_id}`, "asset_resolution_failed", {
      asset_id: asset.asset_id,
    }, { cause: error });
  }
}
