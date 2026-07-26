import { runPipelineTick } from "@info/views/pipeline/runner.js";

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const limit = Number(value("--limit") ?? process.env.PIPELINE_LIMIT ?? 50);
const minutesRaw = value("--minutes") ?? process.env.PIPELINE_MINUTES;
const minutes = minutesRaw ? Number(minutesRaw) : undefined;
const dryRun = flag("--dry-run") || process.env.PIPELINE_DRY_RUN === "1";

console.log(JSON.stringify(runPipelineTick({ limit, minutes, dryRun }), null, 2));
