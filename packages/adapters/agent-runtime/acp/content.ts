import type {
  AgentCurrentContext,
  AgentConversationRequest,
  AgentHandoff,
  AgentPromptBuildInput,
  AgentTaskRequest,
  AgentViewToolDescriptor,
  ContentBlock,
} from "../types.js";

export function buildAgentTaskPromptBlocks(input: AgentPromptBuildInput): ContentBlock[] {
  const { task, contextSources = [] } = input;
  if (task.outputContract.mode === "schema_value" && task.outputContract.schema === undefined) {
    throw new TypeError("schema_value Agent output requires a frozen output Schema");
  }
  const handoff = buildAgentHandoff(input);
  const sections = [
    "You are an external agent called by Metaflow.",
    "Use your installed skills. Do not expect skill bodies in this prompt.",
    "Use the current voice/screen/app context below as the immediate user context.",
    "If related Metaflow Views are useful, search them yourself through the available View CLI or MCP tools.",
    ...outputInstructions(task.outputContract.mode ?? "agent_task_output"),
    "",
    "USER PROMPT:",
    handoff.prompt,
    "",
    "CURRENT CONTEXT:",
    JSON.stringify(handoff.currentContext, null, 2),
    "",
    "AVAILABLE VIEW TOOLS:",
    JSON.stringify(handoff.viewTools, null, 2),
    "",
    "OUTPUT CONTRACT:",
    JSON.stringify(handoff.outputContract, null, 2),
    "",
    "TASK ENVELOPE:",
    JSON.stringify({
      runtime: task.runtime,
      prompt: handoff.prompt,
      constraints: task.constraints,
      cwd: handoff.cwd,
    }, null, 2),
    "",
    "CONTEXT REFERENCES:",
    JSON.stringify(contextSources, null, 2),
    "",
    "OPTIONAL CONTEXT NOTES:",
    task.contextPack?.markdown ?? "",
  ];

  return [{ type: "text", text: sections.join("\n") }];
}

function outputInstructions(mode: NonNullable<AgentTaskRequest["outputContract"]["mode"]>): string[] {
  if (mode === "schema_value") {
    return [
      "Return one JSON value. Its complete JSON value must satisfy the frozen output Schema in OUTPUT CONTRACT.",
      "Do not wrap the value in an AgentTaskOutput envelope or add fields not declared by that Schema.",
      "Metaflow Execution will validate the value and is the only component allowed to commit the resulting View.",
    ];
  }
  return [
    "Return artifacts for Metaflow to validate and commit as Views.",
    "Do not return next_actions, tasks, tool plans, file diffs, or diffs.",
    "Return only JSON matching this shape:",
    JSON.stringify({
      summary: "string",
      analysis: "string",
      key_points: ["string"],
      confidence: 0.5,
      views: [
        {
          view_type: "extraction.reader_snapshot",
          title: "optional evidence title",
          summary: "optional evidence summary",
          content: { url: "optional source URL", text: "optional extracted evidence" },
          confidence: 0.5,
        },
      ],
    }, null, 2),
    "The optional views array is for evidence you acquired with your own skills or tools. Info will assign provenance, scope, and ids.",
  ];
}

export function buildAgentConversationPromptBlocks(request: AgentConversationRequest): ContentBlock[] {
  const context = request.currentContext ?? {};
  const text = [
    "DIRECT ASSIST TURN CONTRACT:",
    "Answer this turn in the foreground and return the complete answer before ending the turn.",
    "Do not start a background Agent or Task, create a worktree, or modify a repository unless the user explicitly asks for that exact background or write behavior in this message.",
    "If a skill would normally delegate in the background, keep the work in the foreground for this turn.",
    "Tool use is allowed when needed, but the foreground answer must not finish before that work does.",
    "",
    "USER MESSAGE:",
    request.message.trim(),
    "",
    "CURRENT CONTEXT (supplemental and possibly unrelated):",
    JSON.stringify(context, null, 2),
    request.screenImage ? "\nThe following image is supplemental context captured for this exact turn." : "",
  ].join("\n");
  const blocks: ContentBlock[] = [{ type: "text", text }];
  if (request.screenImage) {
    blocks.push({
      type: "image",
      data: request.screenImage.data,
      mimeType: request.screenImage.mimeType,
    });
  }
  return blocks;
}

export function buildAgentHandoff(input: AgentPromptBuildInput): AgentHandoff {
  const { task, signal } = input;
  return {
    prompt: (task.prompt ?? task.goal).trim(),
    currentContext: task.currentContext ?? currentContextFromSignal(signal, task.cwd),
    viewTools: task.viewTools ?? defaultViewTools(),
    outputContract: task.outputContract,
    cwd: task.cwd,
  };
}

function currentContextFromSignal(signal: unknown, cwd?: string): AgentCurrentContext {
  const record = isRecord(signal) ? signal : {};
  const title = stringValue(record.title) ?? stringValue(record.window_title);
  const app = stringValue(record.app) ?? stringValue(record.app_name);
  const url = stringValue(record.url);
  const selectedText = stringValue(record.selected_text) ?? stringValue(record.selection);
  const textPreview = stringValue(record.text_preview) ?? stringValue(record.text);
  return {
    voice: {
      transcript: stringValue(record.voice_transcript) ?? (record.object_type === "observation.audio.transcript" ? textPreview : undefined),
      language: stringValue(record.language),
      audio_view_ref: stringValue(record.audio_view_ref),
    },
    screen: {
      title,
      app,
      url,
      selected_text: selectedText,
      screenshot_ref: stringValue(record.screenshot_ref),
      view_ref: stringValue(record.view_ref),
    },
    app: {
      name: app,
      bundle_id: stringValue(record.bundle_id),
      window_title: title,
      project_path: stringValue(record.project_path) ?? cwd,
    },
    summary: textPreview,
    raw: compactRecord(record),
  };
}

function defaultViewTools(): AgentViewToolDescriptor[] {
  return [
    {
      name: "metaflow view search",
      kind: "cli",
      description: "Search related Metaflow Views by natural language query.",
      command: "pnpm",
      args: ["mf", "views", "search", "<query>"],
    },
    {
      name: "metaflow view get",
      kind: "cli",
      description: "Read a specific Metaflow View by id or ref.",
      command: "pnpm",
      args: ["mf", "views", "get", "<view-ref>"],
    },
    {
      name: "metaflow mcp",
      kind: "mcp",
      description: "Use the attached Metaflow MCP server when the adapter exposes one.",
      server: "metaflow",
    },
  ];
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of ["object_id", "object_type", "object_kind", "domain", "project", "project_path", "repo", "url", "app", "title"]) {
    if (record[key] !== undefined) output[key] = record[key];
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function promptTextFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .map(block => {
      if (block.type === "text") return block.text;
      if (block.type === "resource_link") return `${block.name}: ${block.uri}`;
      if (block.type === "resource") return JSON.stringify(block.resource);
      return `[${block.type} content]`;
    })
    .join("\n\n");
}
