import type { ExactTransformationRef, Transformation } from "./schema.js";

export type CommitTransformationInput = {
  transformation: Transformation;
  expected_revision: number;
  idempotency_key?: string;
};

export type CommitTransformationResult = {
  transformation: Transformation;
  created: boolean;
  transaction_id: string;
};

export interface TransformationRepository {
  commit(input: CommitTransformationInput): Promise<CommitTransformationResult>;
  get(ref: ExactTransformationRef): Promise<Transformation | undefined>;
  getLatest(transformationId: string): Promise<Transformation | undefined>;
}

export type TransformationRepositoryErrorCode =
  | "conflict"
  | "idempotency_conflict"
  | "invalid_request"
  | "corrupt_data"
  | "storage_failure";

export type TransformationRepositoryErrorDetails = {
  operation: string;
  phase?: string;
  transaction_id?: string;
  transformation_id?: string;
  revision?: number;
  expected_revision?: number;
  actual_revision?: number;
  idempotency_key?: string;
  sqlite_code?: string;
};

export class TransformationRepositoryError extends Error {
  constructor(
    message: string,
    readonly code: TransformationRepositoryErrorCode,
    readonly details: TransformationRepositoryErrorDetails,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TransformationRepositoryError";
  }
}
