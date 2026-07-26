import { z } from "zod";
import {
  ExactTransformationRefSchema,
  TransformationSchema,
  type ExactTransformationRef,
  type Transformation,
} from "./schema.js";

export type TransformationRevisionTransitionCode =
  | "identity_changed"
  | "revision_not_sequential"
  | "supersedes_mismatch";

export class TransformationRevisionTransitionError extends Error {
  constructor(
    message: string,
    readonly code: TransformationRevisionTransitionCode,
  ) {
    super(message);
    this.name = "TransformationRevisionTransitionError";
  }
}

export function parseTransformation(input: unknown): Transformation {
  return TransformationSchema.parse(input);
}

export function exactTransformationRef(input: Transformation | ExactTransformationRef): ExactTransformationRef {
  if ("id" in input) return { transformation_id: input.id, revision: input.revision };
  return ExactTransformationRefSchema.parse(input);
}

export function assertTransformationRevisionTransition(
  previousInput: unknown,
  nextInput: unknown,
): asserts nextInput is Transformation {
  const previous = TransformationSchema.parse(previousInput);
  const next = TransformationSchema.parse(nextInput);
  if (next.id !== previous.id) {
    throw new TransformationRevisionTransitionError(
      "A Transformation revision cannot change identity",
      "identity_changed",
    );
  }
  if (next.revision !== previous.revision + 1) {
    throw new TransformationRevisionTransitionError(
      "A Transformation revision must advance exactly once",
      "revision_not_sequential",
    );
  }
  const expected = exactTransformationRef(previous);
  if (
    !next.supersedes
    || next.supersedes.transformation_id !== expected.transformation_id
    || next.supersedes.revision !== expected.revision
  ) {
    throw new TransformationRevisionTransitionError(
      "A Transformation revision must supersede its exact prior revision",
      "supersedes_mismatch",
    );
  }
}

export function safeParseTransformation(input: unknown): z.SafeParseReturnType<unknown, Transformation> {
  return TransformationSchema.safeParse(input);
}
