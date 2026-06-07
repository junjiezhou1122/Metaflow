import { runLanguageLearningPlugin } from "@info/core";

const argv = process.argv.slice(2);
const options: any = {};
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--days") options.days = Number(argv[++i]);
  else if (arg === "--limit") options.limit = Number(argv[++i]);
  else if (arg === "--min-count") options.min_count = Number(argv[++i]);
  else if (arg === "--dry-run") options.write = false;
}

console.log(JSON.stringify(runLanguageLearningPlugin(options), null, 2));
