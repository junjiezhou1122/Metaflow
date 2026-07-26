import { readFileSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "dist", "assets");
const baseline = JSON.parse(readFileSync(join(root, "bundle-baseline.json"), "utf8"));
const files = readdirSync(assets).filter(file => file.endsWith(".js"));
const sizes = Object.fromEntries(files.map(file => [file, gzipSync(readFileSync(join(assets, file)), { level: 9 }).byteLength]));

const required = {
  initial_shell: /^index-.*\.js$/u,
  graph_engine: /^graph-.*\.js$/u,
  sigma_surface: /^sigma-surface-.*\.js$/u,
  layout_worker: /^layout\.worker-.*\.js$/u,
};
const measured = {};
for (const [name, pattern] of Object.entries(required)) {
  const matches = Object.entries(sizes).filter(([file]) => pattern.test(file));
  if (matches.length !== 1) throw new Error(`Bundle must contain exactly one ${name} chunk; found ${matches.map(([file]) => file).join(", ") || "none"}`);
  measured[name] = matches[0][1];
  if (measured[name] > baseline.maximum_bytes[name]) throw new Error(`${name} gzip size ${measured[name]} exceeds ${baseline.maximum_bytes[name]}`);
}
measured.total_javascript = Object.values(sizes).reduce((total, size) => total + size, 0);
if (measured.total_javascript > baseline.maximum_bytes.total_javascript) {
  throw new Error(`total JavaScript gzip size ${measured.total_javascript} exceeds ${baseline.maximum_bytes.total_javascript}`);
}

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const forbidden of ["@xyflow/react", "cytoscape", "openseadragon", "vis-timeline"]) {
  if (manifest.dependencies?.[forbidden] || manifest.devDependencies?.[forbidden]) throw new Error(`Forbidden explorer dependency: ${forbidden}`);
}
console.info(JSON.stringify({ component: "view-explorer-bundle", event: "bundle.checked", compression: baseline.compression, measured }));
