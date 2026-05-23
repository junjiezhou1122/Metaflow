import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextQuery, PluginManifest } from "./types.js";

const PLUGIN_DIR = "plugins";

export function ensureDefaultPlugins(dir = PLUGIN_DIR) {
  mkdirSync(dir, { recursive: true });
  const languageDir = join(dir, "language-learning");
  mkdirSync(languageDir, { recursive: true });
  const manifestPath = join(languageDir, "plugin.json");
  if (!existsSync(manifestPath)) writeFileSync(manifestPath, JSON.stringify(defaultLanguageLearningPlugin(), null, 2));
}

export function listPluginManifests(dir = PLUGIN_DIR): PluginManifest[] {
  ensureDefaultPlugins(dir);
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => readPluginManifest(entry.name, dir))
    .filter((plugin): plugin is PluginManifest => Boolean(plugin));
}

export function readPluginManifest(id: string, dir = PLUGIN_DIR): PluginManifest | undefined {
  const path = join(dir, id, "plugin.json");
  if (!existsSync(path)) return undefined;
  const raw = JSON.parse(readFileSync(path, "utf8")) as PluginManifest;
  return normalizePluginManifest(raw);
}

export function mergePluginQuery(plugin: PluginManifest | undefined, query: ContextQuery): ContextQuery {
  const base = plugin?.attention_policy ?? {};
  const merged: ContextQuery = {
    ...base,
    ...query,
    scope: { ...(base.scope ?? {}), ...(query.scope ?? {}) },
    schemas: query.schemas ?? base.schemas,
    sources: query.sources ?? base.sources,
    view_types: query.view_types ?? base.view_types,
    time_window: { ...(base.time_window ?? {}), ...(query.time_window ?? {}) },
    plugin_id: query.plugin_id ?? plugin?.id,
  };
  if (query.view_types?.length && query.include_views === undefined) merged.include_views = true;
  return merged;
}

function normalizePluginManifest(plugin: PluginManifest): PluginManifest {
  return {
    ...plugin,
    permissions: {
      max_privacy_level: "private",
      allow_external_llm: false,
      allow_write_views: false,
      allow_actions: false,
      ...(plugin.permissions ?? {}),
    },
  };
}

function defaultLanguageLearningPlugin(): PluginManifest {
  return {
    id: "language-learning",
    name: "Adaptive Language Learning",
    version: "0.1.0",
    description: "Compiles recent text exposure into language-learning ContextViews without requiring WorkThread.",
    attention_policy: {
      mode: "source",
      sources: ["browser", "screenpipe", "ai_chat", "reader", "local_project"],
      schemas: [
        "observation.browser_page_snapshot",
        "observation.browser_page_saved",
        "observation.browser_text_selected",
        "observation.screenpipe_activity",
        "observation.ai_chat",
        "derived.reader_snapshot"
      ],
      include_records: true,
      include_views: false,
      time_window: { minutes: 10080 },
      limit: 80
    },
    view_types_produced: [
      "memory.language.vocabulary_exposure",
      "memory.language.learning_pack"
    ],
    actions: [
      { id: "suggest_words", title: "Suggest words", permission_level: "L2_suggest" },
      { id: "compile_memory", title: "Compile memory views", permission_level: "L1_derive" }
    ],
    permissions: {
      allowed_sources: ["browser", "screenpipe", "ai_chat", "reader", "local_project"],
      allowed_schemas: [
        "observation.browser_page_snapshot",
        "observation.browser_page_saved",
        "observation.browser_text_selected",
        "observation.screenpipe_activity",
        "observation.ai_chat",
        "derived.reader_snapshot"
      ],
      max_privacy_level: "private",
      allow_external_llm: false,
      allow_write_views: true,
      allow_actions: false
    }
  };
}
