import {
  canonicalJson,
  type JsonObject,
  type JsonValue,
  type View,
} from "@info/view";
import type { SourceConnection } from "@info/capture";
import { ScreenpipeConnectionConfigurationSchema } from "./contracts.js";
import type { ScreenpipeSecretResolver } from "./adapter.js";

export const SCREENPIPE_MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024;
export const SCREENPIPE_MIN_THUMBNAIL_WIDTH = 384;
export const SCREENPIPE_MAX_THUMBNAIL_WIDTH = 1920;
export const SCREENPIPE_DEFAULT_THUMBNAIL_WIDTH = 1440;
export const SCREENPIPE_MIN_THUMBNAIL_QUALITY = 60;
export const SCREENPIPE_MAX_THUMBNAIL_QUALITY = 95;
export const SCREENPIPE_DEFAULT_THUMBNAIL_QUALITY = 90;
const SCREENPIPE_THUMBNAIL_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type ScreenpipeThumbnailRequest = {
  width?: number;
  quality?: number;
};

type FetchLike = typeof fetch;

export class ScreenpipeAssetError extends Error {
  constructor(
    message: string,
    readonly code:
      | "screenpipe_asset_view_invalid"
      | "screenpipe_asset_reference_invalid"
      | "screenpipe_asset_forbidden"
      | "screenpipe_asset_http_error"
      | "screenpipe_asset_too_large"
      | "screenpipe_asset_media_type_invalid",
    readonly status: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ScreenpipeAssetError";
  }
}

export class ScreenpipeFrameAssetResolver {
  private readonly fetch: FetchLike;

  constructor(private readonly options: {
    connection: SourceConnection;
    secret_resolver?: ScreenpipeSecretResolver;
    fetch?: FetchLike;
  }) {
    this.fetch = options.fetch ?? fetch;
  }

  async thumbnail(
    view: View,
    request: ScreenpipeThumbnailRequest = {},
    signal?: AbortSignal,
  ): Promise<{
    body: Uint8Array;
    media_type: string;
    etag?: string;
  }> {
    if (view.role !== "raw" || view.schema.name !== "capture.screenpipe.frame_ocr"
      || view.provenance.capture?.connector !== "screenpipe"
      || view.provenance.capture.connection_id !== this.options.connection.id
      || view.representation.form !== "inline") {
      throw new ScreenpipeAssetError("Exact View is not an authorized Screenpipe frame", "screenpipe_asset_view_invalid", 400);
    }
    const metadata = view.representation.metadata as JsonObject;
    const external = objectValue(metadata.external_media);
    const logicalUri = stringValue(external?.uri);
    if (external?.kind !== "screenpipe_frame" || !logicalUri) {
      throw new ScreenpipeAssetError("Screenpipe frame View has no logical media reference", "screenpipe_asset_reference_invalid", 400);
    }
    const frameId = frameIdFromUri(logicalUri, this.options.connection.id);
    const endpoint = endpointFor(this.options.connection);
    const authorization = await this.authorization();
    const width = boundedInteger(
      request.width ?? SCREENPIPE_DEFAULT_THUMBNAIL_WIDTH,
      SCREENPIPE_MIN_THUMBNAIL_WIDTH,
      SCREENPIPE_MAX_THUMBNAIL_WIDTH,
      "width",
    );
    const quality = boundedInteger(
      request.quality ?? SCREENPIPE_DEFAULT_THUMBNAIL_QUALITY,
      SCREENPIPE_MIN_THUMBNAIL_QUALITY,
      SCREENPIPE_MAX_THUMBNAIL_QUALITY,
      "quality",
    );
    const assetUrl = new URL(`/frames/${frameId}/thumbnail`, `${endpoint}/`);
    assetUrl.searchParams.set("width", String(width));
    assetUrl.searchParams.set("quality", String(quality));
    const response = await this.fetch(assetUrl, {
      signal,
      headers: {
        accept: "image/jpeg,image/png,image/webp",
        ...(authorization ? { authorization } : {}),
      },
    });
    if (!response.ok) {
      throw new ScreenpipeAssetError(
        `Screenpipe frame thumbnail returned HTTP ${response.status}`,
        response.status === 401 || response.status === 403 ? "screenpipe_asset_forbidden" : "screenpipe_asset_http_error",
        response.status === 401 || response.status === 403 ? 403 : 502,
      );
    }
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (!mediaType || !SCREENPIPE_THUMBNAIL_MEDIA_TYPES.has(mediaType)) {
      throw new ScreenpipeAssetError("Screenpipe thumbnail response has an unsupported media type", "screenpipe_asset_media_type_invalid", 502);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > SCREENPIPE_MAX_THUMBNAIL_BYTES) {
      await response.body?.cancel();
      throw new ScreenpipeAssetError("Screenpipe thumbnail exceeds the byte limit", "screenpipe_asset_too_large", 413);
    }
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > SCREENPIPE_MAX_THUMBNAIL_BYTES) {
      throw new ScreenpipeAssetError("Screenpipe thumbnail exceeds the byte limit", "screenpipe_asset_too_large", 413);
    }
    const etag = response.headers.get("etag") ?? undefined;
    return { body, media_type: mediaType, ...(etag ? { etag } : {}) };
  }

  private async authorization(): Promise<string | undefined> {
    const configuration = ScreenpipeConnectionConfigurationSchema.parse(this.options.connection.configuration);
    if (configuration.authentication.mode === "none") return undefined;
    const ref = configuration.authentication.secret_ref;
    if (Object.keys(this.options.connection.secret_refs).length !== 1
      || canonicalJson(this.options.connection.secret_refs.screenpipe_api_key) !== canonicalJson(ref)
      || !this.options.secret_resolver) {
      throw new ScreenpipeAssetError("Screenpipe asset credentials are not configured", "screenpipe_asset_forbidden", 403);
    }
    const token = (await this.options.secret_resolver.resolve(ref)).trim();
    if (!token || /[\r\n]/u.test(token)) {
      throw new ScreenpipeAssetError("Screenpipe asset credential is invalid", "screenpipe_asset_forbidden", 403);
    }
    return `Bearer ${token}`;
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ScreenpipeAssetError(
      `Screenpipe thumbnail ${field} must be an integer from ${minimum} through ${maximum}`,
      "screenpipe_asset_reference_invalid",
      400,
    );
  }
  return value;
}

function frameIdFromUri(value: string, connectionId: string): number {
  let uri: URL;
  try {
    uri = new URL(value);
  } catch (cause) {
    throw new ScreenpipeAssetError("Screenpipe media reference is malformed", "screenpipe_asset_reference_invalid", 400, { cause });
  }
  let logicalConnection: string;
  try {
    logicalConnection = decodeURIComponent(uri.hostname);
  } catch (cause) {
    throw new ScreenpipeAssetError("Screenpipe media reference is malformed", "screenpipe_asset_reference_invalid", 400, { cause });
  }
  const match = uri.pathname.match(/^\/frame\/(\d+)$/u);
  const frameId = match ? Number(match[1]) : Number.NaN;
  if (uri.protocol !== "screenpipe:" || logicalConnection !== connectionId || !Number.isSafeInteger(frameId) || frameId < 0) {
    throw new ScreenpipeAssetError("Screenpipe media reference does not match the configured connection", "screenpipe_asset_reference_invalid", 400);
  }
  return frameId;
}

function endpointFor(connection: SourceConnection): string {
  if (!connection.endpoint) {
    throw new ScreenpipeAssetError("Screenpipe asset connection has no endpoint", "screenpipe_asset_reference_invalid", 400);
  }
  const endpoint = new URL(connection.endpoint);
  if ((endpoint.protocol !== "http:" && endpoint.protocol !== "https:") || endpoint.username || endpoint.password) {
    throw new ScreenpipeAssetError("Screenpipe asset endpoint is invalid", "screenpipe_asset_reference_invalid", 400);
  }
  return endpoint.toString().replace(/\/$/u, "");
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
