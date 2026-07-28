import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CaptureIngress,
  ConnectorPackageCatalog,
  ConnectorPackageDescriptorSchema,
  ConnectorPackageError,
  ConnectorRuntime,
  SourceConnectionOnboardingError,
  SourceConnectionOnboardingService,
  TrustedConnectorPackageLoader,
  connectorPackageRef,
  connectorPackageSignaturePayload,
  runConnectorConformanceV2,
  type ConnectorPackageArtifact,
  type ConnectorPackageDescriptor,
} from "@info/capture";
import {
  NOTION_CONNECTOR_KIT,
  NotionCaptureConnector,
  notionConnectorPackageImplementation,
  notionSourceConnection,
} from "@info/notion-capture-adapter";
import {
  SCREENPIPE_CONNECTOR_MANIFEST,
  screenpipeSourceConnection,
} from "@info/screenpipe-capture-adapter";
import { SqliteViewRepository } from "@info/storage-sqlite";
import { ViewRepositoryError } from "@info/view";

const NOW = "2026-07-27T12:00:00.000Z";
const PAGE_ID = "11111111-1111-4111-8111-111111111111";

function signedFixture(input: {
  abi_version?: number;
  permissions?: Array<{ kind: "network"; scope: string }>;
  artifact_bytes?: Buffer;
} = {}) {
  const keys = generateKeyPairSync("ed25519");
  const bytes = input.artifact_bytes ?? Buffer.from("@info/notion-capture-adapter@fixture-v1");
  const unsigned = ConnectorPackageDescriptorSchema.parse({
    descriptor_version: 1,
    id: "notion",
    version: "1.0.0",
    manifest: NOTION_CONNECTOR_KIT.manifest,
    artifact: {
      package_name: "@info/notion-capture-adapter",
      export_name: "notionConnectorPackageImplementation",
      digest: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") },
    },
    runtime: { abi: "metaflow.connector-port", abi_version: input.abi_version ?? 1 },
    publisher: { id: "publisher:metaflow", key_id: "key:notion-fixture" },
    permissions: input.permissions ?? [{ kind: "network", scope: "https://api.notion.com" }],
    credential_slots: [{
      name: "notion_token",
      required: true,
      description: "Notion integration token",
      accepted_providers: ["env", "keychain"],
    }],
    configuration_schema: {
      type: "object",
      properties: {
        page_size: { type: "integer", minimum: 1, maximum: 100 },
        max_pages_per_run: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    conformance: {
      version: 2,
      report_digest: "a".repeat(64),
      verified_at: NOW,
      capabilities: { push: false, pull: true, stream: false, reference: true, incremental: true },
    },
  });
  const descriptor = ConnectorPackageDescriptorSchema.parse({
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      value: sign(null, connectorPackageSignaturePayload(unsigned), keys.privateKey).toString("base64"),
    },
  });
  return { descriptor, bytes, publicKey: keys.publicKey.export({ type: "spki", format: "pem" }) };
}

function fakeNotionClient() {
  return {
    users: { async me() { return { object: "user", type: "bot", id: "bot:fixture" }; } },
    async search() {
      return {
        object: "list",
        type: "page_or_data_source",
        page_or_data_source: {},
        has_more: false,
        next_cursor: null,
        request_id: "request:notion-fixture",
        results: [notionPageObject()],
      } as any;
    },
  };
}

function notionPageObject() {
  return {
    object: "page",
    id: PAGE_ID,
    created_time: "2026-07-27T10:00:00.000Z",
    last_edited_time: "2026-07-27T11:00:00.000Z",
    archived: false,
    in_trash: false,
    url: `https://www.notion.so/${PAGE_ID.replaceAll("-", "")}`,
    public_url: null,
    parent: { type: "workspace", workspace: true },
    icon: null,
    cover: {
      type: "external",
      external: { url: "https://images.example/notion-large-cover.png" },
    },
    properties: {
      Name: {
        id: "title",
        type: "title",
        title: [{ type: "text", plain_text: "English learning notes", href: null, annotations: {}, text: { content: "English learning notes", link: null } }],
      },
    },
  };
}

function harness(
  fixture = signedFixture(),
  options: { database_path?: string; client_factory?: () => ReturnType<typeof fakeNotionClient> } = {},
) {
  const repository = new SqliteViewRepository(options.database_path ?? ":memory:");
  const runtime = new ConnectorRuntime(repository, new CaptureIngress({ repository, now: () => NOW }), { now: () => NOW });
  const implementation = notionConnectorPackageImplementation({
    descriptor: fixture.descriptor,
    secret_resolver: { async resolve() { return "secret-from-reference"; } },
    client_factory: options.client_factory ?? (() => fakeNotionClient()),
    now: () => NOW,
  });
  const artifact: ConnectorPackageArtifact = { descriptor: fixture.descriptor, bytes: fixture.bytes };
  const catalog = new ConnectorPackageCatalog();
  catalog.register(fixture.descriptor);
  const loader = new TrustedConnectorPackageLoader({
    catalog,
    artifacts: {
      async inspect() { return artifact; },
      async instantiate() { return implementation; },
    },
    publisher_keys: { async publicKey() { return fixture.publicKey; } },
    allowed_permissions: [{ kind: "network", scope: "https://api.notion.com" }],
    supported_abi_version: 1,
  });
  return {
    repository,
    runtime,
    catalog,
    loader,
    implementation,
    service: new SourceConnectionOnboardingService({ catalog, loader, runtime, repository, now: () => NOW }),
    ref: connectorPackageRef(fixture.descriptor),
  };
}

test("Connector Package trust boundary rejects unknown, ambiguous, unsigned, incompatible, over-privileged, and altered artifacts", async () => {
  const fixture = signedFixture();
  const catalog = new ConnectorPackageCatalog();
  assert.throws(() => catalog.resolve(connectorPackageRef(fixture.descriptor)), hasCode("unknown_connector_package"));
  catalog.register(fixture.descriptor);
  const alternative = signedFixture({ artifact_bytes: Buffer.from("alternative-notion-artifact") });
  catalog.register(alternative.descriptor);
  assert.throws(() => catalog.resolveVersion("notion", "1.0.0"), hasCode("ambiguous_connector_package"));

  const unsignedCatalog = new ConnectorPackageCatalog();
  const unsigned = ConnectorPackageDescriptorSchema.parse({ ...fixture.descriptor, signature: undefined });
  unsignedCatalog.register(unsigned);
  let unsignedInstantiated = false;
  await assert.rejects(new TrustedConnectorPackageLoader({
    catalog: unsignedCatalog,
    artifacts: {
      async inspect() { return undefined; },
      async instantiate() { unsignedInstantiated = true; throw new Error("unsigned package must not instantiate"); },
    },
    publisher_keys: { async publicKey() { return fixture.publicKey; } },
    allowed_permissions: [{ kind: "network", scope: "https://api.notion.com" }],
    supported_abi_version: 1,
  }).load(connectorPackageRef(unsigned)), hasCode("unsigned_connector_package"));
  assert.equal(unsignedInstantiated, false);

  const incompatible = harness(signedFixture({ abi_version: 2 }));
  await assert.rejects(incompatible.loader.load(incompatible.ref), hasCode("connector_abi_incompatible"));
  incompatible.repository.close();

  const privilegedFixture = signedFixture({ permissions: [{ kind: "network", scope: "https://evil.example" }] });
  const privileged = harness(privilegedFixture);
  await assert.rejects(privileged.loader.load(privileged.ref), hasCode("connector_permission_denied"));
  privileged.repository.close();

  const altered = harness();
  let alteredInstantiated = false;
  const badLoader = new TrustedConnectorPackageLoader({
    catalog: altered.catalog,
    artifacts: {
      async inspect() { return { descriptor: altered.implementation.descriptor, bytes: Buffer.from("altered") }; },
      async instantiate() { alteredInstantiated = true; return altered.implementation; },
    },
    publisher_keys: { async publicKey() { return fixture.publicKey; } },
    allowed_permissions: [{ kind: "network", scope: "https://api.notion.com" }],
    supported_abi_version: 1,
  });
  await assert.rejects(badLoader.load(altered.ref), hasCode("connector_artifact_mismatch"));
  assert.equal(alteredInstantiated, false);
  altered.repository.close();

  let untrustedInstantiated = false;
  await assert.rejects(new TrustedConnectorPackageLoader({
    catalog,
    artifacts: {
      async inspect() { return { descriptor: fixture.descriptor, bytes: fixture.bytes }; },
      async instantiate() { untrustedInstantiated = true; throw new Error("untrusted package must not instantiate"); },
    },
    publisher_keys: { async publicKey() { return "not-a-public-key"; } },
    allowed_permissions: [{ kind: "network", scope: "https://api.notion.com" }],
    supported_abi_version: 1,
  }).load(connectorPackageRef(fixture.descriptor)), hasCode("untrusted_connector_package"));
  assert.equal(untrustedInstantiated, false);
});

test("Source Connection onboarding is CAS-versioned, observable, idempotent, and delegates run to Capture Runtime", async () => {
  const h = harness();
  try {
    assert.equal(h.service.listPackages().length, 1);
    assert.deepEqual(h.service.inspectPackage(h.ref).artifact.digest.value, h.ref.digest);
    const createInput = {
      idempotency_key: "onboard:notion:create",
      package: h.ref,
      connection: {
        id: "connection:notion",
        display_name: "Notion learning workspace",
        delivery_kinds: ["pull" as const, "reference" as const],
        secret_refs: { notion_token: { provider: "env" as const, key: "NOTION_TOKEN" } },
        configuration: { page_size: 25, max_pages_per_run: 2 },
      },
    };
    const created = await h.service.create(createInput);
    assert.equal(created.generation, 1);
    assert.equal((await h.service.listConnections())[0]?.status, "draft");
    assert.deepEqual(await h.service.create(createInput), created);
    await assert.rejects(
      h.service.create({ ...createInput, connection: { ...createInput.connection, display_name: "Changed" } }),
      hasCode("connection_idempotency_conflict"),
    );
    await assert.rejects(h.service.create({
      ...createInput,
      idempotency_key: "onboard:notion:missing-secret",
      connection: { ...createInput.connection, id: "connection:notion:missing-secret", secret_refs: {} },
    }), hasCode("connection_secret_slot_missing"));
    await assert.rejects(h.service.create({
      ...createInput,
      idempotency_key: "onboard:notion:unknown-secret",
      connection: {
        ...createInput.connection,
        id: "connection:notion:unknown-secret",
        secret_refs: {
          ...createInput.connection.secret_refs,
          extra_token: { provider: "env" as const, key: "EXTRA_TOKEN" },
        },
      },
    }), hasCode("connection_secret_slot_unknown"));

    const beforeRollback = await h.service.inspectConnection("connection:notion");
    const traceBeforeRollback = await h.repository.getCaptureTrace("connection:notion");
    await assert.rejects(h.repository.updateCaptureConnectionLifecycle({
      connection: { ...beforeRollback.connection, enabled: true },
      manifest: h.implementation.descriptor.manifest,
      expected_generation: beforeRollback.generation,
      status: "active",
      occurred_at: NOW,
      event: {
        connection_id: "connection:notion",
        type: "connection.activated",
        occurred_at: NOW,
        payload: { injected_failure: true },
      },
      receipt: {
        idempotency_key: createInput.idempotency_key,
        request_digest: "b".repeat(64),
        action: "activate",
        connection_id: "connection:notion",
        generation: 2,
        committed_at: NOW,
        result: {},
      },
    }));
    assert.deepEqual(await h.service.inspectConnection("connection:notion"), beforeRollback);
    assert.deepEqual(await h.repository.getCaptureTrace("connection:notion"), traceBeforeRollback);
    await assert.rejects(h.service.discover({
      connection_id: "connection:notion",
      expected_generation: 1,
      idempotency_key: "onboard:notion:discover-before-check",
    }), hasCode("connection_state_conflict"));
    const checkInput = { connection_id: "connection:notion", expected_generation: 1, idempotency_key: "onboard:notion:check" };
    const [checked, concurrentChecked] = await Promise.all([
      h.service.check(checkInput),
      h.service.check(checkInput),
    ]);
    assert.deepEqual(concurrentChecked, checked);
    assert.equal(checked.generation, 2);
    assert.equal((await h.service.listConnections())[0]?.status, "checked");
    await assert.rejects(
      h.service.check({ connection_id: "connection:notion", expected_generation: 1, idempotency_key: "onboard:notion:stale" }),
      hasCode("connection_generation_conflict"),
    );

    const beforeDiscovery = await h.repository.getCaptureCheckpoint("connection:notion");
    const discovered = await h.service.discover({
      connection_id: "connection:notion",
      expected_generation: 2,
      idempotency_key: "onboard:notion:discover",
      parameters: { limit: 5 },
    });
    assert.equal(discovered.generation, 2);
    assert.deepEqual(await h.repository.getCaptureCheckpoint("connection:notion"), beforeDiscovery);
    assert.equal((await h.repository.query({ role: "raw", revisions: "all", limit: 10 })).length, 0);

    const activated = await h.service.activate({ connection_id: "connection:notion", expected_generation: 2, idempotency_key: "onboard:notion:activate" });
    assert.equal(activated.generation, 3);
    const runInput = {
      connection_id: "connection:notion",
      expected_generation: 3,
      idempotency_key: "onboard:notion:run",
      delivery: "pull" as const,
      parameters: {},
    };
    const run = await h.service.run(runInput);
    assert.equal(run.generation, 3);
    assert.deepEqual(await h.service.run(runInput), run);
    const views = await h.repository.query({ schema_name: "capture.notion.object", revisions: "all", limit: 10 });
    assert.equal(views.length, 1);
    assert.equal(views[0]?.name, "English learning notes");
    assert.match(JSON.stringify(views[0]?.representation), /https:\/\/images\.example\/notion-large-cover\.png/);
    assert.doesNotMatch(JSON.stringify(views[0]), /secret-from-reference|NOTION_TOKEN/);
    assert.equal((await h.repository.getCaptureCheckpoint("connection:notion"))?.revision, 1);

    const paused = await h.service.pause({ connection_id: "connection:notion", expected_generation: 3, idempotency_key: "onboard:notion:pause" });
    assert.equal(paused.generation, 4);
    assert.equal((await h.service.listConnections())[0]?.status, "paused");
    const reactivated = await h.service.activate({ connection_id: "connection:notion", expected_generation: 4, idempotency_key: "onboard:notion:reactivate" });
    assert.equal(reactivated.generation, 5);
    await assert.rejects(h.service.update({
      connection_id: "connection:notion",
      expected_generation: 5,
      idempotency_key: "onboard:notion:unsupported-delivery",
      delivery_kinds: ["stream"],
    }), hasCode("connection_delivery_unsupported"));
    const updated = await h.service.update({
      connection_id: "connection:notion",
      expected_generation: 5,
      idempotency_key: "onboard:notion:update",
      display_name: "Updated Notion workspace",
      configuration: { page_size: 10, max_pages_per_run: 1 },
    });
    assert.equal(updated.generation, 6);
    assert.equal((await h.service.listConnections())[0]?.status, "draft");
    assert.equal((await h.service.listConnections())[0]?.connection.display_name, "Updated Notion workspace");
    const trace = await h.repository.getCaptureTrace("connection:notion");
    assert.ok(trace.some(event => event.type === "connection.checked"));
    assert.ok(trace.some(event => event.type === "connection.activated"));
    assert.ok(trace.some(event => event.type === "capture.batch_committed"));
  } finally {
    h.repository.close();
  }
});

test("Notion rejects partial or malformed source objects and binds page idempotency to every result", async () => {
  const connection = notionSourceConnection({
    secret_ref: { provider: "env", key: "NOTION_TOKEN" },
    configuration: { page_size: 25, max_pages_per_run: 1 },
  });
  const request = {
    delivery: "pull" as const,
    checkpoint: { connection_id: connection.id, revision: 0, cursor: {}, updated_at: NOW },
    parameters: {},
  };
  const partial = new NotionCaptureConnector({
    secret_resolver: { async resolve() { return "secret-from-reference"; } },
    client_factory: () => ({
      users: { async me() { return { object: "user", type: "bot" }; } },
      async search() {
        return { object: "list", type: "page_or_data_source", page_or_data_source: {}, has_more: false, next_cursor: null, results: [{ object: "page", id: PAGE_ID }] } as any;
      },
    }),
  });
  await assert.rejects(collect(partial.open(connection, request, {})), hasCode("connector_protocol_error"));

  const malformed = new NotionCaptureConnector({
    secret_resolver: { async resolve() { return "secret-from-reference"; } },
    client_factory: () => ({
      users: { async me() { return { object: "user", type: "bot" }; } },
      async search() {
        return {
          object: "list", type: "page_or_data_source", page_or_data_source: {}, has_more: false, next_cursor: null,
          results: [{ ...notionPageObject(), id: "not-a-uuid" }],
        } as any;
      },
    }),
  });
  await assert.rejects(collect(malformed.open(connection, request, {})), hasCode("connector_protocol_error"));

  const second = { ...notionPageObject(), id: "22222222-2222-4222-8222-222222222222" };
  const firstBatch = await notionBatchFor([notionPageObject(), second], connection, request);
  const changedBatch = await notionBatchFor([
    notionPageObject(),
    { ...second, last_edited_time: "2026-07-27T11:30:00.000Z" },
  ], connection, request);
  assert.equal(firstBatch.candidates.length, 2);
  assert.notEqual(changedBatch.idempotency_key, firstBatch.idempotency_key);

  let requestCount = 0;
  const afterEmptyPage = new NotionCaptureConnector({
    secret_resolver: { async resolve() { return "secret-from-reference"; } },
    client_factory: () => ({
      users: { async me() { return { object: "user", type: "bot" }; } },
      async search() {
        requestCount += 1;
        return requestCount === 1
          ? { object: "list", type: "page_or_data_source", page_or_data_source: {}, has_more: true, next_cursor: "cursor:empty", results: [] } as any
          : { object: "list", type: "page_or_data_source", page_or_data_source: {}, has_more: false, next_cursor: null, results: [notionPageObject()] } as any;
      },
    }),
    now: () => NOW,
  });
  const emptyPageConnection = notionSourceConnection({
    secret_ref: { provider: "env", key: "NOTION_TOKEN" },
    configuration: { page_size: 25, max_pages_per_run: 2 },
  });
  const afterEmptyBatches = await collect(afterEmptyPage.open(emptyPageConnection, {
    ...request,
    checkpoint: { ...request.checkpoint, connection_id: emptyPageConnection.id },
  }, {}));
  assert.equal(afterEmptyBatches.length, 1);
  assert.equal(afterEmptyBatches[0]?.sequence, 1);
  assert.deepEqual(afterEmptyBatches[0]?.checkpoint, {
    expected_revision: 0,
    previous: {},
    next: { notion: { exhausted: true } },
  });
});

test("migration losslessly names empty legacy secrets and rejects non-empty arrays with connection context", async () => {
  const empty = await legacyConnectionDatabase([]);
  let migrated: SqliteViewRepository | undefined;
  try {
    migrated = new SqliteViewRepository(empty.path);
    assert.deepEqual((await migrated.getCaptureConnectionLifecycle("connection:notion"))?.connection.secret_refs, {});
  } finally {
    migrated?.close();
    rmSync(empty.directory, { recursive: true, force: true });
  }

  const unsafe = await legacyConnectionDatabase([{ provider: "env", key: "NOTION_TOKEN" }]);
  try {
    assert.throws(
      () => new SqliteViewRepository(unsafe.path),
      (error: unknown) => error instanceof ViewRepositoryError
        && error.code === "corrupt_data"
        && error.details.phase === "migrate_connector_onboarding"
        && error.details.table === "capture_connections_v1"
        && error.details.connection_id === "connection:notion"
        && Boolean(error.details.transaction_id),
    );
  } finally {
    rmSync(unsafe.directory, { recursive: true, force: true });
  }
});

test("migration names one legacy Screenpipe bearer reference only when manifest and configuration prove the slot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-screenpipe-secret-migration-"));
  const path = join(directory, "views.sqlite");
  const secretRef = { provider: "custom" as const, key: "screenpipe-local-api" };
  const repository = new SqliteViewRepository(path);
  try {
    await repository.registerCaptureConnection({
      connection: screenpipeSourceConnection({
        id: "screenpipe:legacy-migration",
        secret_refs: { screenpipe_api_key: secretRef },
        authentication: "bearer",
      }),
      manifest: SCREENPIPE_CONNECTOR_MANIFEST,
      occurred_at: NOW,
    });
  } finally {
    repository.close();
  }
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare("select connection_json from capture_connections_v1 where connection_id = ?")
      .get("screenpipe:legacy-migration") as { connection_json: string };
    const connection = JSON.parse(row.connection_json) as Record<string, unknown>;
    connection.secret_refs = [secretRef];
    db.prepare("update capture_connections_v1 set connection_json = ? where connection_id = ?")
      .run(JSON.stringify(connection), "screenpipe:legacy-migration");
    db.prepare("update view_store_schema_versions_v1 set version = 6 where component = 'view-store'").run();
  } finally {
    db.close();
  }
  let migrated: SqliteViewRepository | undefined;
  try {
    migrated = new SqliteViewRepository(path);
    assert.deepEqual(
      (await migrated.getCaptureConnectionLifecycle("screenpipe:legacy-migration"))?.connection.secret_refs,
      { screenpipe_api_key: secretRef },
    );
  } finally {
    migrated?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Connector conformance v2 requires evidence for every declared delivery and incremental capability", async () => {
  const h = harness();
  try {
    const connection = NOTION_CONNECTOR_KIT.createConnection({
      id: "connection:notion-conformance",
      display_name: "Notion conformance",
      enabled: true,
      delivery_kinds: ["pull", "reference"],
      secret_refs: { notion_token: { provider: "env", key: "NOTION_TOKEN" } },
      configuration: {},
    });
    await assert.rejects(runConnectorConformanceV2({
      kit: NOTION_CONNECTOR_KIT,
      connection,
      cases: [{
        name: "page",
        payload: { object: notionPageObject() },
        captured_at: NOW,
        expected_candidate_count: 1,
        expected_schemas: ["capture.notion.object@1"],
        assert_lossless() {},
      }],
      malformed_payloads: [{}],
      async submit() { return { replay: true }; },
      replay_identity: value => value,
      probes: {},
    }), hasCode("declared_capability_unproved"));

    const report = await runConnectorConformanceV2({
      kit: NOTION_CONNECTOR_KIT,
      connection,
      cases: [{
        name: "page",
        payload: { object: notionPageObject() },
        captured_at: NOW,
        expected_candidate_count: 1,
        expected_schemas: ["capture.notion.object@1"],
        assert_lossless({ payload, candidates }) {
          assert.equal((candidates[0]?.representation.form === "inline" && candidates[0].representation.value as any).id, payload.object.id);
        },
      }],
      malformed_payloads: [{}],
      async submit() { return { replay: true }; },
      replay_identity: value => value,
      probes: {
        pull: async () => ({ verified: true }),
        reference: async () => ({ verified: true }),
        incremental: async () => ({ checkpoint: true }),
      },
    });
    assert.equal(report.version, 2);
    assert.equal(report.capabilities.incremental.declared, true);
  } finally {
    h.repository.close();
  }
});

function hasCode(code: string) {
  return (error: unknown) => (error instanceof ConnectorPackageError || error instanceof SourceConnectionOnboardingError || error instanceof Error)
    && "code" in error && error.code === code;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

async function notionBatchFor(
  results: ReturnType<typeof notionPageObject>[],
  connection: ReturnType<typeof notionSourceConnection>,
  request: Parameters<NotionCaptureConnector["open"]>[1],
) {
  const connector = new NotionCaptureConnector({
    secret_resolver: { async resolve() { return "secret-from-reference"; } },
    client_factory: () => ({
      users: { async me() { return { object: "user", type: "bot" }; } },
      async search() {
        return { object: "list", type: "page_or_data_source", page_or_data_source: {}, has_more: false, next_cursor: null, results } as any;
      },
    }),
    now: () => NOW,
  });
  const batches = await collect(connector.open(connection, request, {}));
  assert.equal(batches.length, 1);
  return batches[0]!;
}

async function legacyConnectionDatabase(secretRefs: unknown[]) {
  const directory = mkdtempSync(join(tmpdir(), "metaflow-connector-onboarding-"));
  const path = join(directory, "views.sqlite");
  const h = harness(signedFixture(), { database_path: path });
  try {
    await h.service.create({
      idempotency_key: "onboard:notion:create",
      package: h.ref,
      connection: {
        id: "connection:notion",
        display_name: "Legacy Notion connection",
        delivery_kinds: ["pull", "reference"],
        secret_refs: { notion_token: { provider: "env", key: "NOTION_TOKEN" } },
        configuration: {},
      },
    });
  } finally {
    h.repository.close();
  }
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare("select connection_json from capture_connections_v1 where connection_id = ?")
      .get("connection:notion") as { connection_json: string };
    const connection = JSON.parse(row.connection_json) as Record<string, unknown>;
    connection.secret_refs = secretRefs;
    db.prepare("update capture_connections_v1 set connection_json = ? where connection_id = ?")
      .run(JSON.stringify(connection), "connection:notion");
    db.prepare("update view_store_schema_versions_v1 set version = 6 where component = 'view-store'").run();
  } finally {
    db.close();
  }
  return { directory, path };
}
