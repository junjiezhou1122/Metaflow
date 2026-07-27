import { parentPort, workerData } from "node:worker_threads";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

if (!parentPort) throw new Error("Markdown Parser Worker requires a parent port");
if (typeof workerData?.markdown !== "string") throw new TypeError("Markdown Parser Worker requires Markdown text");

try {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(workerData.markdown);
  const fragments = [];
  for (const block of tree.children) {
    if (block.type === "list") {
      for (const item of block.children) appendFragment(fragments, item, "text");
      continue;
    }
    const kind = fragmentKind(block);
    if (kind) appendFragment(fragments, block, kind);
  }
  parentPort.postMessage({ status: "succeeded", fragments });
} catch (error) {
  if (error instanceof ParserWorkerFailure) {
    parentPort.postMessage({ status: "failed", code: error.code, message: error.message, details: error.details });
  } else {
    throw error;
  }
}

function fragmentKind(block) {
  if (block.type === "heading") return "title";
  if (block.type === "paragraph" || block.type === "blockquote" || block.type === "listItem") return "text";
  if (block.type === "code" || block.type === "html") return "code";
  if (block.type === "table") return "table";
  if (block.type === "definition") return "metadata";
  return undefined;
}

function appendFragment(fragments, block, kind) {
  const start = block.position?.start.offset;
  const end = block.position?.end.offset;
  if (start === undefined || end === undefined || end < start) {
    throw new ParserWorkerFailure("parser_location_missing", "Markdown AST block has no deterministic source offsets", { kind });
  }
  const text = toString(block).trim();
  if (!text) return;
  if (fragments.length >= workerData.limits.max_fragments) {
    throw new ParserWorkerFailure(
      "parser_fragment_limit_exceeded",
      `Markdown parser exceeds ${workerData.limits.max_fragments} fragments`,
      { max_fragments: workerData.limits.max_fragments },
    );
  }
  const fragmentBytes = Buffer.byteLength(text, "utf8");
  if (fragmentBytes > workerData.limits.max_fragment_bytes) {
    throw new ParserWorkerFailure(
      "parser_fragment_too_large",
      `Markdown fragment exceeds ${workerData.limits.max_fragment_bytes} bytes`,
      { fragment_bytes: fragmentBytes, max_fragment_bytes: workerData.limits.max_fragment_bytes, start, end },
    );
  }
  fragments.push({ kind, start, end, text });
}

function ParserWorkerFailure(code, message, details) {
  this.code = code;
  this.message = message;
  this.details = details;
}
