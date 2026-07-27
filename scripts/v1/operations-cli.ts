import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../apps/mf-cli/bin/mf.mjs", import.meta.url));
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit" });
process.exitCode = await new Promise<number>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", code => resolve(code ?? 1));
});
