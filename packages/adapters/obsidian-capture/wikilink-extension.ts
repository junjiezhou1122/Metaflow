// Adapted from @flowershow/remark-wiki-link (MIT), commit 0345f774671acfe2bbc8c2e9a0fb3e86f10ea433.
import { markdownLineEnding } from "micromark-util-character";
import { codes } from "micromark-util-symbol";
import type { Extension, State, Tokenizer } from "micromark-util-types";
import type { Extension as FromMarkdownExtension, Handle } from "mdast-util-from-markdown";
import type { Processor } from "unified";

export type ObsidianWikiNode = {
  type: "wikiLink" | "embed";
  value: string;
  data: { alias?: string };
};

export function obsidianWikiLinkSyntax(): Extension {
  const tokenize = (embed: boolean): Tokenizer => function (effects, ok, nok) {
    let openCount = 0;
    let closeCount = 0;
    let hasTarget = false;
    let hasAlias = false;

    return start;

    function start(code: Parameters<State>[0]): State | undefined {
      if (embed) {
        if (code !== codes.exclamationMark) return nok(code);
        effects.enter("embed");
        effects.enter("embedMarker");
        effects.consume(code);
        effects.exit("embedMarker");
        return expectBracket;
      }
      if (code !== codes.leftSquareBracket) return nok(code);
      effects.enter("wikiLink");
      return expectBracket(code);
    }

    function expectBracket(code: Parameters<State>[0]): State | undefined {
      if (code !== codes.leftSquareBracket) return nok(code);
      effects.enter("wikiLinkOpenSequence");
      openCount = 0;
      return openSequence(code);
    }

    function openSequence(code: Parameters<State>[0]): State | undefined {
      if (code === codes.leftSquareBracket) {
        effects.consume(code);
        openCount += 1;
        return openSequence;
      }
      if (openCount !== 2) return nok(code);
      effects.exit("wikiLinkOpenSequence");
      effects.enter("wikiLinkData");
      effects.enter("wikiLinkTarget");
      return target(code);
    }

    function target(code: Parameters<State>[0]): State | undefined {
      if (code === null || markdownLineEnding(code)) return nok(code);
      if (code === codes.verticalBar) {
        if (!hasTarget) return nok(code);
        effects.exit("wikiLinkTarget");
        effects.enter("wikiLinkAliasMarker");
        effects.consume(code);
        effects.exit("wikiLinkAliasMarker");
        effects.enter("wikiLinkAlias");
        return alias;
      }
      if (code === codes.rightSquareBracket) {
        if (!hasTarget) return nok(code);
        effects.exit("wikiLinkTarget");
        effects.exit("wikiLinkData");
        effects.enter(embed ? "embedMarker" : "wikiLinkMarker");
        closeCount = 0;
        return closeSequence(code);
      }
      hasTarget = true;
      effects.consume(code);
      return target;
    }

    function alias(code: Parameters<State>[0]): State | undefined {
      if (code === null || markdownLineEnding(code)) return nok(code);
      if (code === codes.rightSquareBracket) {
        if (!hasAlias) return nok(code);
        effects.exit("wikiLinkAlias");
        effects.exit("wikiLinkData");
        effects.enter(embed ? "embedMarker" : "wikiLinkMarker");
        closeCount = 0;
        return closeSequence(code);
      }
      hasAlias = true;
      effects.consume(code);
      return alias;
    }

    function closeSequence(code: Parameters<State>[0]): State | undefined {
      if (code !== codes.rightSquareBracket) return nok(code);
      effects.consume(code);
      closeCount += 1;
      if (closeCount < 2) return closeSequence;
      effects.exit(embed ? "embedMarker" : "wikiLinkMarker");
      effects.exit(embed ? "embed" : "wikiLink");
      return ok;
    }
  };

  return {
    text: {
      [codes.leftSquareBracket]: { tokenize: tokenize(false) },
      [codes.exclamationMark]: { tokenize: tokenize(true) },
    },
  };
}

export function obsidianWikiLinkFromMarkdown(): FromMarkdownExtension {
  const top = (stack: unknown[]): ObsidianWikiNode => stack[stack.length - 1] as ObsidianWikiNode;
  const enter: Handle = function (token) {
    this.enter({ type: token.type === "embed" ? "embed" : "wikiLink", value: "", data: {} } as never, token);
  };
  const exitTarget: Handle = function (token) {
    top(this.stack).value = this.sliceSerialize(token);
  };
  const exitAlias: Handle = function (token) {
    top(this.stack).data.alias = this.sliceSerialize(token);
  };
  const exit: Handle = function (token) {
    this.exit(token);
  };
  return {
    enter: { wikiLink: enter, embed: enter },
    exit: {
      wikiLinkTarget: exitTarget,
      wikiLinkAlias: exitAlias,
      wikiLink: exit,
      embed: exit,
    },
  };
}

export function remarkObsidianWikiLinks(this: Processor): void {
  const data = this.data() as {
    micromarkExtensions?: Extension[];
    fromMarkdownExtensions?: FromMarkdownExtension[];
  };
  (data.micromarkExtensions ??= []).push(obsidianWikiLinkSyntax());
  (data.fromMarkdownExtensions ??= []).push(obsidianWikiLinkFromMarkdown());
}
