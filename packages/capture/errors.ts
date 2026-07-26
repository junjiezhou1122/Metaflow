import { ViewRepositoryError, ViewValidationError } from "@info/view";
import {
  CaptureRuntimeError,
  CaptureSafeErrorSchema,
  CaptureValidationError,
  ConnectorProtocolError,
  type CaptureSafeError,
} from "./contracts.js";
import { ConnectorKitError } from "./connector-kit.js";

export function safeCaptureError(
  error: unknown,
  stage: CaptureSafeError["stage"] = "admission",
): CaptureSafeError {
  if (error instanceof CaptureRuntimeError) {
    return CaptureSafeErrorSchema.parse({
      code: error.code,
      message: error.message,
      stage: error.stage,
      retryable: error.retryable,
      details: error.details,
    });
  }
  if (error instanceof CaptureValidationError) {
    return CaptureSafeErrorSchema.parse({
      code: error.code,
      message: "Capture input failed strict validation",
      stage: "validation",
      retryable: false,
      details: { issue_count: error.issues.length },
    });
  }
  if (error instanceof ConnectorKitError) {
    return CaptureSafeErrorSchema.parse({
      code: error.code,
      message: error.code === "connector_adapt_failed"
        ? "Connector Adapt function failed"
        : "Connector Kit input failed strict validation",
      stage: error.code === "connector_adapt_failed" ? "connector" : "validation",
      retryable: false,
      details: { ...error.details },
    });
  }
  if (error instanceof ViewValidationError) {
    return CaptureSafeErrorSchema.parse({
      code: error.code,
      message: "Capture View failed strict validation",
      stage: "validation",
      retryable: false,
      details: { issue_count: error.issues.length },
    });
  }
  if (error instanceof ViewRepositoryError) {
    return CaptureSafeErrorSchema.parse({
      code: error.code,
      message: `Capture storage operation failed with ${error.code}`,
      stage: error.code === "storage_failure" ? "storage" : "admission",
      retryable: error.code === "storage_failure",
      details: { operation: error.details.operation, phase: error.details.phase ?? "unknown" },
    });
  }
  if (error instanceof ConnectorProtocolError) {
    return CaptureSafeErrorSchema.parse({
      code: error.code,
      message: "Connector protocol operation failed",
      stage: "connector",
      retryable: true,
      details: {},
    });
  }
  return CaptureSafeErrorSchema.parse({
    code: stage === "connector" ? "connector_crash" : "capture_runtime_crash",
    message: stage === "connector" ? "Connector threw an unstructured error" : "Capture runtime operation crashed",
    stage,
    retryable: stage === "connector",
    details: {},
  });
}
