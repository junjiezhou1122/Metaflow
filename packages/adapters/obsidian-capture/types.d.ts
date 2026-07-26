import "micromark-util-types";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    embed: "embed";
    embedMarker: "embedMarker";
    wikiLinkOpenSequence: "wikiLinkOpenSequence";
    wikiLink: "wikiLink";
    wikiLinkMarker: "wikiLinkMarker";
    wikiLinkData: "wikiLinkData";
    wikiLinkTarget: "wikiLinkTarget";
    wikiLinkAliasMarker: "wikiLinkAliasMarker";
    wikiLinkAlias: "wikiLinkAlias";
  }
}
