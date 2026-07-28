import type { CommitViewInput } from "@info/view";
import type {
  CaptureBatch,
  CaptureCheckpoint,
  CaptureDeadLetter,
  CaptureDeliveryKind,
  CaptureRetryPolicy,
  CaptureSafeError,
  CaptureTraceEvent,
  ConnectorHealth,
  ConnectorManifest,
  IngestReceipt,
  SourceConnection,
  StoredCaptureTraceEvent,
} from "./contracts.js";
import type {
  SourceConnectionLifecycle,
  SourceConnectionLifecycleReceipt,
} from "./onboarding.js";

export type ConnectorOpenRequest = {
  delivery: Extract<CaptureDeliveryKind, "pull" | "stream" | "reference">;
  checkpoint: CaptureCheckpoint;
  parameters: Record<string, unknown>;
};

export type ConnectorContext = {
  signal?: AbortSignal;
};

export interface ConnectorPort {
  readonly manifest: ConnectorManifest;
  health(connection: SourceConnection, context: ConnectorContext): Promise<{
    capabilities: string[];
    details?: Record<string, unknown>;
  }>;
  open(
    connection: SourceConnection,
    request: ConnectorOpenRequest,
    context: ConnectorContext,
  ): AsyncIterable<CaptureBatch>;
}

export type PreparedCaptureCommit = {
  candidate_index: number;
  commit: CommitViewInput;
};

export type CommitCaptureBatchInput = {
  connection: SourceConnection;
  batch: CaptureBatch;
  attempt: number;
  commits: PreparedCaptureCommit[];
  skipped: Array<{ candidate_index: number; receipt: Extract<IngestReceipt, { status: "skipped" }> }>;
  checkpoint: CaptureCheckpoint;
  completed_at: string;
};

export type CommitCaptureBatchResult = {
  receipts: IngestReceipt[];
  checkpoint: CaptureCheckpoint;
  replayed: boolean;
  transaction_id: string;
};

export interface CaptureRuntimeRepository {
  registerCaptureConnection(input: {
    connection: SourceConnection;
    manifest: ConnectorManifest;
    occurred_at: string;
  }): Promise<void>;
  getCaptureConnection(connectionId: string): Promise<SourceConnection | undefined>;
  getCaptureCheckpoint(connectionId: string): Promise<CaptureCheckpoint | undefined>;
  getCaptureHealth(connectionId: string): Promise<ConnectorHealth | undefined>;
  beginCaptureAttempt(input: {
    connection_id: string;
    batch: CaptureBatch;
    attempt: number;
    max_in_flight: number;
    occurred_at: string;
  }): Promise<void>;
  commitCaptureBatch(input: CommitCaptureBatchInput): Promise<CommitCaptureBatchResult>;
  failCaptureAttempt(input: {
    connection_id: string;
    batch: CaptureBatch;
    attempt: number;
    error: CaptureSafeError;
    occurred_at: string;
    dead_letter?: CaptureDeadLetter;
  }): Promise<void>;
  appendCaptureTrace(event: CaptureTraceEvent): Promise<StoredCaptureTraceEvent>;
  getCaptureTrace(connectionId: string): Promise<StoredCaptureTraceEvent[]>;
  setCapturePaused(input: { connection_id: string; paused: boolean; occurred_at: string }): Promise<void>;
  recordCaptureHealth(input: { health: ConnectorHealth; event: CaptureTraceEvent }): Promise<void>;
  listCaptureDeadLetters(connectionId: string, status?: CaptureDeadLetter["status"]): Promise<CaptureDeadLetter[]>;
  getCaptureDeadLetter(id: string): Promise<CaptureDeadLetter | undefined>;
  resolveCaptureDeadLetter(input: { id: string; resolved_at: string }): Promise<CaptureDeadLetter>;
  listCaptureConnectionLifecycles(): Promise<SourceConnectionLifecycle[]>;
  getCaptureConnectionLifecycle(connectionId: string): Promise<SourceConnectionLifecycle | undefined>;
  updateCaptureConnectionLifecycle(input: {
    connection: SourceConnection;
    manifest: ConnectorManifest;
    expected_generation: number;
    status: SourceConnectionLifecycle["status"];
    occurred_at: string;
    event: CaptureTraceEvent;
    receipt?: SourceConnectionLifecycleReceipt;
  }): Promise<SourceConnectionLifecycle>;
  getCaptureConnectionLifecycleReceipt(idempotencyKey: string): Promise<SourceConnectionLifecycleReceipt | undefined>;
  commitCaptureConnectionLifecycleReceipt(input: {
    receipt: SourceConnectionLifecycleReceipt;
    event?: CaptureTraceEvent;
  }): Promise<SourceConnectionLifecycleReceipt>;
}

export type CaptureRuntimeOptions = {
  retry_policy: CaptureRetryPolicy;
  max_in_flight?: number;
  now?: () => string;
  dead_letter_id?: (batch: CaptureBatch) => string;
};
