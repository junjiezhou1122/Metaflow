import { createElement, useEffect, useState, type ReactNode } from "react";
import {
  MAX_WEB_RENDERER_ASSET_BYTES,
  type ResolvedAsset,
  type WebRendererHostV1,
  type WebRendererInput,
} from "../contracts.js";
import { WebRendererError } from "../errors.js";
import { createReactRendererFactory } from "./react-factory.js";

export function renderImageView(
  input: WebRendererInput,
  host: WebRendererHostV1,
  signal: AbortSignal,
): ReactNode {
  return createElement(ImageView, { input, host, signal });
}

export const imageRendererFactory = createReactRendererFactory(renderImageView);

function ImageView(props: {
  input: WebRendererInput;
  host: WebRendererHostV1;
  signal: AbortSignal;
}): ReactNode {
  const mediaType = props.input.representation.media_type;
  if (!mediaType?.startsWith("image/")) {
    throw new TypeError("The image renderer requires an image media type");
  }
  const materialization = props.input.materializations.find(item => item.media_type === mediaType);
  if (!materialization) throw new TypeError(`No authorized image asset is declared for ${mediaType}`);
  const [asset, setAsset] = useState<ResolvedAsset>();
  const [errorCode, setErrorCode] = useState<string>();

  useEffect(() => {
    let active = true;
    void props.host.resolveAsset({
      contract_version: 1,
      asset_id: materialization.asset_id,
      accepted_media_types: [mediaType],
      max_bytes: Math.min(materialization.byte_length ?? materialization.max_bytes, materialization.max_bytes, MAX_WEB_RENDERER_ASSET_BYTES),
    }, props.signal).then(
      value => {
        if (active) setAsset(value);
      },
      error => {
        if (active) setErrorCode(error instanceof WebRendererError ? error.code : "asset_resolution_failed");
      },
    );
    return () => {
      active = false;
    };
  }, [materialization.asset_id, materialization.byte_length, materialization.max_bytes, mediaType, props.host, props.signal]);

  if (errorCode) {
    return createElement("div", {
      className: "metaflow-renderer metaflow-renderer-image-error",
      role: "alert",
      "data-error-code": errorCode,
    }, "Image could not be loaded.");
  }
  if (!asset) {
    return createElement("div", {
      className: "metaflow-renderer metaflow-renderer-image-loading",
      role: "status",
    }, "Loading image");
  }
  return createElement("figure", {
    className: "metaflow-renderer metaflow-renderer-image",
    "data-renderer": "renderer.web.image@1@1",
  }, createElement("img", {
    alt: props.input.envelope.name,
    decoding: "async",
    src: asset.object_url,
    style: { display: "block", height: "auto", maxHeight: "100%", maxWidth: "100%", objectFit: "contain" },
  }));
}
