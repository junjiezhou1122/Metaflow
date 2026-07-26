import { canonicalJson, type ExactViewRef } from "@info/view";
import type { SearchHitV1, SearchMatchV1, SearchMode, SearchPathStep } from "./contracts.js";
import { SearchError } from "./errors.js";
import type { ModeCandidates, RankedSearchCandidate } from "./ports.js";

type MutableHit = Omit<SearchHitV1, "matches" | "scores" | "explanation"> & {
  matches: Map<string, SearchMatchV1>;
  scores: SearchHitV1["scores"];
  explanations: Set<SearchHitV1["explanation"][number]>;
  relationDepth: number;
};

export type SearchSortTuple = [fused: number, relationDepth: number, viewId: string, revision: number, path: string];

export function fuseSearchCandidates(input: {
  modes: SearchMode[];
  candidates: ModeCandidates;
  weights: Partial<Record<SearchMode, number>>;
  k: 60;
}): SearchHitV1[] {
  const hits = new Map<string, MutableHit>();
  for (const mode of input.modes) {
    const candidates = input.candidates[mode];
    if (!candidates) continue;
    const grouped = groupModeCandidates(candidates, mode);
    let rank = 0;
    for (const candidate of grouped) {
      rank += 1;
      const key = refKey(candidate.ref);
      const existing = hits.get(key);
      const contribution = (input.weights[mode] ?? 1) / (input.k + rank);
      if (!existing) {
        const scores: SearchHitV1["scores"] = { fused: contribution };
        scores[rankField(mode)] = rank;
        hits.set(key, {
          ref: candidate.ref,
          owner_ref: candidate.owner_ref,
          matched_schema: candidate.matched_schema,
          representation_kind: candidate.representation_kind,
          ...(candidate.path ? { path: candidate.path } : {}),
          matches: new Map(candidate.matches.map(match => [matchKey(match), match])),
          scores,
          explanations: new Set([mode]),
          relationDepth: candidate.path?.length ?? Number.MAX_SAFE_INTEGER,
        });
        continue;
      }
      assertSameDescriptor(existing, candidate);
      existing.scores.fused += contribution;
      existing.scores[rankField(mode)] = rank;
      existing.explanations.add(mode);
      if (isPreferredPath(candidate.path, existing.path)) {
        existing.path = candidate.path;
        existing.relationDepth = candidate.path?.length ?? Number.MAX_SAFE_INTEGER;
      }
      for (const match of candidate.matches) mergeMatch(existing.matches, match);
    }
  }

  return [...hits.values()]
    .map(hit => ({
      ref: hit.ref,
      owner_ref: hit.owner_ref,
      matched_schema: hit.matched_schema,
      representation_kind: hit.representation_kind,
      matches: [...hit.matches.values()].sort(compareMatches),
      ...(hit.path ? { path: hit.path } : {}),
      scores: hit.scores,
      explanation: [...hit.explanations].sort(compareExplanation),
    }))
    .sort(compareSearchHits);
}

export function compareSearchHits(left: SearchHitV1, right: SearchHitV1): number {
  const a = searchSortTuple(left);
  const b = searchSortTuple(right);
  return b[0] - a[0]
    || a[1] - b[1]
    || a[2].localeCompare(b[2])
    || b[3] - a[3]
    || a[4].localeCompare(b[4]);
}

export function searchSortTuple(hit: SearchHitV1): SearchSortTuple {
  return [
    hit.scores.fused,
    hit.path?.length ?? Number.MAX_SAFE_INTEGER,
    hit.ref.view_id,
    hit.ref.revision,
    pathKey(hit.path),
  ];
}

function groupModeCandidates(candidates: RankedSearchCandidate[], mode: SearchMode): RankedSearchCandidate[] {
  const grouped = new Map<string, RankedSearchCandidate>();
  for (const candidate of candidates) {
    const key = refKey(candidate.ref);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        ...candidate,
        matches: candidate.matches.map(match => ({ ...match, modes: uniqueModes([...match.modes, mode]) })),
      });
      continue;
    }
    assertSameDescriptor(existing, candidate);
    const matches = new Map(existing.matches.map(match => [matchKey(match), match]));
    for (const match of candidate.matches) mergeMatch(matches, { ...match, modes: uniqueModes([...match.modes, mode]) });
    existing.matches = [...matches.values()];
    if (isPreferredPath(candidate.path, existing.path)) existing.path = candidate.path;
  }
  return [...grouped.values()];
}

function mergeMatch(matches: Map<string, SearchMatchV1>, incoming: SearchMatchV1): void {
  const key = matchKey(incoming);
  const current = matches.get(key);
  if (!current) {
    matches.set(key, incoming);
    return;
  }
  matches.set(key, {
    ...current,
    modes: uniqueModes([...current.modes, ...incoming.modes]),
    ...(current.snippet === undefined && incoming.snippet !== undefined ? { snippet: incoming.snippet } : {}),
    ...(current.semantic_evidence_ref === undefined && incoming.semantic_evidence_ref !== undefined
      ? { semantic_evidence_ref: incoming.semantic_evidence_ref }
      : {}),
  });
}

function assertSameDescriptor(left: Pick<RankedSearchCandidate, "ref" | "owner_ref" | "matched_schema" | "representation_kind">, right: RankedSearchCandidate): void {
  if (canonicalJson({
    ref: left.ref,
    owner_ref: left.owner_ref,
    matched_schema: left.matched_schema,
    representation_kind: left.representation_kind,
  }) !== canonicalJson({
    ref: right.ref,
    owner_ref: right.owner_ref,
    matched_schema: right.matched_schema,
    representation_kind: right.representation_kind,
  })) {
    throw new SearchError(`Retrievers disagreed on immutable descriptor for ${refKey(right.ref)}`, "fusion_failed", "fusion");
  }
}

function rankField(mode: SearchMode): "keyword_rank" | "semantic_rank" | "relation_rank" {
  return `${mode}_rank` as "keyword_rank" | "semantic_rank" | "relation_rank";
}

function uniqueModes(modes: SearchMode[]): SearchMode[] {
  const order: SearchMode[] = ["keyword", "semantic", "relation"];
  return order.filter(mode => modes.includes(mode));
}

function compareExplanation(left: SearchHitV1["explanation"][number], right: SearchHitV1["explanation"][number]): number {
  return ["keyword", "semantic", "relation", "reranked"].indexOf(left)
    - ["keyword", "semantic", "relation", "reranked"].indexOf(right);
}

function compareMatches(left: SearchMatchV1, right: SearchMatchV1): number {
  return matchKey(left).localeCompare(matchKey(right));
}

function matchKey(match: SearchMatchV1): string {
  return `${canonicalJson(match.location)}:${match.value_digest}`;
}

function refKey(ref: ExactViewRef): string {
  return `${ref.view_id}@${ref.revision}`;
}

function pathKey(path: SearchPathStep[] | undefined): string {
  return path ? canonicalJson(path) : "";
}

function isPreferredPath(candidate: SearchPathStep[] | undefined, current: SearchPathStep[] | undefined): boolean {
  if (!candidate) return false;
  if (!current) return true;
  return candidate.length < current.length || (candidate.length === current.length && pathKey(candidate) < pathKey(current));
}
