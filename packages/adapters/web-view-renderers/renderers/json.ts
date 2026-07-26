import { createElement, type ReactNode } from "react";
import type { WebRendererHostV1, WebRendererInput } from "../contracts.js";
import { createReactRendererFactory } from "./react-factory.js";

export function renderJsonView(input: WebRendererInput): ReactNode {
  if (input.representation.form !== "inline") {
    throw new TypeError("The generic JSON renderer requires an inline Representation");
  }
  return createElement("pre", {
    className: "metaflow-renderer metaflow-renderer-json",
    "data-renderer": "renderer.web.json@1@1",
  }, JSON.stringify(input.representation.value, null, 2));
}

export const jsonRendererFactory = createReactRendererFactory((input: WebRendererInput, _host: WebRendererHostV1) =>
  renderJsonView(input));
