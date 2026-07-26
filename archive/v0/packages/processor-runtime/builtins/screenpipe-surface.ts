import type { ContextRecord, ContextView, StoredContextRecord, StoredContextView } from "@info/core";

// ── Types ─────────────────────────────────────────────────────────

export type ScreenpipeSurfaceView = ContextView & {
  view_type: "screenpipe.surface";
  content: {
    surface_kind: "non_browser";
    active_app: string;
    active_window: string;
    ocr_text?: string;
    accessibility_text?: string;
    screenshot_frame_id?: string;
    screenshot_url?: string;
    project_hint?: string;
    noise_filtered: boolean;
    capture_mode: "ocr_only" | "ocr_with_vision" | "no_screenpipe";
    vision_used: boolean;
    privacy_level: string;
  };
};

export type SurfaceCaptureOptions = {
  /** Prefer OCR/accessibility over screenshot vision */
  preferOcr?: boolean;
  /** Require this env var to be set before using vision LLM */
  visionLlmRequired?: boolean;
  /** Filter out Screenpipe self-observation noise */
  filterNoise?: boolean;
  /** Project hints for routing non-browser context into work lanes */
  projectHints?: string[];
  /** Dry-run: do not persist views */
  dryRun?: boolean;
  /** Explicit window_minutes for recent record lookup */
  windowMinutes?: number;
};

// ── Public API ────────────────────────────────────────────────────

export type BuildScreenpipeSurfaceResult = {
  ok: true;
  view: ContextView;
  capture_mode: "ocr_only" | "ocr_with_vision" | "no_screenpipe";
  vision_used: boolean;
  noise_filtered: boolean;
  privacy_level: string;
} | {
  ok: false;
  error: string;
  capture_mode: "no_screenpipe";
  vision_used: false;
  noise_filtered: false;
  privacy_level: string;
};

export function buildScreenpipeSurfaceView(
  records: StoredContextRecord[],
  options: SurfaceCaptureOptions = {},
): BuildScreenpipeSurfaceResult {
  const opts = { preferOcr: true, filterNoise: true, visionLlmRequired: true, ...options };
  const screenpipeRecords = records.filter(isScreenpipeRecord);

  if (screenpipeRecords.length === 0) {
    return {
      ok: false,
      error: "No Screenpipe records available",
      capture_mode: "no_screenpipe",
      vision_used: false,
      noise_filtered: false,
      privacy_level: "private",
    };
  }

  const candidate = chooseLatestScreenpipeCandidate(screenpipeRecords);
  if (!candidate) {
    return {
      ok: false,
      error: "No usable Screenpipe candidate",
      capture_mode: "no_screenpipe",
      vision_used: false,
      noise_filtered: false,
      privacy_level: "private",
    };
  }

  // Noise filtering
  const isNoise = opts.filterNoise ? isScreenpipeSelfObservation(candidate) : false;

  // OCR/accessibility extraction
  const ocrText = extractOcrText(candidate);
  const accessibilityText = extractAccessibilityText(candidate);

  // Vision guard: only use vision when policy allows and VISION_LLM_* is configured
  const visionLlmConfigured = isVisionLlmConfigured();
  const shouldUseVision = !opts.preferOcr || (!ocrText && !accessibilityText);
  const visionAllowed = !opts.visionLlmRequired || visionLlmConfigured;
  const visionUsed = shouldUseVision && visionAllowed;

  // Capture mode
  let captureMode: "ocr_only" | "ocr_with_vision" | "no_screenpipe" = "ocr_only";
  if (visionUsed) captureMode = "ocr_with_vision";

  // Surface state construction
  const activeApp = extractAppName(candidate) ?? "unknown";
  const activeWindow = extractWindowName(candidate) ?? "unknown";

  const view: ContextView = {
    id: `screenpipe:surface:${candidate.id}`,
    view_type: "screenpipe.surface",
    title: `Non-browser surface: ${activeApp} - ${activeWindow}`,
    summary: buildSummary({
      app: activeApp,
      window: activeWindow,
      ocrText,
      accessibilityText,
      visionUsed,
      isNoise,
    }),
    status: "candidate",
    source_records: [candidate.id],
    purpose: "Ephemeral non-browser surface state from Screenpipe OCR/screenshot for ambient context.",
    scope: {
      app: activeApp,
      domain: extractDomain(candidate),
      project: opts.projectHints?.[0],
    },
    content: {
      surface_kind: "non_browser",
      active_app: activeApp,
      active_window: activeWindow,
      ocr_text: ocrText ?? undefined,
      accessibility_text: accessibilityText ?? undefined,
      screenshot_frame_id: stringValue(candidate.payload?.frame_id) ?? undefined,
      project_hint: opts.projectHints?.[0],
      noise_filtered: isNoise,
      capture_mode: captureMode,
      vision_used: visionUsed,
      privacy_level: "private",
    },
    confidence: ocrText || accessibilityText ? 0.82 : visionUsed ? 0.65 : 0.35,
    stability: "ephemeral",
    lossiness: "medium",
    privacy: {
      level: "private",
      retention: "ephemeral",
      allow_embedding: false,
      allow_llm_summary: visionUsed,
      allow_external_reader: false,
      allow_external_llm: visionUsed,
    },
    metadata: {
      screenpipe_record_id: candidate.id,
      generated_at: new Date().toISOString(),
      noise_filtered: isNoise,
      vision_llm_available: visionLlmConfigured,
    },
  };

  return {
    ok: true,
    view,
    capture_mode: captureMode,
    vision_used: visionUsed,
    noise_filtered: isNoise,
    privacy_level: "private",
  };
}

// ── Routing helpers ────────────────────────────────────────────────

/**
 * Route a non-browser screenpipe surface record into work/project lanes.
 * Returns an array of candidate route keys (e.g. "project:/Users/junjie/info"
 * or "topic:design") derived from the record content.
 */
export function routeScreenpipeSurface(
  record: StoredContextRecord,
  options: { projectHints?: string[] } = {},
): string[] {
  const routes: string[] = [];
  const app = extractAppName(record) ?? "unknown";
  const window = extractWindowName(record) ?? "unknown";
  const text = fullText(record);

  // Project hint routing
  for (const hint of options.projectHints ?? []) {
    if (text.includes(hint.toLowerCase()) || window.includes(hint) || app.includes(hint)) {
      routes.push(`project:${hint}`);
    }
  }

  // App-based topic routing
  const appTopics: Record<string, string> = {
    slack: "communication",
    discord: "communication",
    telegram: "communication",
    warp: "terminal",
    terminal: "terminal",
    iterm: "terminal",
    vscode: "code",
    "visual studio code": "code",
    cursor: "code",
    figma: "design",
    sketch: "design",
  };
  const lcApp = app.toLowerCase();
  for (const [key, topic] of Object.entries(appTopics)) {
    if (lcApp.includes(key)) {
      routes.push(`topic:${topic}`);
      break;
    }
  }

  // De-duplicate
  return [...new Set(routes)];
}

// ── Helpers ───────────────────────────────────────────────────────

function isScreenpipeRecord(record: StoredContextRecord): boolean {
  return record.source.type === "screenpipe" || record.schema.name.startsWith("observation.screenpipe_");
}

function chooseLatestScreenpipeCandidate(records: StoredContextRecord[]): StoredContextRecord | undefined {
  return [...records]
    .sort((a, b) => Date.parse(b.time?.observed_at ?? b.created_at) - Date.parse(a.time?.observed_at ?? a.created_at))[0];
}

function isScreenpipeSelfObservation(record: StoredContextRecord): boolean {
  const text = fullText(record).toLowerCase();
  const app = (record.scope?.app ?? stringValue(record.payload?.app_name) ?? "").toLowerCase();

  // Terminal running screenpipe record/CLI
  const isTerminalRecording = ["terminal", "warp", "iterm", "iterm2"].some(term => app.includes(term))
    && (text.includes("screenpipe") && (text.includes("record") || text.includes("npm exec") || text.includes("cli-darwin")));

  // Screenpipe UI/settings window
  const isScreenpipeUI = text.includes("screenpipe") && (text.includes("settings") || text.includes("preferences") || text.includes("recording"));

  return isTerminalRecording || isScreenpipeUI;
}

function extractOcrText(record: StoredContextRecord): string | undefined {
  // Screenpipe OCR text stored in content.text or payload fields
  const fromContent = record.content?.text;
  const fromPayload = stringValue(record.payload?.ocr_text) ?? stringValue(record.payload?.text);
  const text = (fromContent && fromContent.trim().length > 0) ? fromContent : fromPayload;
  return text && text.trim().length > 0 ? text.trim() : undefined;
}

function extractAccessibilityText(record: StoredContextRecord): string | undefined {
  // Accessibility text may be stored separately by Screenpipe
  return stringValue(record.payload?.accessibility_text) ?? stringValue(record.payload?.a11y_text);
}

function extractAppName(record: StoredContextRecord): string | undefined {
  return record.scope?.app ?? stringValue(record.payload?.app_name) ?? stringValue(record.payload?.app);
}

function extractWindowName(record: StoredContextRecord): string | undefined {
  return stringValue(record.payload?.window_name) ?? stringValue(record.payload?.window_title) ?? record.content?.title;
}

function extractDomain(record: StoredContextRecord): string | undefined {
  const url = stringValue(record.payload?.browser_url) ?? record.content?.url;
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function fullText(record: StoredContextRecord): string {
  return [
    record.content?.title,
    record.content?.text,
    record.content?.url,
    record.scope?.app,
    stringValue(record.payload?.app_name),
    stringValue(record.payload?.window_name),
    stringValue(record.payload?.browser_url),
    JSON.stringify(record.payload ?? {}),
  ].filter(Boolean).join("\n").toLowerCase();
}

function isVisionLlmConfigured(): boolean {
  return Boolean(
    process.env.VISION_LLM_BASE_URL ||
    process.env.VISION_LLM_API_KEY ||
    process.env.VISION_LLM_MODEL,
  );
}

function buildSummary(input: {
  app: string;
  window: string;
  ocrText?: string;
  accessibilityText?: string;
  visionUsed: boolean;
  isNoise: boolean;
}): string {
  const parts = [`${input.app} - ${input.window}`];
  if (input.ocrText) parts.push(`OCR: ${input.ocrText.slice(0, 120)}`);
  if (input.accessibilityText) parts.push(`A11y: ${input.accessibilityText.slice(0, 120)}`);
  if (input.visionUsed) parts.push("[vision assisted]");
  if (input.isNoise) parts.push("[noise filtered]");
  return parts.join("; ");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
