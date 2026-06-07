import { loadDotEnv } from "./env.js";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type VisionContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type VisionMessage = {
  role: "system" | "user" | "assistant";
  content: string | VisionContentPart[];
};

export type LlmOptions = {
  base_url?: string;
  api_key?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  omit_max_tokens?: boolean;
  allow_external?: boolean;
};

export type LlmResult = {
  ok: boolean;
  model: string;
  base_url: string;
  content?: string;
  error?: string;
};

export function llmConfig(options: LlmOptions = {}) {
  loadDotEnv();
  const base_url = options.base_url ?? process.env.LLM_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "http://localhost:11434/v1";
  const model = options.model ?? process.env.LLM_MODEL ?? "qwen2.5:7b";
  const api_key = options.api_key ?? process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY;
  const allow_external = options.allow_external ?? process.env.ALLOW_EXTERNAL_LLM === "1";
  return { base_url: base_url.replace(/\/$/, ""), model, api_key, allow_external };
}

export async function chatCompletion(messages: ChatMessage[], options: LlmOptions = {}): Promise<LlmResult> {
  return completion(messages, options, true);
}

export async function visionCompletion(messages: VisionMessage[], options: LlmOptions = {}): Promise<LlmResult> {
  return completion(messages, options, false);
}

async function completion(messages: Array<ChatMessage | VisionMessage>, options: LlmOptions = {}, jsonMode: boolean): Promise<LlmResult> {
  const cfg = llmConfig(options);
  if (process.env.LLM_MOCK_RESPONSE) {
    return { ok: true, model: cfg.model, base_url: cfg.base_url, content: process.env.LLM_MOCK_RESPONSE };
  }
  if (isExternalUrl(cfg.base_url) && !cfg.allow_external) {
    return {
      ok: false,
      model: cfg.model,
      base_url: cfg.base_url,
      error: "external LLM disabled; set ALLOW_EXTERNAL_LLM=1 or use a local OpenAI-compatible endpoint",
    };
  }
  if (!cfg.api_key && isExternalUrl(cfg.base_url)) {
    return { ok: false, model: cfg.model, base_url: cfg.base_url, error: "missing LLM_API_KEY/OPENAI_API_KEY" };
  }

  const body = JSON.stringify({
    model: cfg.model,
    messages,
    temperature: options.temperature ?? 0.2,
    ...(options.omit_max_tokens ? {} : { max_tokens: options.max_tokens ?? 800 }),
    ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
  });
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(`${cfg.base_url}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cfg.api_key ? { Authorization: `Bearer ${cfg.api_key}` } : {}),
        },
        body,
      });
      if (!res.ok) return { ok: false, model: cfg.model, base_url: cfg.base_url, error: `${res.status} ${await res.text()}` };
      const json = await res.json() as any;
      const content = json.choices?.[0]?.message?.content;
      return { ok: Boolean(content), model: cfg.model, base_url: cfg.base_url, content, error: content ? undefined : "empty completion" };
    } catch (error: any) {
      lastError = error?.message ?? String(error);
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
    }
  }
  return { ok: false, model: cfg.model, base_url: cfg.base_url, error: lastError || "completion failed" };
}

export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return undefined;
    try {
      const value = JSON.parse(match[0]);
      return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
}

function isExternalUrl(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return !["localhost", "127.0.0.1", "::1"].includes(u.hostname);
  } catch {
    return true;
  }
}
