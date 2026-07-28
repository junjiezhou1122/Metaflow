import { createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type {
  WebRendererFactoryV1,
  WebRendererHostV1,
  WebRendererInput,
} from "../contracts.js";

export type RendererElementFactory = (
  input: WebRendererInput,
  host: WebRendererHostV1,
  signal: AbortSignal,
) => ReactNode;

export function createReactRendererFactory(render: RendererElementFactory): WebRendererFactoryV1 {
  const factory: WebRendererFactoryV1 = {
    async mount(container, input, host, signal) {
      if (signal.aborted) throw new DOMException("Renderer mount aborted", "AbortError");
      const root = createRoot(container);
      try {
        flushSync(() => root.render(createElement(RendererBoundary, { render, input, host, signal })));
      } catch (error) {
        root.unmount();
        throw error;
      }
      return {
        async dispose() {
          // A host may abort this renderer from its own React cleanup phase.
          // Leave that commit before unmounting this independently owned root.
          await new Promise<void>(resolve => queueMicrotask(resolve));
          root.unmount();
        },
      };
    },
  };
  return Object.freeze(factory);
}

function RendererBoundary(props: {
  render: RendererElementFactory;
  input: WebRendererInput;
  host: WebRendererHostV1;
  signal: AbortSignal;
}): ReactNode {
  return props.render(props.input, props.host, props.signal);
}
