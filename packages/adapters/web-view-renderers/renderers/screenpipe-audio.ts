import { createElement as h, type ReactNode } from "react";
import type { WebRendererInput } from "../contracts.js";
import { createReactRendererFactory } from "./react-factory.js";
import { formatScreenpipeClock, parseScreenpipeAudioValue } from "./screenpipe-contracts.js";

export function renderScreenpipeAudioView(input: WebRendererInput): ReactNode {
  const value = parseScreenpipeAudioValue(input);
  return h("article", { className: "product-view product-audio-view screenpipe-evidence-view", "data-renderer": "renderer.screenpipe.audio@1@1" },
    h("header", { className: "product-view-lead" },
      h("span", { className: "product-view-kicker" }, "Screenpipe evidence / Audio"),
      h("h2", null, input.envelope.name),
      h("p", null, "Deterministically composed transcript evidence. No summary or semantic interpretation has been added."),
      h("div", { className: "product-view-meta" },
        h("span", null, `${formatScreenpipeClock(value.period.start)} - ${formatScreenpipeClock(value.period.end)}`),
        h("span", null, value.period.timezone),
        h("span", null, `${value.stats.source_count} exact sources`),
        h("span", null, `${value.stats.segment_count} segments`))),
    h("section", { className: "audio-transcript", "aria-label": "Screenpipe transcript" },
      h("h3", null, "Transcript evidence"),
      value.segments.length === 0
        ? h("p", { className: "muted" }, "No transcript segments were present in this period.")
        : value.segments.map((segment, index) => h("div", { className: "transcript-line", key: `${segment.source.view_id}:${index}` },
          h("time", { dateTime: segment.at }, formatScreenpipeClock(segment.at)),
          h("strong", null, segment.speaker ?? segment.device_name ?? segment.device_type),
          h("p", null, segment.text),
          h("code", null, `${segment.source.view_id}@${segment.source.revision}`)))),
    h("footer", { className: "evidence-footer" },
      h("span", null, `${value.stats.input_segments} input`),
      h("span", null, `${value.stats.output_segments} output`)));
}

export const screenpipeAudioRendererFactory = createReactRendererFactory(input => renderScreenpipeAudioView(input));
