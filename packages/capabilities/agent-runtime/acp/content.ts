import type { AgentPromptBuildInput, ContentBlock } from "../types.js";

export function buildAgentTaskPromptBlocks(input: AgentPromptBuildInput): ContentBlock[] {
  const { task, signal, contextSources = [] } = input;
  const sections = [
    "You are a local agent runtime adapter for Info, a local-first ambient context runtime.",
    "Use the provided task and Context Pack as primary inputs.",
    "You own your runtime tools and skills; Info only provides the task boundary, context, constraints, and output contract.",
    "Follow the task constraints exactly.",
    "This adapter produces analysis/evidence Views only. Do not return next_actions, tasks, tool plans, file diffs, or diffs.",
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
    "The optional views array is for evidence you acquired with your own tools. Info will assign provenance, scope, and ids.",
    "",
    "AGENT TASK:",
    JSON.stringify({
      runtime: task.runtime,
      goal: task.goal,
      constraints: task.constraints,
      output_contract: task.outputContract,
      signal,
    }, null, 2),
    "",
    "CONTEXT SOURCES:",
    JSON.stringify(contextSources, null, 2),
    "",
    "CONTEXT PACK:",
    task.contextPack?.markdown ?? "",
  ];

  return [{ type: "text", text: sections.join("\n") }];
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
