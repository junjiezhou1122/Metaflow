import { type View, type ViewRepository } from "@info/view";

export type ScreenpipeContentType = "ocr" | "audio" | "input" | "accessibility";

const SCREENPIPE_RAW_SCHEMAS = new Set([
  "capture.screenpipe.frame_ocr",
  "capture.screenpipe.audio",
  "capture.screenpipe.input",
  "capture.screenpipe.ui_accessibility",
]);

export async function resolveScreenpipeRawWindow(input: {
  repository: ViewRepository;
  connection_id: string;
  content_types: readonly ScreenpipeContentType[];
  period: { start: string; end: string };
  max_scan?: number;
  max_inputs?: number;
}): Promise<View[]> {
  const maxScan = input.max_scan ?? 10_000;
  const maxInputs = input.max_inputs ?? 200;
  const scanEnd = new Date(Date.parse(input.period.end) + 1).toISOString();
  const scanned = await input.repository.query({
    schema_names: input.content_types.map(screenpipeRawSchema),
    role: "raw",
    revisions: "latest",
    time_range: { basis: "observed_at", start: input.period.start, end: scanEnd },
    limit: maxScan,
  });
  if (scanned.length === maxScan) {
    throw new Error(`Screenpipe period resolution reached the ${maxScan} View scan bound`);
  }
  const resolved = scanned
    .filter(view => view.provenance.capture?.connector === "screenpipe"
      && view.provenance.capture.connection_id === input.connection_id)
    .sort((left, right) => Date.parse(observedAt(left)) - Date.parse(observedAt(right))
      || left.id.localeCompare(right.id)
      || left.revision - right.revision);
  if (resolved.length > maxInputs) {
    throw new Error(`Screenpipe period resolved ${resolved.length} exact Raw Views, exceeding the one-shot ${maxInputs} input bound`);
  }
  return resolved;
}

function screenpipeRawSchema(contentType: ScreenpipeContentType): string {
  const schema = contentType === "ocr"
    ? "capture.screenpipe.frame_ocr"
    : contentType === "accessibility"
      ? "capture.screenpipe.ui_accessibility"
      : `capture.screenpipe.${contentType}`;
  if (!SCREENPIPE_RAW_SCHEMAS.has(schema)) throw new Error(`Unsupported Screenpipe Raw schema for ${contentType}`);
  return schema;
}

function observedAt(view: View): string {
  return view.time.observed_at ?? view.time.created_at;
}
