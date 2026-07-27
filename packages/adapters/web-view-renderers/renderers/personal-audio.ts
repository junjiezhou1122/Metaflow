import { createElement as h, type ReactNode } from "react";
import type { WebRendererInput } from "../contracts.js";
import { createReactRendererFactory } from "./react-factory.js";
import { formatClock, formatDuration, parsePersonalAudioValue } from "./personal-activity-contracts.js";

const KIND = "personal_audio";

export function renderPersonalAudioView(input: WebRendererInput): ReactNode {
  const value = parsePersonalAudioValue(input, KIND);
  return h("article", { className: "product-view product-audio-view", "data-renderer": "renderer.personal.audio@1@1" },
    h("header", { className: "product-view-lead" },
      h("span", { className: "product-view-kicker" }, "Audio View"),
      h("h2", null, input.envelope.name),
      h("p", null, value.summary),
      h("div", { className: "product-view-meta" },
        h("span", null, `${formatClock(value.started_at)} - ${formatClock(value.ended_at)}`),
        h("span", null, `${value.segments.length} transcript segments`))),
    value.topics.length > 0 ? h("ul", { className: "topic-strip", "aria-label": "Topics" },
      value.topics.map(topic => h("li", { key: topic }, topic))) : null,
    h("section", { className: "audio-transcript", "aria-label": "Transcript" },
      h("h3", null, "Transcript"),
      value.segments.map((segment, index) => h("div", { className: "transcript-line", key: `${segment.start_ms}:${index}` },
        h("time", null, formatDuration(segment.start_ms)),
        h("strong", null, segment.speaker),
        h("p", null, segment.text)))),
    h("div", { className: "product-view-columns" },
      productList("Decisions", value.decisions, "No decisions extracted"),
      productList("Action items", value.action_items, "No action items extracted")));
}

function productList(title: string, items: string[], empty: string): ReactNode {
  return h("section", { key: title },
    h("h3", null, title),
    items.length > 0
      ? h("ul", null, items.map(item => h("li", { key: item }, item)))
      : h("p", { className: "muted" }, empty));
}

export const personalAudioRendererFactory = createReactRendererFactory(input => renderPersonalAudioView(input));
