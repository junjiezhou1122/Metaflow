import { parseViewDraft } from "./validation.js";
import { canonicalJson } from "./canonical-json.js";
import { SOURCE_TOMBSTONE_REPRESENTATION_KIND } from "./schema.js";
import type { ExactViewRef, View, ViewDraft, ViewRelationTarget, ViewSchemaRef } from "./schema.js";

export type ViewTransition =
  | { kind: "revision"; base: ExactViewRef }
  | { kind: "fork"; base: ExactViewRef };

export type ViewRevisionTransitionErrorCode =
  | "role_change_requires_fork"
  | "purpose_change_requires_fork"
  | "missing_exact_lineage"
  | "raw_occurrence_is_immutable"
  | "raw_source_identity_changed"
  | "schema_family_change_requires_fork"
  | "schema_version_regression"
  | "schema_revision_redefined"
  | "tombstone_is_terminal"
  | "invalid_tombstone_transition";

export class ViewRevisionTransitionError extends Error {
  constructor(
    message: string,
    readonly code: ViewRevisionTransitionErrorCode,
  ) {
    super(message);
    this.name = "ViewRevisionTransitionError";
  }
}

export function exactViewRef(view: Pick<View, "id" | "revision">): ExactViewRef {
  return { view_id: view.id, revision: view.revision };
}

export function viewRevisionKey(ref: ExactViewRef): string {
  return `${ref.view_id}@${ref.revision}`;
}

export function relationTargets(
  relations: readonly ViewRelationTarget[],
  type: string,
  target: ExactViewRef,
): boolean {
  return relations.some((relation) => (
    relation.type === type
    && relation.target.view_id === target.view_id
    && relation.target.revision === target.revision
  ));
}

export function assertViewRevisionTransition(previous: View, input: unknown): ViewTransition {
  const next = parseViewDraft(input);
  const base = exactViewRef(previous);

  if (previous.id !== next.id) {
    if (!relationTargets(next.relations, "forked_from", base)) {
      throw new ViewRevisionTransitionError(
        `Fork ${next.id} must reference exact base ${viewRevisionKey(base)}`,
        "missing_exact_lineage",
      );
    }
    return { kind: "fork", base };
  }

  if (previous.role !== next.role) {
    throw new ViewRevisionTransitionError(
      `View ${previous.id} cannot change role from ${previous.role} to ${next.role}`,
      "role_change_requires_fork",
    );
  }
  if (previous.purpose !== next.purpose) {
    throw new ViewRevisionTransitionError(
      `View ${previous.id} cannot change purpose without a new View identity`,
      "purpose_change_requires_fork",
    );
  }
  assertSchemaTransition(previous.schema, next.schema);
  if (!relationTargets(next.relations, "supersedes", base)) {
    throw new ViewRevisionTransitionError(
      `Revision of ${previous.id} must supersede exact base ${viewRevisionKey(base)}`,
      "missing_exact_lineage",
    );
  }

  if (previous.representation.kind === SOURCE_TOMBSTONE_REPRESENTATION_KIND) {
    throw new ViewRevisionTransitionError(
      `Source tombstone ${previous.id}@${previous.revision} is terminal`,
      "tombstone_is_terminal",
    );
  }
  if (next.representation.kind === SOURCE_TOMBSTONE_REPRESENTATION_KIND && previous.role !== "raw") {
    throw new ViewRevisionTransitionError(
      "Only a Raw View can transition to a source tombstone",
      "invalid_tombstone_transition",
    );
  }
  if (previous.role === "raw") assertRawSourceRevision(previous, next);
  return { kind: "revision", base };
}

function assertSchemaTransition(previous: ViewSchemaRef, next: ViewSchemaRef): void {
  if (previous.name !== next.name) {
    throw new ViewRevisionTransitionError(
      `View Schema family cannot change from ${previous.name} to ${next.name} without a new View identity`,
      "schema_family_change_requires_fork",
    );
  }
  if (next.version < previous.version) {
    throw new ViewRevisionTransitionError(
      `Schema ${next.name} cannot regress from version ${previous.version} to ${next.version}`,
      "schema_version_regression",
    );
  }
  if (next.version === previous.version && canonicalJson(previous) !== canonicalJson(next)) {
    throw new ViewRevisionTransitionError(
      `Schema ${next.name}@${next.version} is immutable and cannot be redefined`,
      "schema_revision_redefined",
    );
  }
}

function assertRawSourceRevision(previous: View, next: ViewDraft): void {
  const previousCapture = previous.provenance.capture;
  const nextCapture = next.provenance.capture;
  if (!previousCapture || !nextCapture) {
    throw new ViewRevisionTransitionError("Raw View capture provenance is missing", "raw_source_identity_changed");
  }
  if (
    (previousCapture.identity === "occurrence" || nextCapture.identity === "occurrence")
    && next.representation.kind !== SOURCE_TOMBSTONE_REPRESENTATION_KIND
  ) {
    throw new ViewRevisionTransitionError(
      `Raw occurrence ${previous.id} is immutable and a new occurrence requires a new View identity`,
      "raw_occurrence_is_immutable",
    );
  }
  const sameSource = previousCapture.connector === nextCapture.connector
    && previousCapture.connection_id === nextCapture.connection_id
    && previousCapture.source_id === nextCapture.source_id
    && previousCapture.source_kind === nextCapture.source_kind;
  if (!sameSource) {
    throw new ViewRevisionTransitionError(
      `Raw View ${previous.id} cannot change its stable source identity`,
      "raw_source_identity_changed",
    );
  }
}
