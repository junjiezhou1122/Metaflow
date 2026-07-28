import { createElement as h, type ReactNode } from "react";
import type { WebRendererInput } from "../contracts.js";
import { createReactRendererFactory } from "./react-factory.js";
import { parsePersonalDailySummaryValue } from "./personal-activity-contracts.js";

const KIND = "personal_daily_summary";

export function renderPersonalDailySummaryView(input: WebRendererInput): ReactNode {
  const value = parsePersonalDailySummaryValue(input, KIND);
  return h("article", { className: "product-view product-daily-summary", "data-renderer": "renderer.personal.daily-summary@1@1" },
    h("header", { className: "daily-summary-lead" },
      h("time", null, value.date),
      h("span", { className: "product-view-kicker" }, "Daily Summary"),
      h("h2", null, value.headline),
      h("p", null, value.overview)),
    ...value.themes.map(theme => h("section", { className: "daily-theme", key: theme.title },
      h("h3", null, theme.title),
      h("p", null, theme.narrative),
      theme.highlights.length > 0 ? h("ul", null, theme.highlights.map(item => h("li", { key: item }, item))) : null)),
    dailySection("Decisions", value.decisions),
    dailySection("Unfinished threads", value.unfinished_threads),
    dailySection("Tomorrow", value.tomorrow, "tomorrow-section"),
    h("footer", null, "Derived from ", h("code", null, `${value.source_timeline.view_id}@${value.source_timeline.revision}`)));
}

function dailySection(title: string, items: string[], extraClass = ""): ReactNode {
  return h("section", { className: `daily-section ${extraClass}`.trim(), key: title },
    h("h3", null, title),
    items.length > 0
      ? h("ul", null, items.map(item => h("li", { key: item }, item)))
      : h("p", { className: "muted" }, "Nothing recorded"));
}

export const personalDailySummaryRendererFactory = createReactRendererFactory(input => renderPersonalDailySummaryView(input));
