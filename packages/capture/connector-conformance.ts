import { canonicalJson, type JsonValue } from "@info/view";
import {
  ConnectorKitError,
  type ConnectorKit,
} from "./connector-kit.js";
import type { RawViewCandidate, SourceConnection } from "./contracts.js";

export type ConnectorConformanceCase<Payload> = {
  name: string;
  payload: Payload;
  captured_at: string;
  expected_candidate_count: number;
  expected_schemas: string[];
  assert_lossless(input: { payload: Payload; candidates: RawViewCandidate[] }): void;
};

export type ConnectorConformanceInput<Configuration, Payload, Submission> = {
  kit: ConnectorKit<Configuration, Payload>;
  connection: SourceConnection;
  cases: Array<ConnectorConformanceCase<Payload>>;
  malformed_payloads: unknown[];
  submit(input: { payload: Payload; captured_at: string }): Promise<Submission>;
  replay_identity(submission: Submission): JsonValue;
};

export type ConnectorConformanceReport = {
  cases: Array<{
    name: string;
    candidate_count: number;
    schemas: string[];
    replay_identity: JsonValue;
  }>;
  malformed_payloads_rejected: number;
};

export type ConnectorConformanceV2Capability = "push" | "pull" | "stream" | "reference" | "incremental";

export type ConnectorConformanceV2Input<Configuration, Payload, Submission> =
  ConnectorConformanceInput<Configuration, Payload, Submission> & {
    probes: Partial<Record<ConnectorConformanceV2Capability, () => Promise<JsonValue>>>;
  };

export type ConnectorConformanceV2Report = ConnectorConformanceReport & {
  version: 2;
  capabilities: Record<ConnectorConformanceV2Capability, { declared: boolean; evidence?: JsonValue }>;
};

export class ConnectorConformanceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "missing_cases"
      | "missing_malformed_payloads"
      | "candidate_count_mismatch"
      | "schema_mismatch"
      | "nondeterministic_adapt"
      | "malformed_payload_accepted"
      | "replay_identity_mismatch"
      | "declared_capability_unproved",
    readonly case_name?: string,
  ) {
    super(message);
    this.name = "ConnectorConformanceError";
  }
}

export async function runConnectorConformanceV2<Configuration, Payload, Submission>(
  input: ConnectorConformanceV2Input<Configuration, Payload, Submission>,
): Promise<ConnectorConformanceV2Report> {
  const base = await runConnectorConformance(input);
  const capabilities = {} as ConnectorConformanceV2Report["capabilities"];
  for (const capability of ["push", "pull", "stream", "reference", "incremental"] as const) {
    const declared = capability === "incremental"
      ? input.kit.manifest.capabilities.includes("incremental")
      : input.kit.manifest.delivery_kinds.includes(capability);
    const probe = input.probes[capability];
    if (declared && !probe) {
      throw new ConnectorConformanceError(
        `Connector declares ${capability} without a conformance v2 probe`,
        "declared_capability_unproved",
        capability,
      );
    }
    capabilities[capability] = declared
      ? { declared, evidence: await probe!() }
      : { declared };
  }
  return { version: 2, ...base, capabilities };
}

export async function runConnectorConformance<Configuration, Payload, Submission>(
  input: ConnectorConformanceInput<Configuration, Payload, Submission>,
): Promise<ConnectorConformanceReport> {
  if (input.cases.length === 0) {
    throw new ConnectorConformanceError("Connector conformance requires at least one valid case", "missing_cases");
  }
  if (input.malformed_payloads.length === 0) {
    throw new ConnectorConformanceError(
      "Connector conformance requires at least one malformed payload",
      "missing_malformed_payloads",
    );
  }

  for (const malformed of input.malformed_payloads) {
    try {
      input.kit.adapt({ connection: input.connection, payload: malformed, captured_at: new Date(0).toISOString() });
    } catch (error) {
      if (error instanceof ConnectorKitError && error.code === "invalid_source_payload") continue;
      throw error;
    }
    throw new ConnectorConformanceError(
      "Connector accepted a malformed source payload",
      "malformed_payload_accepted",
    );
  }

  const reports: ConnectorConformanceReport["cases"] = [];
  for (const testCase of input.cases) {
    const adaptInput = {
      connection: input.connection,
      payload: testCase.payload,
      captured_at: testCase.captured_at,
    };
    const firstCandidates = input.kit.adapt(adaptInput);
    const secondCandidates = input.kit.adapt(adaptInput);
    if (canonicalJson(firstCandidates) !== canonicalJson(secondCandidates)) {
      throw new ConnectorConformanceError(
        `Connector Adapt is nondeterministic for ${testCase.name}`,
        "nondeterministic_adapt",
        testCase.name,
      );
    }
    if (firstCandidates.length !== testCase.expected_candidate_count) {
      throw new ConnectorConformanceError(
        `Connector emitted ${firstCandidates.length} candidates instead of ${testCase.expected_candidate_count}`,
        "candidate_count_mismatch",
        testCase.name,
      );
    }
    const schemas = firstCandidates.map(candidate => `${candidate.schema.name}@${candidate.schema.version}`).sort();
    const expectedSchemas = [...testCase.expected_schemas].sort();
    if (canonicalJson(schemas) !== canonicalJson(expectedSchemas)) {
      throw new ConnectorConformanceError(
        `Connector emitted unexpected Schemas for ${testCase.name}`,
        "schema_mismatch",
        testCase.name,
      );
    }
    testCase.assert_lossless({ payload: testCase.payload, candidates: firstCandidates });

    const firstSubmission = await input.submit({ payload: testCase.payload, captured_at: testCase.captured_at });
    const replaySubmission = await input.submit({ payload: testCase.payload, captured_at: testCase.captured_at });
    const firstIdentity = input.replay_identity(firstSubmission);
    const replayIdentity = input.replay_identity(replaySubmission);
    if (canonicalJson(firstIdentity) !== canonicalJson(replayIdentity)) {
      throw new ConnectorConformanceError(
        `Connector replay changed exact identity for ${testCase.name}`,
        "replay_identity_mismatch",
        testCase.name,
      );
    }
    reports.push({
      name: testCase.name,
      candidate_count: firstCandidates.length,
      schemas,
      replay_identity: replayIdentity,
    });
  }

  return { cases: reports, malformed_payloads_rejected: input.malformed_payloads.length };
}
