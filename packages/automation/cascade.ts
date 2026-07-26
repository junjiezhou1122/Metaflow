import type { ExactViewRef, JsonObject, ReactiveCascadeContext } from "@info/view";

export type ReactiveCascadeAttemptStatus =
  | "reserved"
  | "running"
  | "succeeded"
  | "failed"
  | "stopped";

export type ReactiveCascadeAttemptRecord = {
  context: ReactiveCascadeContext;
  status: ReactiveCascadeAttemptStatus;
  request_fingerprint: string;
  reserved_at: string;
  lease_expires_at?: string;
  updated_at: string;
  run_id?: string;
  error_code?: string;
  error_message?: string;
  cost_usd: number;
};

export class ReactiveCascadeLimitError extends Error {
  constructor(
    message: string,
    readonly code: "operator_concurrency_exhausted",
    readonly attempt_id: string,
  ) {
    super(message);
    this.name = "ReactiveCascadeLimitError";
  }
}

export type ReactiveCascadeEvent = {
  sequence: number;
  attempt_id: string;
  root_correlation_id: string;
  type: "reserved" | "recovered" | "duplicate" | "operator_bound" | "succeeded" | "failed" | "stopped";
  occurred_at: string;
  payload: JsonObject;
};

export type ReactiveCascadePlanReservation =
  | { outcome: "created" | "recovered"; attempts: ReactiveCascadeAttemptRecord[] }
  | { outcome: "duplicate"; attempts: ReactiveCascadeAttemptRecord[] }
  | {
      outcome: "stopped";
      code: "cycle" | "depth_exhausted" | "fan_out_exhausted" | "attempts_exhausted" | "cost_exhausted" | "time_exhausted";
      message: string;
      attempts: ReactiveCascadeAttemptRecord[];
    };

export interface ReactiveCascadeLedger {
  reservePlan(input: {
    attempts: ReactiveCascadeContext[];
    reserved_at: string;
  }): Promise<ReactiveCascadePlanReservation>;
  bindOperator(input: {
    attempt_id: string;
    operator: { id: string; revision: number };
    run_id: string;
    started_at: string;
  }): Promise<ReactiveCascadeAttemptRecord>;
  finalize(input: {
    attempt_id: string;
    status: "succeeded" | "failed" | "stopped";
    completed_at: string;
    run_id?: string;
    cost_usd: number;
    error_code?: string;
    error_message?: string;
  }): Promise<ReactiveCascadeAttemptRecord>;
  getAttempt(attemptId: string): Promise<ReactiveCascadeAttemptRecord | undefined>;
  listRoot(rootCorrelationId: string): Promise<ReactiveCascadeAttemptRecord[]>;
  listEvents(rootCorrelationId: string): Promise<ReactiveCascadeEvent[]>;
}

export type ReactiveCascadeTerminalization = {
  attempt: ReactiveCascadeAttemptRecord;
  code: string;
  message: string;
  stage: "admission" | "authorization" | "execution" | "validation" | "commit" | "transport";
  occurred_at: string;
};

export interface ReactiveCascadeTerminalizer {
  terminalize(input: ReactiveCascadeTerminalization): Promise<
    | { status: "succeeded"; run_id: string; output_views: ExactViewRef[] }
    | { status: "failed"; run_id: string; failure_view: ExactViewRef }
  >;
}
