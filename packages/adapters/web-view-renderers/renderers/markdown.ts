import { createElement, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SafeLinkRequest, WebRendererHostV1, WebRendererInput } from "../contracts.js";
import { WebRendererError } from "../errors.js";
import { createReactRendererFactory } from "./react-factory.js";

const ALLOWED_MARKDOWN_ELEMENTS = [
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "li", "ol", "p", "pre", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul",
] as const;

export function renderMarkdownView(
  input: WebRendererInput,
  host: WebRendererHostV1,
  signal: AbortSignal,
): ReactNode {
  return createElement(MarkdownView, { input, host, signal });
}

function MarkdownView(props: {
  input: WebRendererInput;
  host: WebRendererHostV1;
  signal: AbortSignal;
}): ReactNode {
  const { input, host, signal } = props;
  if (input.representation.form !== "inline" || typeof input.representation.value !== "string") {
    throw new TypeError("The Markdown renderer requires an inline string Representation");
  }
  const [linkErrorCode, setLinkErrorCode] = useState<string>();
  const components = useMemo<Components>(() => ({
    a({ href, children }) {
      const safeHref = href && parseSafeMarkdownHref(href);
      if (!safeHref) return createElement("span", null, children);
      return createElement("a", {
        href: safeHref,
        onClick(event: MouseEvent<HTMLAnchorElement>) {
          event.preventDefault();
          const request: SafeLinkRequest = {
            contract_version: 1,
            href: safeHref,
            disposition: event.metaKey || event.ctrlKey ? "new_context" : "same_context",
          };
          void openMarkdownLink(host, request, signal, setLinkErrorCode);
        },
      }, children);
    },
    img({ alt }) {
      return createElement("span", { role: "note" }, alt ? `[Image: ${alt}]` : "[Image omitted]");
    },
  }), [host, signal]);
  return createElement("article", {
    className: "metaflow-renderer metaflow-renderer-markdown",
    "data-renderer": "renderer.web.markdown@1@1",
  }, createElement(ReactMarkdown, {
    allowedElements: [...ALLOWED_MARKDOWN_ELEMENTS],
    components,
    remarkPlugins: [remarkGfm],
    skipHtml: true,
    unwrapDisallowed: true,
    urlTransform: safeMarkdownUrlTransform,
  }, input.representation.value), linkErrorCode && createElement("p", {
    className: "metaflow-renderer-link-error",
    role: "alert",
    "data-error-code": linkErrorCode,
  }, "Link could not be opened."));
}

export const markdownRendererFactory = createReactRendererFactory(renderMarkdownView);

export const safeMarkdownUrlTransform: UrlTransform = (url) => parseSafeMarkdownHref(url) ?? "";

export async function openMarkdownLink(
  host: WebRendererHostV1,
  request: SafeLinkRequest,
  signal: AbortSignal,
  reportError: (errorCode: string) => void,
): Promise<void> {
  try {
    await host.openLink(request, signal);
  } catch (error) {
    reportError(error instanceof WebRendererError ? error.code : "link_open_failed");
  }
}

function parseSafeMarkdownHref(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "mailto:") || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
