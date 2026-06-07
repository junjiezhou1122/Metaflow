import type { StoredContextRecord } from "@info/core";

export function screenNoiseLevel(record: StoredContextRecord): "none" | "low" | "high" {
  if (record.source.type !== "screenpipe" && !record.schema.name.includes("screenpipe")) return "none";
  if (isScreenpipeRecorderRecord(record)) return "high";
  if (isPassiveWarpFocus(record)) return "high";
  if (isTerminalOcr(record) && !looksLikeUsefulTerminalText(record)) return "high";
  if (isTerminalOcr(record)) return "low";
  return "none";
}

export function isHighScreenNoise(record: StoredContextRecord): boolean {
  return screenNoiseLevel(record) === "high";
}

export function isLowValueScreenNoise(record: StoredContextRecord): boolean {
  return screenNoiseLevel(record) !== "none";
}

function isPassiveWarpFocus(record: StoredContextRecord): boolean {
  if (record.schema.name !== "observation.screenpipe_activity_summary") return false;
  const app = appOf(record).toLowerCase();
  const url = stringValue(record.payload?.browser_url);
  const text = searchText(record);
  if (!["warp", "terminal", "iterm", "iterm2"].some(term => app.includes(term))) return false;
  if (url) return false;
  return !looksLikeUsefulTerminalText(record) || /^warp\s*[-·]\s*[⠁-⣿\s]*(info|primoria|ecology)?$/i.test(text.split("\n")[0] ?? "");
}

function isTerminalOcr(record: StoredContextRecord): boolean {
  if (record.schema.name !== "observation.screenpipe_activity") return false;
  const contentType = stringValue(record.payload?.content_type)?.toLowerCase();
  if (contentType && contentType !== "ocr") return false;
  const app = appOf(record).toLowerCase();
  const title = `${record.content?.title ?? ""} ${stringValue(record.payload?.window_name) ?? ""}`.toLowerCase();
  return ["terminal", "warp", "iterm", "iterm2"].some(term => app.includes(term) || title.includes(term));
}

function isScreenpipeRecorderRecord(record: StoredContextRecord): boolean {
  const text = searchText(record);
  const app = appOf(record).toLowerCase();
  if (!["terminal", "warp", "iterm", "iterm2"].some(term => app.includes(term))) return false;
  const mentionsScreenpipeRecord = text.includes("screenpipe") && text.includes("record");
  const looksLikeCliProcess = text.includes("npm exec")
    || text.includes("screenpipe@")
    || text.includes("screenpipe record")
    || text.includes("cli-darwin")
    || text.includes("screenpipe ◂");
  return mentionsScreenpipeRecord && looksLikeCliProcess;
}

function looksLikeUsefulTerminalText(record: StoredContextRecord): boolean {
  const text = searchText(record);
  return /error|failed|exception|typecheck|test failed|pnpm|npm|node|pytest|tsx|git (diff|status|commit)|src\/|tests?\/|\.ts|\.tsx|\.py|sqlite|visual|memory|screenpipe|runtime|workflow|intent/.test(text);
}

function appOf(record: StoredContextRecord): string {
  return record.scope?.app ?? stringValue(record.payload?.app_name) ?? stringValue(record.payload?.app) ?? "";
}

function searchText(record: StoredContextRecord): string {
  return [
    record.content?.title,
    record.content?.text,
    record.content?.url,
    record.content?.path,
    record.scope?.app,
    record.scope?.domain,
    stringValue(record.payload?.app_name),
    stringValue(record.payload?.window_name),
    stringValue(record.payload?.browser_url),
    stringValue(record.payload?.text),
  ].filter(Boolean).join("\n").toLowerCase();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
