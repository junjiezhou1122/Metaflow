import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AuthorizedAssetRequestSchema,
  MAX_WEB_RENDERER_ASSET_BYTES,
  ResolvedAssetSchema,
  RendererLifecycleEventSchema,
  WebRendererInputSchema,
  type RendererHostServices,
  type RendererLifecycleEvent,
  type WebRendererDescriptor,
  type WebRendererFactoryV1,
  type WebRendererHostV1,
  type WebRendererInput,
} from "./contracts.js";
import { WebRendererError } from "./errors.js";
import { WebRendererRegistry } from "./registry.js";
import { renderJsonView } from "./renderers/json.js";
import { openMarkdownLink, renderMarkdownView } from "./renderers/markdown.js";
import { parseSchemaDrivenTable, renderTableView } from "./renderers/table.js";

const exactDescriptor: WebRendererDescriptor = {
  id: "renderer.fixture",
  version: 1,
  abi_version: 1,
  schema: { name: "fixture.document", version: 1 },
  surfaces: ["web"],
  representation_kinds: ["document"],
  media_types: ["application/json"],
  priority: 100,
};

test("registry deterministically selects and lazily caches an exact id@version@abi implementation", async () => {
  const events: RendererLifecycleEvent[] = [];
  let loads = 0;
  let mounts = 0;
  let disposals = 0;
  const factory: WebRendererFactoryV1 = {
    async mount() {
      mounts += 1;
      return { dispose: () => { disposals += 1; } };
    },
  };
  const registry = new WebRendererRegistry([{
    descriptor: { id: exactDescriptor.id, version: 1, abi_version: 1 },
    async load() {
      loads += 1;
      return factory;
    },
  }]);
  assert.equal(registry.select([
    exactDescriptor,
    { ...exactDescriptor, id: "renderer.a" },
  ], rendererInput()).id, "renderer.a");
  const request = mountRequest(events, [
    { ...exactDescriptor, id: "renderer.z", priority: 1 },
    exactDescriptor,
    { ...exactDescriptor, id: "renderer.a", priority: 99 },
  ]);

  const first = await registry.mount(request);
  assert.equal(first.descriptor.id, "renderer.fixture");
  await first.dispose();
  const second = await registry.mount(request);
  await second.dispose();

  assert.equal(loads, 1);
  assert.equal(mounts, 2);
  assert.equal(disposals, 2);
  assert.deepEqual(events.map(event => event.event), [
    "renderer.load.started", "renderer.load.succeeded", "renderer.mount.started", "renderer.ready",
    "renderer.dispose.started", "renderer.dispose.succeeded",
    "renderer.load.started", "renderer.load.succeeded", "renderer.mount.started", "renderer.ready",
    "renderer.dispose.started", "renderer.dispose.succeeded",
  ]);
  events.forEach(event => RendererLifecycleEventSchema.parse(event));
});

test("zero match, missing registration, ABI mismatch, load, mount, abort, and dispose remain distinct", async (context) => {
  await context.test("zero match", async () => {
    const registry = new WebRendererRegistry();
    await assertRendererError(registry.mount(mountRequest([], [{ ...exactDescriptor, representation_kinds: ["other"] }])), "no_matching_renderer");
  });
  await context.test("missing registration", async () => {
    const registry = new WebRendererRegistry();
    await assertRendererError(registry.mount(mountRequest([], [exactDescriptor])), "missing_registration");
  });
  await context.test("ABI mismatch", async () => {
    const registry = new WebRendererRegistry([{
      descriptor: { id: exactDescriptor.id, version: 1, abi_version: 2 },
      load: async () => fixtureFactory(),
    }]);
    await assertRendererError(registry.mount(mountRequest([], [exactDescriptor])), "abi_mismatch");
  });
  await context.test("unsupported exact ABI", async () => {
    let loads = 0;
    const registry = new WebRendererRegistry([{
      descriptor: { id: exactDescriptor.id, version: 1, abi_version: 2 },
      load: async () => {
        loads += 1;
        return fixtureFactory();
      },
    }]);
    await assertRendererError(registry.mount(mountRequest([], [{ ...exactDescriptor, abi_version: 2 }])), "abi_mismatch");
    assert.equal(loads, 0);
  });
  await context.test("load failure", async () => {
    const registry = new WebRendererRegistry([{
      descriptor: { id: exactDescriptor.id, version: 1, abi_version: 1 },
      load: async () => { throw new Error("synthetic load failure"); },
    }]);
    await assertRendererError(registry.mount(mountRequest([], [exactDescriptor])), "load_failed");
  });
  await context.test("mount failure", async () => {
    const registry = new WebRendererRegistry([{
      descriptor: { id: exactDescriptor.id, version: 1, abi_version: 1 },
      load: async () => ({ mount: async () => { throw new Error("synthetic mount failure"); } }),
    }]);
    await assertRendererError(registry.mount(mountRequest([], [exactDescriptor])), "mount_failed");
  });
  await context.test("abort", async () => {
    const registry = new WebRendererRegistry([{
      descriptor: { id: exactDescriptor.id, version: 1, abi_version: 1 },
      load: async () => fixtureFactory(),
    }]);
    const request = mountRequest([], [exactDescriptor]);
    const controller = new AbortController();
    controller.abort();
    await assertRendererError(registry.mount({ ...request, signal: controller.signal }), "aborted");
  });
  await context.test("dispose failure", async () => {
    const registry = new WebRendererRegistry([{
      descriptor: { id: exactDescriptor.id, version: 1, abi_version: 1 },
      load: async () => fixtureFactory(() => { throw new Error("synthetic dispose failure"); }),
    }]);
    const mounted = await registry.mount(mountRequest([], [exactDescriptor]));
    const disposeResult = mounted.dispose();
    const disposedResult = assertRendererError(mounted.disposed, "dispose_failed");
    await assertRendererError(disposeResult, "dispose_failed");
    await disposedResult;
  });
});

test("active abort disposes the frozen renderer without remounting", async () => {
  let disposals = 0;
  const events: RendererLifecycleEvent[] = [];
  const registry = new WebRendererRegistry([{
    descriptor: { id: exactDescriptor.id, version: 1, abi_version: 1 },
    load: async () => fixtureFactory(() => { disposals += 1; }),
  }]);
  const controller = new AbortController();
  const mounted = await registry.mount({ ...mountRequest(events, [exactDescriptor]), signal: controller.signal });
  controller.abort();
  await mounted.disposed;
  assert.equal(disposals, 1);
  assert.equal(events.filter(event => event.event === "renderer.aborted").length, 1);
  assert.equal(events.at(-1)?.event, "renderer.dispose.succeeded");
});

test("lifecycle observer failures never bypass renderer cleanup", async (context) => {
  await context.test("ready", async () => {
    let disposals = 0;
    const events: RendererLifecycleEvent[] = [];
    const registry = registryFor(fixtureFactory(() => { disposals += 1; }));
    const request = mountRequest(events, [exactDescriptor]);
    await assertRendererError(registry.mount({
      ...request,
      services: createServices(events, {
        emit(event) {
          events.push(event);
          if (event.event === "renderer.ready") throw new Error("synthetic ready observer failure");
        },
      }),
    }), "mount_failed");
    assert.equal(disposals, 1);
    assert.deepEqual(events.slice(-2).map(event => event.event), ["renderer.dispose.started", "renderer.dispose.succeeded"]);
  });

  await context.test("abort", async () => {
    let disposals = 0;
    const events: RendererLifecycleEvent[] = [];
    const controller = new AbortController();
    const registry = registryFor(fixtureFactory(() => { disposals += 1; }));
    const request = mountRequest(events, [exactDescriptor]);
    const mounted = await registry.mount({
      ...request,
      signal: controller.signal,
      services: createServices(events, {
        emit(event) {
          events.push(event);
          if (event.event === "renderer.aborted") throw new Error("synthetic abort observer failure");
        },
      }),
    });
    controller.abort();
    await assertRendererError(mounted.disposed, "dispose_failed");
    assert.equal(disposals, 1);
    assert.deepEqual(events.slice(-2).map(event => event.event), ["renderer.dispose.started", "renderer.dispose.succeeded"]);
  });

  await context.test("dispose", async () => {
    let disposals = 0;
    const events: RendererLifecycleEvent[] = [];
    const registry = registryFor(fixtureFactory(() => { disposals += 1; }));
    const request = mountRequest(events, [exactDescriptor]);
    const mounted = await registry.mount({
      ...request,
      services: createServices(events, {
        emit(event) {
          events.push(event);
          if (event.event === "renderer.dispose.started") throw new Error("synthetic dispose observer failure");
        },
      }),
    });
    const disposeResult = mounted.dispose();
    const disposedResult = assertRendererError(mounted.disposed, "dispose_failed");
    await assertRendererError(disposeResult, "dispose_failed");
    await disposedResult;
    assert.equal(disposals, 1);
    assert.equal(events.at(-1)?.event, "renderer.dispose.succeeded");
  });
});

test("mount abort wins promptly and a late disposable is still cleaned", async () => {
  let resolveMount!: (disposable: { dispose(): void }) => void;
  let markMountStarted!: () => void;
  let markDisposed!: () => void;
  const mountStarted = new Promise<void>(resolve => { markMountStarted = resolve; });
  const disposed = new Promise<void>(resolve => { markDisposed = resolve; });
  const factory: WebRendererFactoryV1 = {
    mount: async () => {
      markMountStarted();
      return new Promise(resolve => { resolveMount = resolve; });
    },
  };
  const registry = registryFor(factory);
  const controller = new AbortController();
  const request = registry.mount({ ...mountRequest([], [exactDescriptor]), signal: controller.signal });
  await mountStarted;
  controller.abort();
  await assertRendererError(request, "aborted");

  resolveMount({ dispose: markDisposed });
  await disposed;
});

test("host exposes only authorized assets, declared Methods, and safe links", async () => {
  const events: RendererLifecycleEvent[] = [];
  const calls: string[] = [];
  let released = 0;
  const factory: WebRendererFactoryV1 = {
    async mount(_container, _input, host, signal) {
      await assert.rejects(
        host.resolveAsset({
          contract_version: 1,
          asset_id: "asset.undeclared",
          accepted_media_types: ["image/png"],
          max_bytes: 100,
        }, signal),
        (error: unknown) => error instanceof WebRendererError && error.code === "asset_not_authorized",
      );
      const asset = await host.resolveAsset({
        contract_version: 1,
        asset_id: "asset.image",
        accepted_media_types: ["image/png"],
        max_bytes: 100,
      }, signal);
      assert.equal(asset.object_url, "blob:fixture-image");
      await assert.rejects(
        host.invokeMethod("delete", {}, signal),
        (error: unknown) => error instanceof WebRendererError && error.code === "method_not_declared",
      );
      const result = await host.invokeMethod("inspect", { ref: "exact" }, signal);
      assert.equal(result.ok, true);
      await assert.rejects(
        host.openLink({ contract_version: 1, href: "javascript:alert(1)", disposition: "same_context" }, signal),
        (error: unknown) => error instanceof WebRendererError && error.code === "unsafe_link",
      );
      await host.openLink({ contract_version: 1, href: "https://example.com/evidence", disposition: "new_context" }, signal);
      return {
        dispose() {
          assert.equal(signal.aborted, true);
          calls.push("renderer:dispose");
        },
      };
    },
  };
  const registry = new WebRendererRegistry([{
    descriptor: { id: exactDescriptor.id, version: 1, abi_version: 1 },
    load: async () => factory,
  }]);
  const services = createServices(events, {
    resolveAsset: async ({ request }) => {
      calls.push(`asset:${request.asset_id}`);
      return {
        contract_version: 1,
        asset_id: request.asset_id,
        object_url: "blob:fixture-image",
        media_type: "image/png",
        byte_length: 42,
      };
    },
    releaseAsset: async () => {
      released += 1;
      calls.push("asset:release");
    },
    invokeMethod: async ({ method_id }) => {
      calls.push(`method:${method_id}`);
      return { ok: true, request_id: "request.fixture", operation: "view.get", data: { exact: true } };
    },
    openLink: async request => { calls.push(`link:${new URL(request.href).protocol}`); },
  });
  const mounted = await registry.mount({
    ...mountRequest(events, [exactDescriptor]),
    declared_method_ids: ["inspect"],
    input: rendererInput({
      representation: { form: "inline", kind: "document", media_type: "application/json", value: {} },
      materializations: [{ asset_id: "asset.image", format: "png", media_type: "image/png", max_bytes: 100, byte_length: 42 }],
    }),
    services,
  });
  await mounted.dispose();

  assert.deepEqual(calls, ["asset:asset.image", "method:inspect", "link:https:", "renderer:dispose", "asset:release"]);
  assert.equal(released, 1);
  assert.ok(events.some(event => event.event === "renderer.asset.resolved"));
  assert.ok(events.some(event => event.event === "renderer.method.invoked"));
  assert.ok(events.some(event => event.event === "renderer.link.opened"));
  const serializedEvents = JSON.stringify(events);
  assert.doesNotMatch(serializedEvents, /example\.com|blob:fixture-image|exact/);
});

test("strict input and asset contracts reject unknown fields and network URLs", () => {
  assert.equal(WebRendererInputSchema.safeParse({ ...rendererInput(), policy: { visibility: "public" } }).success, false);
  assert.equal(WebRendererInputSchema.safeParse(rendererInput({
    representation: {
      form: "external_reference",
      kind: "image",
      media_type: "image/png",
      uri: "file:///Users/private/evidence.png",
    } as never,
    materializations: [{ asset_id: "asset.image", format: "png", media_type: "image/png", max_bytes: 100 }],
  })).success, false);
  assert.equal(ResolvedAssetSchema.safeParse({
    contract_version: 1,
    asset_id: "asset.image",
    object_url: "https://example.com/image.png",
    media_type: "image/png",
    byte_length: 42,
  }).success, false);
  assert.equal(WebRendererInputSchema.safeParse(rendererInput({
    materializations: [{
      asset_id: "asset.image",
      format: "png",
      media_type: "image/png",
      max_bytes: MAX_WEB_RENDERER_ASSET_BYTES + 1,
    }],
  })).success, false);
  assert.equal(AuthorizedAssetRequestSchema.safeParse({
    contract_version: 1,
    asset_id: "asset.image",
    accepted_media_types: ["image/png"],
    max_bytes: MAX_WEB_RENDERER_ASSET_BYTES + 1,
  }).success, false);
});

test("host releases a resolved blob that violates its frozen asset authorization", async () => {
  const released: string[] = [];
  const registry = new WebRendererRegistry([{
    descriptor: { id: exactDescriptor.id, version: 1, abi_version: 1 },
    load: async () => ({
      async mount(_container: HTMLElement, _input: WebRendererInput, host: WebRendererHostV1, signal: AbortSignal) {
        await assert.rejects(host.resolveAsset({
          contract_version: 1,
          asset_id: "asset.image",
          accepted_media_types: ["image/png"],
          max_bytes: MAX_WEB_RENDERER_ASSET_BYTES + 1,
        }, signal), (error: unknown) => error instanceof WebRendererError && error.code === "asset_not_authorized");
        await assert.rejects(host.resolveAsset({
          contract_version: 1,
          asset_id: "asset.image",
          accepted_media_types: ["image/png"],
          max_bytes: 100,
        }, signal), (error: unknown) => error instanceof WebRendererError && error.code === "asset_resolution_failed");
        return { dispose() {} };
      },
    }),
  }]);
  const request = mountRequest([], [exactDescriptor]);
  const mounted = await registry.mount({
    ...request,
    input: rendererInput({ materializations: [{ asset_id: "asset.image", format: "png", media_type: "image/png", max_bytes: 100 }] }),
    services: createServices([], {
      resolveAsset: async () => ({
        contract_version: 1,
        asset_id: "asset.image",
        object_url: "blob:oversized",
        media_type: "image/png",
        byte_length: 101,
      }),
      releaseAsset: asset => { released.push(asset.object_url); },
    }),
  });
  await mounted.dispose();
  assert.deepEqual(released, ["blob:oversized"]);
});

test("host rejects duplicate Method capabilities before loading Renderer code", async () => {
  let loads = 0;
  const registry = new WebRendererRegistry([{
    descriptor: { id: exactDescriptor.id, version: 1, abi_version: 1 },
    load: async () => {
      loads += 1;
      return fixtureFactory();
    },
  }]);
  await assertRendererError(registry.mount({
    ...mountRequest([], [exactDescriptor]),
    declared_method_ids: ["inspect", "inspect"],
  }), "invalid_input");
  assert.equal(loads, 0);
});

test("renderer input projects external references to opaque bounded assets", async () => {
  let rendererInputJson = "";
  const registry = new WebRendererRegistry([{
    descriptor: { id: exactDescriptor.id, version: 1, abi_version: 1 },
    load: async () => ({
      async mount(_container: HTMLElement, input: WebRendererInput) {
        rendererInputJson = JSON.stringify(input);
        assert.deepEqual(input.representation, {
          form: "external_reference",
          kind: "document",
          media_type: "application/json",
          asset_id: "asset.document",
        });
        return { dispose() {} };
      },
    }),
  }]);
  const mounted = await registry.mount({
    ...mountRequest([], [exactDescriptor]),
    input: rendererInput({
      representation: {
        form: "external_reference",
        kind: "document",
        media_type: "application/json",
        asset_id: "asset.document",
      },
      materializations: [{
        asset_id: "asset.document",
        format: "json",
        media_type: "application/json",
        max_bytes: 1_024,
      }],
    }),
  });
  await mounted.dispose();
  assert.doesNotMatch(rendererInputJson, /(?:file:|https?:|\/Users\/|\"uri\"|\"path\")/i);
});

test("unknown-length materializations cannot exceed their host-declared byte bound", async () => {
  let resolverCalls = 0;
  const registry = new WebRendererRegistry([{
    descriptor: { id: exactDescriptor.id, version: 1, abi_version: 1 },
    load: async () => ({
      async mount(_container: HTMLElement, _input: WebRendererInput, host: WebRendererHostV1, signal: AbortSignal) {
        await assert.rejects(host.resolveAsset({
          contract_version: 1,
          asset_id: "asset.image",
          accepted_media_types: ["image/png"],
          max_bytes: 101,
        }, signal), (error: unknown) => error instanceof WebRendererError && error.code === "asset_not_authorized");
        const asset = await host.resolveAsset({
          contract_version: 1,
          asset_id: "asset.image",
          accepted_media_types: ["image/png"],
          max_bytes: 100,
        }, signal);
        assert.equal(asset.byte_length, 100);
        return { dispose() {} };
      },
    }),
  }]);
  const request = mountRequest([], [exactDescriptor]);
  const mounted = await registry.mount({
    ...request,
    input: rendererInput({
      materializations: [{ asset_id: "asset.image", format: "png", media_type: "image/png", max_bytes: 100 }],
    }),
    services: createServices([], {
      resolveAsset: async ({ request }) => {
        resolverCalls += 1;
        assert.equal(request.max_bytes, 100);
        return {
          contract_version: 1,
          asset_id: "asset.image",
          object_url: "blob:bounded",
          media_type: "image/png",
          byte_length: 100,
        };
      },
    }),
  });
  await mounted.dispose();
  assert.equal(resolverCalls, 1);
});

test("Markdown link failures are surfaced to renderer state", async () => {
  const observed: string[] = [];
  const host: WebRendererHostV1 = {
    resolveAsset: async () => { throw new Error("not used"); },
    invokeMethod: async () => { throw new Error("not used"); },
    openLink: async () => { throw new WebRendererError("synthetic rejection", "link_open_failed"); },
  };
  await openMarkdownLink(host, {
    contract_version: 1,
    href: "https://example.com/evidence",
    disposition: "same_context",
  }, new AbortController().signal, errorCode => { observed.push(errorCode); });
  assert.deepEqual(observed, ["link_open_failed"]);
});

test("JSON, Markdown, and table security fixtures escape content without raw HTML or arbitrary fetch", () => {
  const hostile = `<script>alert("xss")</script><img src="https://tracker.example/pixel">`;
  const jsonHtml = renderToStaticMarkup(renderJsonView(rendererInput({
    representation: { form: "inline", kind: "document", media_type: "application/json", value: { hostile } },
  })));
  assert.doesNotMatch(jsonHtml, /<script|<img/i);
  assert.match(jsonHtml, /&lt;script&gt;/);

  const noOpHost: WebRendererHostV1 = {
    resolveAsset: async () => { throw new Error("not used"); },
    invokeMethod: async () => { throw new Error("not used"); },
    openLink: async () => { throw new Error("not used"); },
  };
  const markdownHtml = renderToStaticMarkup(renderMarkdownView(rendererInput({
    representation: {
      form: "inline",
      kind: "document",
      media_type: "text/markdown",
      value: `# Safe\n\n${hostile}\n\n[bad](javascript:alert(1)) [good](https://example.com)`,
    },
  }), noOpHost, new AbortController().signal));
  assert.doesNotMatch(markdownHtml, /<script|<img|javascript:/i);
  assert.match(markdownHtml, /href="https:\/\/example\.com\/"/);

  const tableInput = strictTableInput(hostile);
  const parsed = parseSchemaDrivenTable(tableInput);
  assert.deepEqual(parsed.columns.map(column => [column.id, column.value_type]), [["title", "string"], ["score", "number"]]);
  const tableHtml = renderToStaticMarkup(renderTableView(tableInput));
  assert.doesNotMatch(tableHtml, /<script|<img/i);
  assert.match(tableHtml, /&lt;script&gt;/);
});

function mountRequest(events: RendererLifecycleEvent[], descriptors: readonly unknown[]) {
  return {
    descriptors,
    input: rendererInput(),
    declared_method_ids: [],
    container: {} as HTMLElement,
    services: createServices(events),
    signal: new AbortController().signal,
  };
}

function rendererInput(overrides: Partial<WebRendererInput> = {}): WebRendererInput {
  return {
    contract_version: 1,
    view: { view_id: "view.fixture", revision: 1 },
    envelope: {
      contract_version: 1,
      name: "Fixture document",
      purpose: "Renderer host conformance",
      schema: { name: "fixture.document", version: 1, mode: "freeform" },
      role: "derived",
      time: { created_at: "2026-07-27T00:00:00.000Z" },
    },
    representation: {
      form: "inline",
      kind: "document",
      media_type: "application/json",
      value: { title: "Fixture" },
    },
    materializations: [],
    mode: "full",
    ...overrides,
  };
}

function strictTableInput(hostile: string): WebRendererInput {
  return rendererInput({
    envelope: {
      contract_version: 1,
      name: "Scores",
      purpose: "Schema-driven table fixture",
      schema: {
        name: "fixture.document",
        version: 1,
        mode: "strict",
        dialect: "https://json-schema.org/draft/2020-12/schema",
        json_schema: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "score"],
            properties: {
              title: { type: "string", title: "Title" },
              score: { type: "number", title: "Score" },
            },
          },
        },
      },
      role: "derived",
      time: { created_at: "2026-07-27T00:00:00.000Z" },
    },
    representation: {
      form: "inline",
      kind: "document",
      media_type: "application/json",
      value: [{ title: hostile, score: 7 }],
    },
  });
}

function createServices(
  events: RendererLifecycleEvent[],
  overrides: Partial<RendererHostServices> = {},
): RendererHostServices {
  let tick = 0;
  return {
    resolveAsset: async () => { throw new Error("unexpected asset request"); },
    releaseAsset: async () => undefined,
    invokeMethod: async () => { throw new Error("unexpected Method invocation"); },
    openLink: async () => { throw new Error("unexpected link request"); },
    emit: event => { events.push(event); },
    reportBackgroundError: error => { throw error; },
    now: () => new Date("2026-07-27T00:00:00.000Z"),
    monotonicNow: () => ++tick,
    ...overrides,
  };
}

function fixtureFactory(dispose: () => void = () => undefined): WebRendererFactoryV1 {
  return { async mount() { return { dispose }; } };
}

function registryFor(factory: WebRendererFactoryV1): WebRendererRegistry {
  return new WebRendererRegistry([{
    descriptor: { id: exactDescriptor.id, version: 1, abi_version: 1 },
    load: async () => factory,
  }]);
}

async function assertRendererError(promise: Promise<unknown>, code: WebRendererError["code"]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof WebRendererError && error.code === code);
}
