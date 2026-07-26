import type { StoredContextView } from "@info/core";
import type { ViewSpec } from "./spec.js";

export type ViewFilter = {
  view_type?: string;
  view_types?: string[];
  prefix?: string;
  labels?: string[];
  subject?: Record<string, unknown>;
  stability?: StoredContextView["stability"];
  status?: StoredContextView["status"];
};

export function filterStoredViews(views: StoredContextView[], filter: ViewFilter = {}): StoredContextView[] {
  return views.filter(view => matchesStoredView(view, filter));
}

export function matchesStoredView(view: StoredContextView, filter: ViewFilter = {}): boolean {
  if (filter.view_type && view.view_type !== filter.view_type) return false;
  if (filter.view_types && !filter.view_types.includes(view.view_type)) return false;
  if (filter.prefix && !view.view_type.startsWith(filter.prefix)) return false;
  if (filter.stability && view.stability !== filter.stability) return false;
  if (filter.status && view.status !== filter.status) return false;
  if (filter.labels?.length && !containsAll(viewLabels(view), filter.labels)) return false;
  if (filter.subject && !objectContains(viewSubject(view), filter.subject)) return false;
  return true;
}

export function viewLabels(view: StoredContextView): string[] {
  const metadataLabels = arrayOfStrings(view.metadata?.labels);
  const contentLabels = arrayOfStrings(view.content?.labels);
  const tags = arrayOfStrings(view.metadata?.tags);
  return [...new Set([...metadataLabels, ...contentLabels, ...tags])].sort();
}

export function viewSubject(view: StoredContextView): Record<string, unknown> {
  return {
    ...(isRecord(view.metadata?.subject) ? view.metadata?.subject : {}),
    ...(isRecord(view.content?.subject) ? view.content?.subject : {}),
  };
}

export function searchViewSpecs(specs: ViewSpec[], query: string): ViewSpec[] {
  const terms = query.split(/\s+/).map(term => term.trim().toLowerCase()).filter(Boolean);
  if (!terms.length) return specs;
  return specs.filter(spec => {
    const haystack = [
      spec.view_type,
      spec.title,
      spec.purpose,
      spec.subject?.description,
      ...(spec.tags ?? []),
      JSON.stringify(spec.examples ?? []),
    ].filter(Boolean).join("\n").toLowerCase();
    return terms.some(term => haystack.includes(term));
  });
}

function containsAll(values: string[], expected: string[]): boolean {
  return expected.every(value => values.includes(value));
}

function objectContains(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
