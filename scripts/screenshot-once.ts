import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ContextStore } from "../src/store.js";

function sh(cmd: string, args: string[]) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const now = new Date();
const dir = resolve("data/artifacts/screenshots", now.toISOString().slice(0, 10));
mkdirSync(dir, { recursive: true });
const file = join(dir, `${now.toISOString().replace(/[:.]/g, "-")}.png`);

// macOS built-in screenshot. Requires Screen Recording permission for the terminal app.
try {
  execFileSync("screencapture", ["-x", file], { stdio: "ignore" });
} catch (error) {
  console.error("screencapture failed. On macOS, grant Screen Recording permission to your terminal app.");
  throw error;
}

const frontApp = sh("osascript", ["-e", "tell application \"System Events\" to get name of first application process whose frontmost is true"]);
const windowTitle = frontApp
  ? sh("osascript", ["-e", `tell application "System Events" to tell process "${frontApp.replace(/"/g, '\\"')}" to get name of front window`])
  : "";
const data = readFileSync(file);
const sha256 = createHash("sha256").update(data).digest("hex");
const size = statSync(file).size;

const store = new ContextStore();
const record = store.insertRecord({
  schema: { name: "observation.desktop_screenshot", version: 1 },
  source: { type: "desktop", connector: "macos-screencapture" },
  scope: { app: frontApp || undefined, project: basename(process.cwd()) },
  content: {
    title: `Desktop screenshot: ${frontApp}${windowTitle ? ` - ${windowTitle}` : ""}`,
    path: file,
    text: `Active app: ${frontApp}\nWindow title: ${windowTitle}`,
  },
  acquisition: { mode: "manual", actor: "user", reason: "screenshot once" },
  signal: { importance: 0.5, confidence: 0.8, status: "inbox" },
  privacy: { level: "private", retention: "ephemeral", allow_embedding: false, allow_llm_summary: true },
  payload: { active_app: frontApp, window_title: windowTitle, artifact_kind: "screenshot" },
});
const artifact = store.insertArtifact({
  record_id: record.id,
  kind: "screenshot",
  mime_type: "image/png",
  uri: `file://${file}`,
  sha256,
  size_bytes: size,
  metadata: { active_app: frontApp, window_title: windowTitle },
});

console.log(JSON.stringify({ ok: true, record_id: record.id, artifact_id: artifact.id, file, exists: existsSync(file) }, null, 2));
