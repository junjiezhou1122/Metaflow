import { createElement as h, type ReactNode } from "react";
import type { WebRendererInput } from "../contracts.js";
import { createReactRendererFactory } from "./react-factory.js";
import { formatClock, parsePersonalTimelineValue } from "./personal-activity-contracts.js";

const KIND = "personal_timeline";

export function renderPersonalTimelineView(input: WebRendererInput): ReactNode {
  const value = parsePersonalTimelineValue(input, KIND);
  const blocks = value.blocks.map((block, blockIndex) => {
    const entries = block.entries.map(entry => h("li", {
      key: `${entry.source_ref.view_id}@${entry.source_ref.revision}`,
    },
    h("span", { className: `timeline-kind kind-${entry.kind}` }, entry.kind),
    h("div", null,
      h("strong", null, entry.title),
      h("p", null, entry.detail),
      h("code", null, `${entry.source_ref.view_id}@${entry.source_ref.revision}`))));
    return h("li", { key: `${block.started_at}:${blockIndex}` },
      h("time", null, formatClock(block.started_at)),
      h("div", { className: "timeline-block-content" },
        h("h3", null, block.title),
        h("p", null, block.summary),
        h("ul", { className: "timeline-entries" }, entries)));
  });
  return h("article", { className: "product-view product-timeline-view", "data-renderer": "renderer.personal.timeline@1@1" },
    h("header", { className: "product-view-lead timeline-lead" },
      h("span", { className: "product-view-kicker" }, "Activity Timeline"),
      h("h2", null, value.date),
      h("div", { className: "product-view-meta" },
        h("span", null, value.timezone),
        h("span", null, `${value.blocks.length} activity blocks`))),
    h("ol", { className: "timeline-blocks" }, blocks),
    h("section", { className: "timeline-signals" },
      h("h3", null, "Signals from the day"),
      h("dl", null,
        h("dt", null, "Topics"), h("dd", null, value.signals.top_topics.join(" · ") || "None"),
        h("dt", null, "Decisions"), h("dd", null, value.signals.decisions.join(" · ") || "None"),
        h("dt", null, "Open threads"), h("dd", null, value.signals.unfinished_threads.join(" · ") || "None"))));
}

export const personalTimelineRendererFactory = createReactRendererFactory(input => renderPersonalTimelineView(input));
