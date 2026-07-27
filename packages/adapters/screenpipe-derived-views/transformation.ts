import { createHash } from "node:crypto";
import { exactViewRef, type View } from "@info/view";
import { parseTransformation, type Transformation } from "@info/transformation";
import {
  SCREENPIPE_AUDIO_FUNCTION,
  SCREENPIPE_AUDIO_SCHEMA,
  SCREENPIPE_TIMELINE_FUNCTION,
  SCREENPIPE_TIMELINE_SCHEMA,
  ScreenpipeDerivedPeriodSchema,
} from "./contracts.js";

export function createScreenpipeDerivedTransformation(input: {
  kind: "timeline" | "audio";
  views: readonly View[];
  output_view_id: string;
  expected_view_revision: number;
  transformation_revision?: number;
  created_at: string;
  period: { start: string; end: string; timezone: string };
}): Transformation {
  const period = ScreenpipeDerivedPeriodSchema.parse(input.period);
  if (input.views.length === 0) throw new TypeError("Screenpipe derived Transformation requires exact input Views");
  const revision = input.transformation_revision ?? 1;
  const digest = createHash("sha256").update(input.output_view_id).digest("hex").slice(0, 24);
  const id = `transformation.screenpipe.${input.kind}.${digest}`;
  const reference = input.kind === "timeline" ? SCREENPIPE_TIMELINE_FUNCTION : SCREENPIPE_AUDIO_FUNCTION;
  const schema = input.kind === "timeline" ? SCREENPIPE_TIMELINE_SCHEMA : SCREENPIPE_AUDIO_SCHEMA;
  return parseTransformation({
    id,
    revision,
    name: input.kind === "timeline" ? "Compress Screenpipe Timeline View" : "Compose Screenpipe Audio View",
    instruction: {
      format: "natural_language",
      language: "en",
      text: input.kind === "timeline"
        ? "Deterministically order and compress exact Screenpipe Raw Views without inventing activity."
        : "Deterministically compose exact Screenpipe audio transcript segments without speaker or semantic inference.",
      parameters: {},
    },
    operator: {
      id: `operator.${reference.function_id}`,
      revision: 1,
      reference,
      configuration: {
        output_view_id: input.output_view_id,
        expected_revision: input.expected_view_revision,
        period,
      },
      required_capabilities: [],
    },
    inputs: [{
      role: "source",
      required: true,
      sources: input.views.map(view => ({ kind: "view", ref: exactViewRef(view) })),
    }],
    output: { schema, schema_origin: "declared", cardinality: { min: 1, max: 1 } },
    policy: {
      id: `policy.screenpipe.${input.kind}.local`,
      revision: 1,
      configuration: { kind: "view_access", profile: "approve_all", rules: [] },
    },
    budget: {
      id: `budget.screenpipe.${input.kind}`,
      revision: 1,
      limits: { timeout_ms: 10_000, max_attempts: 1 },
      extensions: {},
    },
    created_at: input.created_at,
    ...(revision > 1 ? { supersedes: { transformation_id: id, revision: revision - 1 } } : {}),
    metadata: { source: "screenpipe", formation: input.kind },
  });
}
