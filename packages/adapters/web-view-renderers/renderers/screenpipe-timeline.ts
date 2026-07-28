import { createElement as h, type ReactNode } from "react";
import type { WebRendererInput } from "../contracts.js";
import { createReactRendererFactory } from "./react-factory.js";
import { formatScreenpipeClock, parseScreenpipeTimelineValue } from "./screenpipe-contracts.js";

export function renderScreenpipeTimelineView(input: WebRendererInput): ReactNode {
  const value = parseScreenpipeTimelineValue(input);
  const counts = Object.entries(value.stats.counts_by_modality).sort(([left], [right]) => left.localeCompare(right));
  return h("article", { className: "product-view product-timeline-view screenpipe-evidence-view", "data-renderer": "renderer.screenpipe.timeline@1@1" },
    h("header", { className: "product-view-lead timeline-lead" },
      h("span", { className: "product-view-kicker" }, "Screenpipe evidence / Timeline"),
      h("h2", null, input.envelope.name),
      h("p", null, "Chronological OCR, audio, input, and accessibility evidence. Entries retain their exact source View revisions."),
      h("div", { className: "product-view-meta" },
        h("span", null, `${formatScreenpipeClock(value.period.start)} - ${formatScreenpipeClock(value.period.end)}`),
        h("span", null, value.period.timezone),
        h("span", null, `${value.stats.source_count} exact sources`))),
    h("ul", { className: "evidence-counts", "aria-label": "Timeline modalities" },
      counts.map(([kind, count]) => h("li", { key: kind, className: `timeline-kind kind-${kind}` }, `${kind} ${count}`))),
    h("ol", { className: "timeline-blocks screenpipe-timeline-entries" },
      value.entries.map((entry, index) => h("li", { key: `${entry.source.view_id}:${index}` },
        h("time", { dateTime: entry.at }, formatScreenpipeClock(entry.at)),
        h("div", { className: "timeline-block-content" },
          h("span", { className: `timeline-kind kind-${entry.modality}` }, entry.modality),
          h("h3", null, entry.label),
          entry.text ? h("p", null, entry.text) : null,
          entry.url ? h("p", { className: "evidence-url" }, entry.url) : null,
          h("code", null, `${entry.source.view_id}@${entry.source.revision}`))))));
}

export const screenpipeTimelineRendererFactory = createReactRendererFactory(input => renderScreenpipeTimelineView(input));
