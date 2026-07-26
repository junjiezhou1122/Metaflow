import GithubSlugger from "github-slugger";
import { toString } from "mdast-util-to-string";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { parseAllDocuments } from "yaml";
import {
  ObsidianFrontmatterSchema,
  ObsidianHeadingSchema,
  ObsidianLinkDescriptorSchema,
  type ObsidianDocumentRepresentation,
  type ObsidianLinkDescriptor,
} from "./contracts.js";
import { remarkObsidianWikiLinks, type ObsidianWikiNode } from "./wikilink-extension.js";

export type ParsedObsidianMarkdown = Pick<ObsidianDocumentRepresentation, "frontmatter" | "headings" | "links">;

export class ObsidianParserError extends Error {
  constructor(
    message: string,
    readonly code:
      | "obsidian_markdown_incompatible"
      | "obsidian_frontmatter_invalid"
      | "obsidian_frontmatter_unsupported",
    readonly details: Record<string, string | number> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ObsidianParserError";
  }
}

export function parseObsidianMarkdown(markdown: string): ParsedObsidianMarkdown {
  let tree;
  try {
    tree = unified()
      .use(remarkParse)
      .use(remarkFrontmatter, [{ type: "yaml", marker: "-", anywhere: true }])
      .use(remarkGfm)
      .use(remarkObsidianWikiLinks)
      .parse(markdown);
  } catch (error) {
    throw new ObsidianParserError("Markdown does not satisfy the pinned Obsidian parser contract", "obsidian_markdown_incompatible", {}, { cause: error });
  }

  const yamlNodes: Array<{ type: string; value: string }> = [];
  const headings: ParsedObsidianMarkdown["headings"] = [];
  const links: ObsidianLinkDescriptor[] = [];
  const slugger = new GithubSlugger();

  visit(tree, node => {
    const nodeType = String(node.type);
    if (nodeType === "yaml") {
      yamlNodes.push(node as { type: string; value: string });
      return;
    }
    if (nodeType === "heading") {
      const heading = node as typeof node & { depth: 1 | 2 | 3 | 4 | 5 | 6 };
      const text = toString(heading);
      headings.push(ObsidianHeadingSchema.parse({ depth: heading.depth, text, slug: slugger.slug(text) }));
      return;
    }
    if (nodeType === "link") {
      const target = (node as typeof node & { url: string }).url;
      links.push(ObsidianLinkDescriptorSchema.parse({ syntax: "markdown", target, alias: nonEmpty(toString(node)) }));
      return;
    }
    if (nodeType === "image") {
      const image = node as typeof node & { url: string; alt?: string | null };
      links.push(ObsidianLinkDescriptorSchema.parse({ syntax: "embed", target: image.url, alias: nonEmpty(image.alt ?? undefined) }));
      return;
    }
    if (nodeType === "wikiLink" || nodeType === "embed") {
      links.push(descriptorFromWikiNode(node as unknown as ObsidianWikiNode));
      return;
    }
    if (nodeType === "text") {
      const text = (node as typeof node & { value: string }).value;
      if (text.includes("[[") || text.includes("]]")) {
        throw new ObsidianParserError("Unparsed Obsidian link delimiter is incompatible with the pinned parser", "obsidian_markdown_incompatible");
      }
    }
  });

  if (yamlNodes.length > 1) {
    throw new ObsidianParserError("Multiple frontmatter documents are unsupported", "obsidian_frontmatter_unsupported", { document_count: yamlNodes.length });
  }

  return {
    frontmatter: yamlNodes[0] ? parseFrontmatter(yamlNodes[0].value) : null,
    headings,
    links,
  };
}

function parseFrontmatter(raw: string): ParsedObsidianMarkdown["frontmatter"] {
  const documents = parseAllDocuments(raw, {
    schema: "core",
    strict: true,
    uniqueKeys: true,
  });
  if (documents.length !== 1) {
    throw new ObsidianParserError("Frontmatter must contain exactly one YAML document", "obsidian_frontmatter_unsupported", { document_count: documents.length });
  }
  const document = documents[0]!;
  if (document.errors.length > 0) {
    throw new ObsidianParserError("Frontmatter YAML is malformed", "obsidian_frontmatter_invalid", { error_count: document.errors.length });
  }
  if (document.warnings.length > 0) {
    throw new ObsidianParserError("Frontmatter YAML uses unsupported constructs", "obsidian_frontmatter_unsupported", { warning_count: document.warnings.length });
  }
  let value: unknown;
  try {
    value = document.toJS({ mapAsMap: false, maxAliasCount: 0 });
  } catch (error) {
    throw new ObsidianParserError("Frontmatter aliases are unsupported", "obsidian_frontmatter_unsupported", {}, { cause: error });
  }
  const parsed = ObsidianFrontmatterSchema.safeParse({ raw, value });
  if (!parsed.success) {
    throw new ObsidianParserError("Frontmatter is not losslessly representable as JSON", "obsidian_frontmatter_unsupported", { issue_count: parsed.error.issues.length });
  }
  return parsed.data;
}

function descriptorFromWikiNode(node: ObsidianWikiNode): ObsidianLinkDescriptor {
  const hash = node.value.indexOf("#");
  const rawTarget = hash === -1 ? node.value : node.value.slice(0, hash);
  const fragment = hash === -1 ? undefined : nonEmpty(node.value.slice(hash + 1));
  const alias = nonEmpty(node.data.alias);
  const dimensions = node.type === "embed" && alias && isDimensions(alias) ? alias : undefined;
  return ObsidianLinkDescriptorSchema.parse({
    syntax: node.type === "embed" ? "embed" : "wikilink",
    target: rawTarget || ".",
    ...(alias && !dimensions ? { alias } : {}),
    ...(fragment?.startsWith("^") ? { block_id: nonEmpty(fragment.slice(1)) } : fragment ? { heading: fragment } : {}),
    ...(dimensions ? { media_dimensions: dimensions } : {}),
  });
}

function isDimensions(value: string): boolean {
  const parts = value.split("x");
  return (parts.length === 1 || parts.length === 2) && parts.every(part => part.length > 0 && [...part].every(character => character >= "0" && character <= "9"));
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
