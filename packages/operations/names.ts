export const OPERATION_NAMES = [
  "catalog.list",
  "capture.ingest",
  "view.get",
  "view.graph.project",
  "view.search",
  "view.search.reindex",
  "view.traverse",
  "view.tombstone",
  "transformation.submit",
  "transformation.get",
  "run.execute",
  "run.inspect",
  "run.cancel",
  "feedback.submit",
  "failure.inspect",
  "policy.decision.get",
  "privacy.forget.request",
  "privacy.forget.execute",
  "privacy.forget.inspect",
  "trace.read",
] as const;

export type OperationName = typeof OPERATION_NAMES[number];
