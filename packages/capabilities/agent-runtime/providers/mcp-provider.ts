import type { AgentMcpServerConfig } from "../types.js";

export function httpMcpServer(name: string, url: string, headers: Array<{ name: string; value: string }> = []): AgentMcpServerConfig {
  return { type: "http", name, url, headers };
}

export function stdioMcpServer(name: string, command: string, args: string[] = [], env: Array<{ name: string; value: string }> = []): AgentMcpServerConfig {
  return { name, command, args, env };
}
