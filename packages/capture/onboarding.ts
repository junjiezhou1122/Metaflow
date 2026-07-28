import { createHash } from "node:crypto";
import { z } from "zod";
import { JsonValueSchema, ViewPolicySchema, canonicalJson, type JsonObject, type JsonValue } from "@info/view";
import {
  CaptureDeliveryKindSchema,
  CaptureIdentifierSchema,
  CaptureRuntimeError,
  CaptureTimestampSchema,
  NamedSecretReferencesSchema,
  SourceConnectionSchema,
  type CaptureDeliveryKind,
  type SourceConnection,
} from "./contracts.js";
import {
  ConnectorPackageError,
  type ConnectorPackageCatalog,
  type ConnectorPackageDescriptor,
  type ConnectorPackageImplementation,
  type ExactConnectorPackageRef,
  type TrustedConnectorPackageLoader,
} from "./connector-package.js";
import type { CaptureRuntimeRepository, CommitCaptureBatchResult } from "./runtime-contracts.js";
import type { ConnectorRuntime } from "./runtime.js";

export const SourceConnectionLifecycleStatusSchema = z.enum(["draft", "checked", "active", "paused"]);

export const SourceConnectionLifecycleSchema = z.object({
  connection: SourceConnectionSchema,
  generation: z.number().int().positive(),
  status: SourceConnectionLifecycleStatusSchema,
  created_at: CaptureTimestampSchema,
  updated_at: CaptureTimestampSchema,
}).strict();

export const SourceConnectionLifecycleReceiptSchema = z.object({
  idempotency_key: CaptureIdentifierSchema,
  request_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  action: z.enum(["create", "check", "discover", "activate", "update", "pause", "run"]),
  connection_id: CaptureIdentifierSchema,
  generation: z.number().int().positive(),
  committed_at: CaptureTimestampSchema,
  result: JsonValueSchema,
}).strict();

export type SourceConnectionLifecycle = z.infer<typeof SourceConnectionLifecycleSchema>;
export type SourceConnectionLifecycleReceipt = z.infer<typeof SourceConnectionLifecycleReceiptSchema>;

export class SourceConnectionOnboardingError extends Error {
  constructor(
    message: string,
    readonly code:
      | "connection_not_found"
      | "connection_generation_conflict"
      | "connection_state_conflict"
      | "connection_idempotency_conflict"
      | "connection_package_required"
      | "connection_secret_slot_missing"
      | "connection_secret_slot_unknown"
      | "connection_secret_provider_denied"
      | "connection_delivery_unsupported"
      | "connection_discovery_unsupported",
    readonly details: JsonObject = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SourceConnectionOnboardingError";
  }
}

export class SourceConnectionOnboardingService {
  private readonly loaded = new Map<string, ConnectorPackageImplementation>();
  private readonly loading = new Map<string, Promise<ConnectorPackageImplementation>>();
  private readonly now: () => string;

  constructor(private readonly dependencies: {
    catalog: ConnectorPackageCatalog;
    loader: TrustedConnectorPackageLoader;
    runtime: ConnectorRuntime;
    repository: CaptureRuntimeRepository;
    now?: () => string;
  }) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  listPackages(): ConnectorPackageDescriptor[] {
    return this.dependencies.catalog.list();
  }

  inspectPackage(ref: ExactConnectorPackageRef): ConnectorPackageDescriptor {
    return this.dependencies.catalog.resolve(ref);
  }

  listConnections(): Promise<SourceConnectionLifecycle[]> {
    return this.dependencies.repository.listCaptureConnectionLifecycles();
  }

  async inspectConnection(connectionId: string): Promise<SourceConnectionLifecycle> {
    return this.requireState(connectionId);
  }

  async create(input: {
    idempotency_key: string;
    package: ExactConnectorPackageRef;
    connection: {
      id: string;
      display_name: string;
      endpoint?: string;
      delivery_kinds: CaptureDeliveryKind[];
      secret_refs: Record<string, unknown>;
      configuration: unknown;
      privacy?: unknown;
    };
  }): Promise<SourceConnectionLifecycleReceipt> {
    const replay = await this.replay(input.idempotency_key, "create", input);
    if (replay) return replay;
    const implementation = await this.load(input.package);
    const configuration = implementation.validateConfiguration(input.connection.configuration);
    const secrets = NamedSecretReferencesSchema.parse(input.connection.secret_refs);
    assertCredentialSlots(implementation.descriptor, secrets);
    assertDeliveryKinds(implementation.descriptor, input.connection.delivery_kinds);
    const connection = SourceConnectionSchema.parse({
      ...input.connection,
      connector_id: implementation.descriptor.manifest.id,
      connector_version: implementation.descriptor.manifest.version,
      connector_package: input.package,
      enabled: false,
      secret_refs: secrets,
      configuration,
      ...(input.connection.privacy ? { privacy: ViewPolicySchema.parse(input.connection.privacy) } : {}),
    });
    await this.dependencies.runtime.registerConnection(connection);
    const state = await this.requireState(connection.id);
    return this.commitReceipt("create", input.idempotency_key, input, state, state);
  }

  async check(input: { connection_id: string; expected_generation: number; idempotency_key: string }): Promise<SourceConnectionLifecycleReceipt> {
    const replay = await this.replay(input.idempotency_key, "check", input);
    if (replay) return replay;
    const state = await this.requireExpected(input.connection_id, input.expected_generation);
    await this.ensureLoaded(state.connection);
    const health = await this.dependencies.runtime.check(state.connection.id);
    if (state.status !== "draft") {
      return this.commitReceipt("check", input.idempotency_key, input, state, { lifecycle: state, health });
    }
    return this.transitionWithReceipt("check", input.idempotency_key, input, state, "checked", state.connection,
      "connection.checked", { health }, next => ({ lifecycle: next, health }));
  }

  async discover(input: {
    connection_id: string;
    expected_generation: number;
    idempotency_key: string;
    parameters?: JsonObject;
  }): Promise<SourceConnectionLifecycleReceipt> {
    const replay = await this.replay(input.idempotency_key, "discover", input);
    if (replay) return replay;
    const state = await this.requireExpected(input.connection_id, input.expected_generation);
    if (state.status === "draft") {
      throw new SourceConnectionOnboardingError(
        "Connection must pass check before discovery",
        "connection_state_conflict",
        { status: state.status },
      );
    }
    const implementation = await this.ensureLoaded(state.connection);
    if (!implementation.discover) {
      throw new SourceConnectionOnboardingError("Connector Package does not declare discovery", "connection_discovery_unsupported", { connection_id: state.connection.id });
    }
    const discovery = await implementation.discover({ connection: state.connection, parameters: input.parameters ?? {} });
    return this.commitReceipt("discover", input.idempotency_key, input, state, { lifecycle: state, discovery }, {
      connection_id: state.connection.id,
      type: "connection.discovered",
      occurred_at: this.now(),
      payload: { item_count: discovery.items.length, has_next_cursor: discovery.next_cursor !== undefined },
    });
  }

  async activate(input: { connection_id: string; expected_generation: number; idempotency_key: string }): Promise<SourceConnectionLifecycleReceipt> {
    const replay = await this.replay(input.idempotency_key, "activate", input);
    if (replay) return replay;
    const state = await this.requireExpected(input.connection_id, input.expected_generation);
    if (state.status !== "checked" && state.status !== "paused") {
      throw new SourceConnectionOnboardingError("Connection must be checked before activation", "connection_state_conflict", { status: state.status });
    }
    const connection = SourceConnectionSchema.parse({ ...state.connection, enabled: true });
    return this.transitionWithReceipt("activate", input.idempotency_key, input, state, "active", connection,
      "connection.activated", {}, next => next);
  }

  async update(input: {
    connection_id: string;
    expected_generation: number;
    idempotency_key: string;
    display_name?: string;
    endpoint?: string;
    delivery_kinds?: CaptureDeliveryKind[];
    secret_refs?: Record<string, unknown>;
    configuration?: unknown;
    privacy?: unknown;
  }): Promise<SourceConnectionLifecycleReceipt> {
    const replay = await this.replay(input.idempotency_key, "update", input);
    if (replay) return replay;
    const state = await this.requireExpected(input.connection_id, input.expected_generation);
    const implementation = await this.ensureLoaded(state.connection);
    const secrets = input.secret_refs === undefined ? state.connection.secret_refs : NamedSecretReferencesSchema.parse(input.secret_refs);
    assertCredentialSlots(implementation.descriptor, secrets);
    const configuration = input.configuration === undefined
      ? state.connection.configuration
      : implementation.validateConfiguration(input.configuration);
    const connection = SourceConnectionSchema.parse({
      ...state.connection,
      ...(input.display_name === undefined ? {} : { display_name: input.display_name }),
      ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
      ...(input.delivery_kinds === undefined ? {} : { delivery_kinds: input.delivery_kinds.map(kind => CaptureDeliveryKindSchema.parse(kind)) }),
      ...(input.privacy === undefined ? {} : { privacy: ViewPolicySchema.parse(input.privacy) }),
      secret_refs: secrets,
      configuration,
      enabled: false,
    });
    assertDeliveryKinds(implementation.descriptor, connection.delivery_kinds);
    return this.transitionWithReceipt("update", input.idempotency_key, input, state, "draft", connection,
      "connection.updated", {}, next => next);
  }

  async pause(input: { connection_id: string; expected_generation: number; idempotency_key: string }): Promise<SourceConnectionLifecycleReceipt> {
    const replay = await this.replay(input.idempotency_key, "pause", input);
    if (replay) return replay;
    const state = await this.requireExpected(input.connection_id, input.expected_generation);
    if (state.status !== "active") throw new SourceConnectionOnboardingError("Only active connections can be paused", "connection_state_conflict", { status: state.status });
    const connection = SourceConnectionSchema.parse({ ...state.connection, enabled: false });
    return this.transitionWithReceipt("pause", input.idempotency_key, input, state, "paused", connection,
      "connection.paused", {}, next => next);
  }

  async run(input: {
    connection_id: string;
    expected_generation: number;
    idempotency_key: string;
    delivery: Extract<CaptureDeliveryKind, "pull" | "stream" | "reference">;
    parameters?: JsonObject;
  }): Promise<SourceConnectionLifecycleReceipt> {
    const replay = await this.replay(input.idempotency_key, "run", input);
    if (replay) return replay;
    const state = await this.requireExpected(input.connection_id, input.expected_generation);
    if (state.status !== "active") throw new SourceConnectionOnboardingError("Connection must be active before run", "connection_state_conflict", { status: state.status });
    await this.ensureLoaded(state.connection);
    const results = await this.dependencies.runtime.run(state.connection.id, input.delivery, input.parameters ?? {});
    return this.commitReceipt("run", input.idempotency_key, input, state, { lifecycle: state, results: summarizeResults(results) });
  }

  private async load(ref: ExactConnectorPackageRef): Promise<ConnectorPackageImplementation> {
    const key = `${ref.id}@${ref.version}+${ref.digest}`;
    const existing = this.loaded.get(key);
    if (existing) return existing;
    const pending = this.loading.get(key);
    if (pending) return pending;
    const loading = this.dependencies.loader.load(ref).then(implementation => {
      this.dependencies.runtime.registerConnector(implementation.connector);
      this.loaded.set(key, implementation);
      return implementation;
    }).finally(() => {
      this.loading.delete(key);
    });
    this.loading.set(key, loading);
    return loading;
  }

  private async ensureLoaded(connection: SourceConnection): Promise<ConnectorPackageImplementation> {
    if (!connection.connector_package) throw new SourceConnectionOnboardingError("Connection has no exact Connector Package", "connection_package_required", { connection_id: connection.id });
    return this.load(connection.connector_package);
  }

  private async requireState(id: string): Promise<SourceConnectionLifecycle> {
    const state = await this.dependencies.repository.getCaptureConnectionLifecycle(id);
    if (!state) throw new SourceConnectionOnboardingError("Source Connection does not exist", "connection_not_found", { connection_id: id });
    return state;
  }

  private async requireExpected(id: string, expected: number): Promise<SourceConnectionLifecycle> {
    const state = await this.requireState(id);
    if (state.generation !== expected) {
      throw new SourceConnectionOnboardingError("Source Connection generation is stale", "connection_generation_conflict", {
        connection_id: id,
        expected_generation: expected,
        actual_generation: state.generation,
      });
    }
    return state;
  }

  private async transitionWithReceipt(
    action: Extract<SourceConnectionLifecycleReceipt["action"], "check" | "activate" | "update" | "pause">,
    key: string,
    request: unknown,
    state: SourceConnectionLifecycle,
    status: SourceConnectionLifecycle["status"],
    connection: SourceConnection,
    type: "connection.checked" | "connection.activated" | "connection.updated" | "connection.paused",
    payload: JsonObject,
    result: (next: SourceConnectionLifecycle) => JsonValue,
  ): Promise<SourceConnectionLifecycleReceipt> {
    const occurredAt = this.now();
    const next = SourceConnectionLifecycleSchema.parse({
      connection,
      generation: state.generation + 1,
      status,
      created_at: state.created_at,
      updated_at: occurredAt,
    });
    const receipt = SourceConnectionLifecycleReceiptSchema.parse({
      idempotency_key: key,
      request_digest: requestDigest(action, request),
      action,
      connection_id: connection.id,
      generation: next.generation,
      committed_at: occurredAt,
      result: result(next),
    });
    try {
      await this.dependencies.repository.updateCaptureConnectionLifecycle({
        connection,
        manifest: this.dependencies.catalog.resolve(connection.connector_package!).manifest,
        expected_generation: state.generation,
        status,
        occurred_at: occurredAt,
        event: { connection_id: connection.id, type, occurred_at: occurredAt, payload },
        receipt,
      });
      return receipt;
    } catch (error) {
      const concurrentReplay = await this.replay(key, action, request);
      if (concurrentReplay) return concurrentReplay;
      throw error;
    }
  }

  private async replay(key: string, action: SourceConnectionLifecycleReceipt["action"], request: unknown): Promise<SourceConnectionLifecycleReceipt | undefined> {
    const existing = await this.dependencies.repository.getCaptureConnectionLifecycleReceipt(key);
    if (!existing) return undefined;
    const digest = requestDigest(action, request);
    if (existing.request_digest !== digest || existing.action !== action) {
      throw new SourceConnectionOnboardingError("Connection lifecycle idempotency key was reused with different input", "connection_idempotency_conflict", { idempotency_key: key });
    }
    return existing;
  }

  private commitReceipt(
    action: SourceConnectionLifecycleReceipt["action"],
    key: string,
    request: unknown,
    state: SourceConnectionLifecycle,
    result: JsonValue,
    event?: import("./contracts.js").CaptureTraceEvent,
  ): Promise<SourceConnectionLifecycleReceipt> {
    return this.dependencies.repository.commitCaptureConnectionLifecycleReceipt({
      receipt: SourceConnectionLifecycleReceiptSchema.parse({
        idempotency_key: key,
        request_digest: requestDigest(action, request),
        action,
        connection_id: state.connection.id,
        generation: state.generation,
        committed_at: this.now(),
        result,
      }),
      ...(event ? { event } : {}),
    });
  }
}

function assertCredentialSlots(descriptor: ConnectorPackageDescriptor, refs: SourceConnection["secret_refs"]): void {
  const slots = new Map(descriptor.credential_slots.map(slot => [slot.name, slot]));
  const unknown = Object.keys(refs).filter(name => !slots.has(name));
  if (unknown.length > 0) throw new SourceConnectionOnboardingError("Source Connection contains undeclared secret slots", "connection_secret_slot_unknown", { slots: unknown });
  const missing = descriptor.credential_slots.filter(slot => slot.required && refs[slot.name] === undefined).map(slot => slot.name);
  if (missing.length > 0) throw new SourceConnectionOnboardingError("Source Connection is missing required secret slots", "connection_secret_slot_missing", { slots: missing });
  for (const [name, ref] of Object.entries(refs)) {
    const slot = slots.get(name)!;
    if (!slot.accepted_providers.includes(ref.provider)) {
      throw new SourceConnectionOnboardingError("SecretReference provider is not allowed for its slot", "connection_secret_provider_denied", { slot: name, provider: ref.provider });
    }
  }
}

function assertDeliveryKinds(descriptor: ConnectorPackageDescriptor, kinds: readonly CaptureDeliveryKind[]): void {
  const unsupported = kinds.filter(kind => !descriptor.manifest.delivery_kinds.includes(kind));
  if (unsupported.length > 0) {
    throw new SourceConnectionOnboardingError(
      "Source Connection requests delivery kinds outside its Connector Package",
      "connection_delivery_unsupported",
      { delivery_kinds: unsupported },
    );
  }
}

function requestDigest(action: string, input: unknown): string {
  return createHash("sha256").update(canonicalJson({ action, input })).digest("hex");
}

function summarizeResults(results: CommitCaptureBatchResult[]): JsonValue {
  return results.map(result => ({
    transaction_id: result.transaction_id,
    replayed: result.replayed,
    checkpoint: result.checkpoint,
    receipts: result.receipts,
  }));
}

export function connectorPackageFailure(error: unknown): ConnectorPackageError | SourceConnectionOnboardingError | CaptureRuntimeError | undefined {
  return error instanceof ConnectorPackageError || error instanceof SourceConnectionOnboardingError || error instanceof CaptureRuntimeError ? error : undefined;
}
