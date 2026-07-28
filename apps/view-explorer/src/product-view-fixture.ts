import { ViewRepresentationSchema, ViewSchemaRefSchema } from "@info/view/schema";
import {
  PERSONAL_AUDIO_REPRESENTATION,
  PERSONAL_DAILY_SUMMARY_REPRESENTATION,
  PERSONAL_TIMELINE_REPRESENTATION,
  personalActivityFixtures,
  personalAudioSchema,
  personalDailySummarySchema,
  personalTimelineSchema,
} from "@info/view-package-personal-activity/browser";
import {
  refKey,
  type ExactViewRef,
  type View,
  type ViewGraphProjectionNode,
  type ViewGraphProjectionResult,
} from "./contracts.js";
import { PRODUCT_VIEW_REFS, PRODUCT_VIEWS_FIXTURE_ID } from "./product-view-fixture-contract.js";

const CREATED_AT = "2026-07-27T08:00:00.000Z";

export function makeProductViewProjection(): ViewGraphProjectionResult {
  const refs = PRODUCT_VIEW_REFS;
  const timelineRelation = "product-view:daily-summary:timeline";
  const audioDesignRelation = "product-view:timeline:audio-design";
  const audioScopeRelation = "product-view:timeline:audio-scope";
  const nodes: ViewGraphProjectionNode[] = [
    productNode(refs.daily_summary, "Daily Summary · Jul 27", "Readable synthesis of the day's themes, decisions, and open threads", personalDailySummarySchema.name, "derived", PERSONAL_DAILY_SUMMARY_REPRESENTATION, 0, []),
    productNode(refs.timeline, "Activity Timeline · Jul 27", "Chronological activity blocks with exact source View evidence", personalTimelineSchema.name, "derived", PERSONAL_TIMELINE_REPRESENTATION, 1, [timelineRelation]),
    productNode(refs.audio_design, "Audio · View architecture", "Semantic transcript of the View architecture discussion", personalAudioSchema.name, "raw", PERSONAL_AUDIO_REPRESENTATION, 2, [timelineRelation, audioDesignRelation]),
    productNode(refs.audio_scope, "Audio · Implementation scope", "Semantic transcript of the product-scope decision", personalAudioSchema.name, "raw", PERSONAL_AUDIO_REPRESENTATION, 2, [timelineRelation, audioScopeRelation]),
  ];
  return {
    projection_version: 1,
    roots: [refs.daily_summary],
    nodes,
    edges: [
      { id: timelineRelation, type: "derived_from", source: refs.daily_summary, target: refs.timeline, depth: 1 },
      { id: audioDesignRelation, type: "derived_from", source: refs.timeline, target: refs.audio_design, depth: 2 },
      { id: audioScopeRelation, type: "derived_from", source: refs.timeline, target: refs.audio_scope, depth: 2 },
    ],
    frontier: [],
    truncation: { truncated: false, reasons: [] },
    redacted_boundary: false,
  };
}

export function makeProductViews(): Map<string, View> {
  const fixtureById = new Map(personalActivityFixtures.map(fixture => [fixture.id, fixture]));
  const definitions = [
    {
      ref: PRODUCT_VIEW_REFS.audio_design,
      name: "Audio · View architecture",
      purpose: "Semantic transcript of the View architecture discussion",
      schema: personalAudioSchema,
      fixture: fixtureById.get("fixture.personal.audio.design-conversation")!,
      role: "raw" as const,
      inputs: [] as ExactViewRef[],
      actor: "capture-ingress",
    },
    {
      ref: PRODUCT_VIEW_REFS.audio_scope,
      name: "Audio · Implementation scope",
      purpose: "Semantic transcript of the product-scope decision",
      schema: personalAudioSchema,
      fixture: fixtureById.get("fixture.personal.audio.implementation-focus")!,
      role: "raw" as const,
      inputs: [] as ExactViewRef[],
      actor: "capture-ingress",
    },
    {
      ref: PRODUCT_VIEW_REFS.timeline,
      name: "Activity Timeline · Jul 27",
      purpose: "Chronological activity blocks with exact source View evidence",
      schema: personalTimelineSchema,
      fixture: fixtureById.get("fixture.personal.timeline.2026-07-27")!,
      role: "derived" as const,
      inputs: [PRODUCT_VIEW_REFS.audio_design, PRODUCT_VIEW_REFS.audio_scope],
      actor: "operator:personal-timeline",
    },
    {
      ref: PRODUCT_VIEW_REFS.daily_summary,
      name: "Daily Summary · Jul 27",
      purpose: "Readable synthesis of the day's themes, decisions, and open threads",
      schema: personalDailySummarySchema,
      fixture: fixtureById.get("fixture.personal.summary.2026-07-27")!,
      role: "derived" as const,
      inputs: [PRODUCT_VIEW_REFS.timeline],
      actor: "operator:personal-daily-summary",
    },
  ];
  return new Map(definitions.map(definition => {
    const view: View = {
      id: definition.ref.view_id,
      revision: definition.ref.revision,
      name: definition.name,
      purpose: definition.purpose,
      aliases: [],
      schema: ViewSchemaRefSchema.parse(definition.schema),
      role: definition.role,
      time: { ...(definition.role === "raw" ? { observed_at: CREATED_AT } : {}), created_at: CREATED_AT },
      representation: ViewRepresentationSchema.parse(definition.fixture.representation),
      materialization: { primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } }, alternatives: [] },
      relations: definition.inputs.map(target => ({ type: "derived_from", target, metadata: {} })),
      provenance: definition.role === "raw" ? {
        inputs: [],
        actor: definition.actor,
        capture: {
          connector: "screenpipe",
          connection_id: "fixture:screenpipe",
          source_id: definition.ref.view_id,
          source_kind: "audio_occurrence",
          identity: "occurrence",
          assertion: "direct",
        },
      } : {
        inputs: definition.inputs,
        actor: definition.actor,
        operator_run_id: `run:${definition.ref.view_id}`,
      },
      policy: { owner: "user:fixture", visibility: "private", privacy: "private", retention: "normal", allow_external_model: false, allow_embedding: false, allow_local_search: true, labels: ["product-view"] },
      metadata: { fixture: PRODUCT_VIEWS_FIXTURE_ID },
    };
    return [refKey(definition.ref), view];
  }));
}

function productNode(
  ref: ExactViewRef,
  name: string,
  purpose: string,
  schemaName: string,
  role: ViewGraphProjectionNode["role"],
  representationKind: string,
  depth: number,
  path: string[],
): ViewGraphProjectionNode {
  return {
    ref,
    name,
    purpose,
    schema: { name: schemaName, version: 1 },
    role,
    time: { ...(role === "raw" ? { observed_at: CREATED_AT } : {}), created_at: CREATED_AT },
    representation: { kind: representationKind, media_type: "application/json" },
    depth,
    path,
  };
}
