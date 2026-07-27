import { createServer, type Server } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AcpStdioAgentRuntimeAdapter } from "@info/agent-runtime-adapter";
import { createAmbientDaemonComposition } from "./composition.js";
import { createDirectAssistHttpHandler, DirectAssistService } from "./direct-assist.js";
import { createNativeAgentPermissionBroker, DirectAssistRuntimeRouter } from "./direct-assist-runtime.js";
import {
  normalizeTrustedOperationOrigin,
  requireAmbientOperationToken,
} from "./operation-access.js";

export async function startAmbientDaemon() {
  const port = Number(process.env.CONTEXT_HTTP_PORT ?? 3111);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("CONTEXT_HTTP_PORT must be a valid TCP port");
  const operationAuthToken = requireAmbientOperationToken(process.env.METAFLOW_AUTH_TOKEN);
  const trustedOperationOrigins = parseTrustedOperationOrigins(process.env.METAFLOW_TRUSTED_OPERATION_ORIGINS);
  const runtimeCommand = resolveAmbientAcpCommand();
  const agentRuntime = new AcpStdioAgentRuntimeAdapter({
    id: process.env.AGENT_TASK_ACP_RUNTIME_ID ?? runtimeCommand.id,
    command: runtimeCommand.command,
    args: runtimeCommand.args,
    env: runtimeCommand.env,
    lifecycle: "persistent",
  });
  const agentWarmup = await agentRuntime.warmup();
  console.log(JSON.stringify({
    component: "ambient-daemon",
    event: "acp.warmed",
    runtime: process.env.AGENT_TASK_ACP_RUNTIME_ID ?? runtimeCommand.id,
    model: runtimeCommand.model,
    process_id: agentWarmup.process_id,
    process_reused: agentWarmup.process_reused,
  }));
  const directConversation = new DirectAssistRuntimeRouter({
    acp: agentRuntime,
    acpPermissions: createNativeAgentPermissionBroker(),
    pi: {
      command: process.env.METAFLOW_PI_COMMAND ?? "pi",
      defaultProvider: process.env.METAFLOW_PI_PROVIDER ?? "xem-gpt",
      defaultModel: process.env.METAFLOW_PI_MODEL ?? "gpt-5.6-terra",
      thinking: parsePiThinking(process.env.METAFLOW_PI_THINKING),
      env: process.env.METAFLOW_PI_AGENT_DIR
        ? { PI_CODING_AGENT_DIR: process.env.METAFLOW_PI_AGENT_DIR }
        : undefined,
      tools: parsePiTools(process.env.METAFLOW_PI_TOOLS),
    },
  });
  const directAssist = createDirectAssistHttpHandler(new DirectAssistService(directConversation));
  let composition: Awaited<ReturnType<typeof createAmbientDaemonComposition>>;
  try {
    composition = await createAmbientDaemonComposition({
      data_directory: process.env.METAFLOW_DATA_DIR ?? "data/ambient-v1",
      operation_auth_token: operationAuthToken,
      trusted_operation_origins: trustedOperationOrigins,
      agent_runtime: agentRuntime,
      agent_aliases: parseAgentAliases(process.env.METAFLOW_AGENT_ALIASES),
      agent_mcp_servers: [],
      direct_assist: directAssist,
    });
  } catch (error) {
    await directConversation.close();
    throw error;
  }
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
    if (path === "/mcp") {
      void composition.mcpHandler(request, response);
      return;
    }
    void composition.handler(request, response);
  });
  try {
    await listenAmbientDaemon(server, port);
  } catch (error) {
    await Promise.all([composition.close(), directConversation.close()]);
    throw error;
  }
  console.log(`[ambient-daemon] listening on http://${AMBIENT_DAEMON_HOST}:${port}`);
  console.log(`[ambient-daemon] ACP backend: ${runtimeCommand.id}${runtimeCommand.model ? ` (${runtimeCommand.model})` : ""}`);
  console.log(`[ambient-daemon] direct assist available at http://${AMBIENT_DAEMON_HOST}:${port}/ambient/v1/assist`);
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    closing = new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) {
          reject(error);
          return;
        }
        void Promise.all([composition.close(), directConversation.close()]).then(() => resolve(), reject);
      });
    });
    return closing;
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    await composition.scheduler.start({
      interval_ms: schedulerInterval(),
      on_error(error) {
        console.error(JSON.stringify({
          component: "scheduler-automation",
          event: "scheduler.fatal",
          error: error instanceof Error ? error.message : String(error),
        }));
        process.exitCode = 1;
        void close();
      },
    });
  } catch (error) {
    await close();
    throw error;
  }
  return { server, composition };
}

export const AMBIENT_DAEMON_HOST = "127.0.0.1" as const;

export async function listenAmbientDaemon(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, AMBIENT_DAEMON_HOST);
  });
}

function parsePiThinking(value: string | undefined): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  if (!value) return "off";
  if (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)) {
    return value as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  }
  throw new Error("METAFLOW_PI_THINKING must be off, minimal, low, medium, high, xhigh, or max");
}

function parsePiTools(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const tools = value.split(",").map(item => item.trim()).filter(Boolean);
  if (new Set(tools).size !== tools.length) throw new Error("METAFLOW_PI_TOOLS contains duplicate tool names");
  return tools;
}

export function resolveAmbientAcpCommand(): {
  id: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  model?: string;
} {
  const explicit = process.env.METAFLOW_AMBIENT_ACP_COMMAND ?? process.env.AGENT_TASK_ACP_COMMAND;
  if (explicit) {
    return {
      id: process.env.AGENT_TASK_ACP_RUNTIME_ID ?? "acp_stdio",
      command: explicit,
      args: (process.env.METAFLOW_AMBIENT_ACP_ARGS ?? process.env.AGENT_TASK_ACP_ARGS)?.split(" ").filter(Boolean) ?? [],
    };
  }
  const entrypoint = fileURLToPath(import.meta.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js"));
  const model = process.env.METAFLOW_AMBIENT_CLAUDE_MODEL;
  return {
    id: "claude_code_acp",
    command: process.execPath,
    args: [entrypoint],
    env: model ? { ANTHROPIC_MODEL: model } : undefined,
    model,
  };
}

function schedulerInterval(): number {
  const value = Number(process.env.METAFLOW_SCHEDULER_INTERVAL_MS ?? 30_000);
  if (!Number.isInteger(value) || value < 1_000) {
    throw new Error("METAFLOW_SCHEDULER_INTERVAL_MS must be an integer of at least 1000");
  }
  return value;
}

function parseAgentAliases(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const aliases: Record<string, string> = {};
  for (const item of value.split(",")) {
    const [name, runtime, ...extra] = item.split("=").map(part => part.trim());
    if (!name || !runtime || extra.length > 0) {
      throw new Error("METAFLOW_AGENT_ALIASES must be comma-separated name=runtime pairs");
    }
    if (aliases[name]) throw new Error(`Duplicate Agent alias: ${name}`);
    aliases[name] = runtime;
  }
  return aliases;
}

export function parseTrustedOperationOrigins(value: string | undefined): string[] {
  if (!value) return [];
  const origins = value.split(",").map(item => item.trim()).filter(Boolean).map(normalizeTrustedOperationOrigin);
  if (new Set(origins).size !== origins.length) throw new Error("METAFLOW_TRUSTED_OPERATION_ORIGINS contains duplicates");
  return origins;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startAmbientDaemon();
}
