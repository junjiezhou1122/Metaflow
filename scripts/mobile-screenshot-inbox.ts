import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ContextStore, type ContextRecord } from "@info/core";

type Sidecar = {
  note?: string;
  observed_at?: string;
  captured_at?: string;
  device_name?: string;
  source_app?: string;
  shortcut_version?: string;
};

const DEFAULT_INBOX = join(homedir(), "Library/Mobile Documents/com~apple~CloudDocs/Shortcuts/Info Mobile Inbox");
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".heic"]);

const args = process.argv.slice(2);
const inbox = resolve(valueAfter("--inbox") ?? process.env.MOBILE_SCREENSHOT_INBOX ?? DEFAULT_INBOX);
const keepInboxFiles = args.includes("--keep");
const dryRun = args.includes("--dry-run");
const limit = Number(valueAfter("--limit") ?? 50);

if (!existsSync(inbox)) {
  console.error(`Mobile screenshot inbox not found: ${inbox}`);
  process.exit(1);
}

const store = new ContextStore();
const images = readdirSync(inbox)
  .filter(name => IMAGE_EXTENSIONS.has(extname(name).toLowerCase()))
  .sort()
  .slice(0, Number.isFinite(limit) && limit > 0 ? limit : 50);

const results = [];

for (const imageName of images) {
  const imagePath = join(inbox, imageName);
  const stem = imageName.slice(0, imageName.length - extname(imageName).length);
  const sidecarPath = join(inbox, `${stem}.json`);
  const sidecar = readSidecar(sidecarPath);
  const bytes = readFileSync(imagePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const observedAt = validIso(sidecar.observed_at) ?? statSync(imagePath).mtime.toISOString();
  const capturedAt = validIso(sidecar.captured_at) ?? observedAt;
  const dateKey = observedAt.slice(0, 10);
  const extension = extname(imageName).toLowerCase() || ".png";
  const artifactDir = resolve("data/artifacts/mobile-screenshots", dateKey);
  const artifactPath = join(artifactDir, `${observedAt.replace(/[:.]/g, "-")}-${sha256.slice(0, 12)}${extension}`);
  const mimeType = mimeTypeForExtension(extension);

  if (!dryRun) {
    mkdirSync(artifactDir, { recursive: true });
    copyFileSync(imagePath, artifactPath);
  }

  const note = stringValue(sidecar.note);
  const sourceApp = stringValue(sidecar.source_app) ?? "iPhone";
  const deviceName = stringValue(sidecar.device_name);
  const recordInput: ContextRecord = {
    schema: { name: "observation.mobile_screenshot", version: 1 },
    source: { type: "mobile", connector: "apple-shortcuts-icloud" },
    scope: { app: sourceApp },
    time: { observed_at: observedAt, captured_at: capturedAt },
    content: {
      title: note ? `Mobile screenshot: ${note}` : "Mobile screenshot",
      path: artifactPath,
      text: [
        note ? `Note: ${note}` : undefined,
        sourceApp ? `Source app: ${sourceApp}` : undefined,
        deviceName ? `Device: ${deviceName}` : undefined,
      ].filter(Boolean).join("\n"),
    },
    acquisition: { mode: "sync", actor: "connector", reason: "iCloud Drive mobile screenshot inbox" },
    signal: { importance: 0.55, confidence: 0.9, status: "inbox" },
    privacy: { level: "private", retention: "normal", allow_embedding: false, allow_llm_summary: true },
    payload: {
      artifact_kind: "screenshot",
      image_sha256: sha256,
      inbox_path: imagePath,
      mime_type: mimeType,
      byte_size: bytes.length,
      source_app: sourceApp,
      device_name: deviceName,
      shortcut_version: sidecar.shortcut_version,
    },
    memory: { kind: "observation", stability: "session" },
  };

  const ingest = dryRun ? undefined : store.insertRecordWithDedupe(recordInput);
  const record = ingest?.record;
  const artifact = !dryRun && record && !ingest?.deduped
    ? store.insertArtifact({
      record_id: record.id,
      kind: "screenshot",
      mime_type: mimeType,
      uri: pathToFileURL(artifactPath).toString(),
      sha256,
      size_bytes: bytes.length,
      metadata: { source: "apple-shortcuts-icloud", inbox_path: imagePath, source_app: sourceApp, device_name: deviceName },
    })
    : undefined;

  if (!dryRun && !keepInboxFiles) {
    moveToProcessed(imagePath, imageName, dateKey);
    if (existsSync(sidecarPath)) moveToProcessed(sidecarPath, `${stem}.json`, dateKey);
  }

  results.push({
    image: imageName,
    ok: true,
    dry_run: dryRun,
    record_id: record?.id,
    artifact_id: artifact?.id,
    deduped: Boolean(ingest?.deduped),
    artifact_path: artifactPath,
  });
}

console.log(JSON.stringify({ ok: true, inbox, count: results.length, results }, null, 2));

function valueAfter(flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

function readSidecar(path: string): Sidecar {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Sidecar : {};
  } catch {
    return {};
  }
}

function moveToProcessed(path: string, name: string, dateKey: string) {
  const dir = join(dirname(path), "processed", dateKey);
  mkdirSync(dir, { recursive: true });
  renameSync(path, join(dir, name));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function mimeTypeForExtension(extension: string) {
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".heic") return "image/heic";
  return "image/png";
}
