import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import {
  createFixtureTransport,
  PERSONALIZED_FIXTURE_ID,
  PERSONALIZED_VIEW_REFS,
  PRODUCT_VIEWS_FIXTURE_ID,
  type FixtureTransport,
} from "../src/fixtures.js";
import { refKey, type ExplorerOperation } from "../src/contracts.js";

const viewports = [
  { name: "desktop", width: 1_440, height: 900 },
  { name: "compact", width: 1_024, height: 768 },
  { name: "mobile", width: 390, height: 844 },
] as const;

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
});

for (const viewport of viewports) {
  test(`${viewport.name} graph is visible, nonblank, and overlap-free`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors = watchErrors(page);
    await page.goto("/?fixture=10");
    await ready(page, 10);
    await openSettings(page);
    await expect(page.getByRole("checkbox", { name: "Application composition" })).toBeChecked();
    await openBrowse(page);
    await expect(page.getByLabel("Relations in projection")).toContainText("Application composition:");
    const histogram = await canvasHistogram(page);
    expect(histogram).toMatchObject({ nonBackgroundPixels: expect.any(Number) });
    expect(histogram.nonBackgroundPixels).toBeGreaterThan(20);
    await expect(page.locator(".topbar")).toBeInViewport();
    await expect(page.locator(".companion")).toBeInViewport();
    await assertGraphCanvasLayout(page);
    await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-fixture-10.png`), animations: "disabled" });
    await expect(page.locator(".companion")).toHaveClass(/drawer-open/);
    expect(errors).toEqual([]);
  });
}

for (const viewport of [viewports[0], viewports[2]]) {
  test(`${viewport.name} personalized Application Space focuses exact working-state evidence`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const transport = createFixtureTransport(PERSONALIZED_FIXTURE_ID);
    await installOperationRoute(page, transport);
    const operationRequests: string[] = [];
    const errors = watchErrors(page);
    page.on("request", request => { if (request.url().includes("/metaflow/v1/operations/")) operationRequests.push(request.url()); });
    await page.goto(`/?root=${encodeURIComponent(refKey(PERSONALIZED_VIEW_REFS.application_space))}`);
    await ready(page, 6);

    expect(new URL(page.url()).searchParams.get("root")).toBe(refKey(PERSONALIZED_VIEW_REFS.application_space));
    await openBrowse(page);
    await expect(page.getByRole("option", { name: /Personal Knowledge Workspace/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /Synthetic Codex Architecture Session/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /View Model Decisions/ })).toBeVisible();
    await expect(page.getByLabel("Relations in projection")).toContainText("Derived from: 4");

    await page.getByRole("search").getByRole("textbox").fill("Metaflow Implementation Working State");
    await page.getByRole("button", { name: "Focus search result" }).click();
    const workingStateKey = refKey(PERSONALIZED_VIEW_REFS.working_state);
    await expect(page.locator(".view-dialog-identity code")).toHaveText(workingStateKey);
    await assertFocusedNodeVisible(page, workingStateKey);
    expect(new URL(page.url()).searchParams.get("selected")).toBe(workingStateKey);

    await expect(page.locator(".view-dialog-identity h1")).toHaveText("Metaflow Implementation Working State");
    await expect(page.locator(".view-information")).toContainText("personal.working_state@1");
    await expect(page.locator(".view-json")).toContainText("code_reflected_decisions");
    const provenance = page.locator("section.provenance");
    await expect(provenance).toContainText("operator:personalized-working-state");
    for (const ref of [
      PERSONALIZED_VIEW_REFS.codex_history,
      PERSONALIZED_VIEW_REFS.obsidian_view_model,
      PERSONALIZED_VIEW_REFS.obsidian_search_graph,
      PERSONALIZED_VIEW_REFS.obsidian_connector_design,
    ]) {
      await expect(provenance).toContainText(`${ref.view_id}@${ref.revision}`);
    }

    const histogram = await canvasHistogram(page);
    expect(histogram.nonBackgroundPixels).toBeGreaterThan(20);
    expect(histogram.uniqueColors).toBeGreaterThan(4);
    await assertGraphCanvasLayout(page);
    await assertViewportContainment(page, viewport.width, viewport.height);
    await testInfo.attach(`${viewport.name}-personalized-application-space`, {
      body: await page.screenshot({ animations: "disabled" }),
      contentType: "image/png",
    });
    expect(operationRequests.length).toBeGreaterThan(0);
    expect(transport.calls.some(call => call.operation === "view.graph.project")).toBe(true);
    expect(transport.calls.some(call => call.operation === "view.get")).toBe(true);
    expect(transport.calls.some(call => call.operation === "view.search")).toBe(false);
    expect(errors).toEqual([]);
  });
}

test("clicking a Markdown View opens its rendered content while the graph remains the navigation surface", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  const errors = watchErrors(page);
  await page.goto("/?fixture=personalized");
  await ready(page, 6);
  await browseAndSelect(page, /View Model Decisions/);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".view-dialog-identity h1")).toHaveText("View Model Decisions");
  await expect(page.locator(".view-markdown h1")).toHaveText("View Model Decisions");
  await expect(page.locator(".view-markdown")).toContainText("Views retain exact revisions and source provenance");
  await expect(page.locator(".view-information")).toContainText("obsidian.markdown.note@1");
  await testInfo.attach("markdown-view-content-dialog", {
    body: await page.screenshot({ animations: "disabled" }),
    contentType: "image/png",
  });
  expect(errors).toEqual([]);
});

test("product View graph opens dedicated Daily Summary, Timeline, and Audio content", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  const errors = watchErrors(page);
  await page.goto(`/?fixture=${PRODUCT_VIEWS_FIXTURE_ID}`);
  await ready(page, 4);

  await browseAndSelect(page, /Daily Summary · Jul 27/);
  await expect(page.locator('[data-renderer="renderer.personal.daily-summary@1@1"]')).toBeVisible();
  await expect(page.locator(".daily-summary-lead h2")).toHaveText("The View became an information product");
  await expect(page.locator(".product-daily-summary")).toContainText("Audio, Timeline, and Daily Summary now form one recursive chain");
  await expect(page.locator(".view-json")).toHaveCount(0);

  await browseAndSelect(page, /Activity Timeline · Jul 27/);
  await expect(page.locator('[data-renderer="renderer.personal.timeline@1@1"]')).toBeVisible();
  await expect(page.locator(".timeline-blocks")).toContainText("View architecture conversation");
  await expect(page.locator(".timeline-entries code").filter({ hasText: "view:personal:audio:design-conversation@1" })).toHaveCount(1);

  await browseAndSelect(page, /Audio · View architecture/);
  await expect(page.locator('[data-renderer="renderer.personal.audio@1@1"]')).toBeVisible();
  await expect(page.locator(".audio-transcript")).toContainText("Graph 只是 View 的导航");
  await expect(page.locator(".product-view-columns")).toContainText("Implement dedicated Audio, Timeline, and Daily Summary renderers");
  const readyRenderers = await page.evaluate(() => (window as typeof window & {
    __METAFLOW_RENDERER_EVENTS__?: Array<{ event: string }>;
  }).__METAFLOW_RENDERER_EVENTS__?.filter(event => event.event === "renderer.ready").length ?? 0);
  expect(readyRenderers).toBeGreaterThanOrEqual(3);
  await testInfo.attach("product-view-audio", { body: await page.screenshot({ animations: "disabled" }), contentType: "image/png" });
  expect(errors).toEqual([]);
});

test("Daily Summary remains a continuous reading surface on mobile", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = watchErrors(page);
  await page.goto(`/?fixture=${PRODUCT_VIEWS_FIXTURE_ID}`);
  await ready(page, 4);
  await browseAndSelect(page, /Daily Summary · Jul 27/);
  await expect(page.locator('[data-renderer="renderer.personal.daily-summary@1@1"]')).toBeVisible();
  await expect(page.locator(".daily-theme")).toHaveCount(1);
  await assertViewportContainment(page, 390, 844);
  await testInfo.attach("mobile-product-daily-summary", { body: await page.screenshot({ animations: "disabled", fullPage: false }), contentType: "image/png" });
  expect(errors).toEqual([]);
});

for (const size of [1, 10, 500, 2_000]) {
  test(`${size}-node fixture preserves counts and virtual-list bounds`, async ({ page }) => {
    await page.setViewportSize({ width: 1_440, height: 900 });
    const operationRequests: string[] = [];
    const errors = watchErrors(page);
    page.on("request", request => { if (request.url().includes("/metaflow/v1/operations/")) operationRequests.push(request.url()); });
    await page.goto(`/?fixture=${size}`);
    await ready(page, size);
    await expect(page.locator(".explorer-shell")).toHaveAttribute("data-node-count", String(size));
    await openBrowse(page);
    await expect(page.locator('[role="listbox"]')).toHaveAttribute("aria-rowcount", String(size));
    const rendered = await page.locator('[role="option"]').count();
    expect(rendered).toBeLessThanOrEqual(Math.min(size, 30));
    if (size === 2_000) {
      await openSettings(page);
      await page.getByText("Advanced diagnostics").click();
      await expect(page.getByText("Truncated: node_limit")).toBeVisible();
      await expect(page.getByText("Redacted boundary present")).toBeVisible();
    }
    expect(operationRequests).toEqual([]);
    const calls = await page.evaluate(() => (window as typeof window & { __METAFLOW_FIXTURE_CALLS__?: Array<{ operation: string }> }).__METAFLOW_FIXTURE_CALLS__?.map(call => call.operation));
    expect(calls?.[0]).toBe("view.graph.project");
    expect(errors).toEqual([]);
  });
}

test("search focus, pointer and keyboard selection, expansion, filters, history, and reload agree", async ({ page }) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  const errors = watchErrors(page);
  await page.goto("/?fixture=10");
  await ready(page, 10);
  await browseAndSelect(page, /Research View 0001/);
  await expect(page.locator(".view-dialog-identity code")).toHaveText("view:fixture:0001@2");
  await closeDialog(page);
  await openBrowse(page);
  await page.getByRole("option", { name: /Research View 0002/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".view-dialog-identity code")).toHaveText("view:fixture:0002@3");
  await closeDialog(page);
  await page.getByRole("search").getByRole("textbox").fill("Research View 0003");
  await page.getByRole("button", { name: "Focus search result" }).click();
  await expect(page.locator(".view-dialog-identity code")).toHaveText("view:fixture:0003@1");
  await assertFocusedNodeVisible(page, "view:fixture:0003@1");
  expect((await canvasHistogram(page)).nonBackgroundPixels).toBeGreaterThan(20);
  await page.getByRole("button", { name: "Next neighbor" }).click();
  await expect(page.locator(".view-dialog-identity code")).not.toHaveText("view:fixture:0003@1");
  await closeDialog(page);
  await page.getByRole("search").getByRole("textbox").fill("Research View 0003");
  await page.getByRole("button", { name: "Focus search result" }).click();
  await page.getByRole("button", { name: "Reveal connected Views" }).click();
  await expect(page.locator(".explorer-shell")).toHaveAttribute("data-node-count", "11");
  const beforeEdges = Number((await page.locator(".canvas-stats span").nth(1).textContent())?.split(" ")[0]);
  const selectedBeforeReload = await page.locator(".view-dialog-identity code").textContent();
  await closeDialog(page);
  await openSettings(page);
  await page.getByRole("checkbox", { name: "References" }).uncheck();
  await page.getByRole("button", { name: "Update graph" }).click();
  await expect.poll(async () => Number((await page.locator(".canvas-stats span").nth(1).textContent())?.split(" ")[0])).toBeLessThan(beforeEdges);
  const filteredCount = Number(await page.locator(".explorer-shell").getAttribute("data-node-count"));
  await page.reload();
  await ready(page, filteredCount);
  expect(new URL(page.url()).searchParams.get("edges")).not.toContain("references");
  await expect(page.locator(".view-dialog-identity code")).toHaveText(selectedBeforeReload ?? "");
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get("selected")).not.toBe(selectedBeforeReload);
  const lifecycle = await page.evaluate(() => (window as typeof window & { __METAFLOW_EXPLORER__?: { sigmaCreated: number; sigmaKilled: number } }).__METAFLOW_EXPLORER__);
  expect((lifecycle?.sigmaCreated ?? 0) - (lifecycle?.sigmaKilled ?? 0)).toBe(1);
  expect(await page.locator(".sigma-container canvas").count()).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test("URL reload and Visited cameras remain authoritative after layout and exact-View focus", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  const errors = watchErrors(page);
  await page.goto("/?fixture=10");
  await ready(page, 10);
  await browseAndSelect(page, /Research View 0003/);
  await expect(page.locator(".view-dialog-identity code")).toHaveText("view:fixture:0003@1");
  await assertFocusedNodeVisible(page, "view:fixture:0003@1");
  await closeDialog(page);

  const beforePan = await currentCamera(page);
  const bounds = await page.locator(".sigma-container").boundingBox();
  expect(bounds).not.toBeNull();
  const start = { x: bounds!.x + bounds!.width * 0.32, y: bounds!.y + bounds!.height * 0.36 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 52, start.y + 34, { steps: 5 });
  await page.mouse.up();
  await page.mouse.wheel(0, -180);
  await expect.poll(async () => cameraDistance(await currentCamera(page), beforePan)).toBeGreaterThan(0.001);
  await expect.poll(async () => Math.abs((await currentCamera(page)).ratio - beforePan.ratio)).toBeGreaterThan(0.001);
  await expect.poll(() => cameraDistance(cameraFromUrl(page.url()), beforePan)).toBeGreaterThan(0.001);
  await expect.poll(() => Math.abs(cameraFromUrl(page.url()).ratio - beforePan.ratio)).toBeGreaterThan(0.001);
  await page.waitForTimeout(400);
  const savedCamera = cameraFromUrl(page.url());
  await assertCameraEquals(page, savedCamera);
  expect(Math.abs(savedCamera.x - beforePan.x)).toBeGreaterThan(0.001);
  expect(Math.abs(savedCamera.y - beforePan.y)).toBeGreaterThan(0.001);
  expect(Math.abs(savedCamera.ratio - beforePan.ratio)).toBeGreaterThan(0.001);
  expect((await canvasHistogram(page)).nonBackgroundPixels).toBeGreaterThan(20);

  await page.reload();
  await ready(page, 10);
  await closeDialog(page);
  await assertCameraEquals(page, savedCamera);
  await page.waitForTimeout(400);
  await assertCameraEquals(page, savedCamera);
  expect((await canvasHistogram(page)).nonBackgroundPixels).toBeGreaterThan(20);
  await page.screenshot({ path: testInfo.outputPath("camera-restored-reload.png"), animations: "disabled" });

  await browseAndSelect(page, /Research View 0004/);
  await expect(page.locator(".view-dialog-identity code")).toHaveText("view:fixture:0004@2");
  await assertFocusedNodeVisible(page, "view:fixture:0004@2");
  await page.waitForTimeout(400);
  const secondCamera = cameraFromUrl(page.url());
  await closeDialog(page);
  await openBrowse(page);
  await page.locator(".history-strip").getByRole("button", { name: "Research View 0003", exact: true }).click();
  await expect(page.locator(".view-dialog-identity code")).toHaveText("view:fixture:0003@1");
  await assertCameraEquals(page, savedCamera);
  await page.waitForTimeout(400);
  await assertCameraEquals(page, savedCamera);
  expect(cameraDistance(cameraFromUrl(page.url()), savedCamera)).toBeLessThanOrEqual(0.0001);
  expect((await canvasHistogram(page)).nonBackgroundPixels).toBeGreaterThan(20);
  await page.screenshot({ path: testInfo.outputPath("camera-restored-visited.png"), animations: "disabled" });
  await page.goBack();
  await expect(page.locator(".view-dialog-identity code")).toHaveText("view:fixture:0004@2");
  await assertCameraEquals(page, secondCamera);
  await page.waitForTimeout(400);
  await assertCameraEquals(page, secondCamera);
  expect((await canvasHistogram(page)).nonBackgroundPixels).toBeGreaterThan(20);
  expect(errors).toEqual([]);
});

test("WebGL unavailability is a visible typed failure", async ({ page }) => {
  await page.goto("/?fixture=10&webgl=off");
  await expect(page.locator('[data-error-code="graph_webgl_unavailable"]')).toBeVisible();
  await expect(page.locator(".sigma-container")).toHaveCount(0);
});

test("Worker SecurityError is a typed layout failure without unmount or page error", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: class {
        constructor() { throw new DOMException("Worker creation blocked by policy", "SecurityError"); }
      },
    });
  });
  const errors = watchErrors(page);
  await page.goto("/?fixture=10");
  await expect(page.locator('[data-error-code="graph_layout_worker_start_failed"]')).toBeVisible();
  await expect(page.locator(".sigma-container canvas").first()).toBeVisible();
  await expect(page.locator(".explorer-shell")).toHaveAttribute("data-layout-state", "failed");
  expect(errors).toEqual([]);
});

test("malformed current Worker response fails closed without mutating or unmounting Sigma", async ({ page }) => {
  await page.addInitScript(() => {
    class MalformedWorker extends EventTarget {
      postMessage(request: { generation: number; request_id: string }) {
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: {
          protocol_version: 1,
          generation: request.generation,
          request_id: request.request_id,
          ok: true,
          positions: [],
        } })));
      }
      terminate() {}
    }
    Object.defineProperty(window, "Worker", { configurable: true, value: MalformedWorker });
  });
  const errors = watchErrors(page);
  await page.goto("/?fixture=10");
  await expect(page.locator('[data-error-code="graph_layout_protocol_failed"]')).toBeVisible();
  await expect(page.locator(".sigma-container canvas").first()).toBeVisible();
  const lifecycle = await explorerDebug(page);
  expect(lifecycle.workersCreated).toBe(lifecycle.workersTerminated);
  expect(errors).toEqual([]);
});

test("stale Worker generation is ignored before one complete current response becomes ready", async ({ page }) => {
  await page.addInitScript(() => {
    class StaleThenReadyWorker extends EventTarget {
      postMessage(request: { generation: number; request_id: string; nodes: Array<{ key: string; x: number; y: number }> }) {
        queueMicrotask(() => {
          this.dispatchEvent(new MessageEvent("message", { data: { generation: request.generation - 1, request_id: "stale" } }));
          this.dispatchEvent(new MessageEvent("message", { data: {
            protocol_version: 1,
            generation: request.generation,
            request_id: request.request_id,
            ok: true,
            positions: request.nodes.map(node => ({ key: node.key, x: node.x, y: node.y })),
          } }));
        });
      }
      terminate() {}
    }
    Object.defineProperty(window, "Worker", { configurable: true, value: StaleThenReadyWorker });
  });
  const errors = watchErrors(page);
  await page.goto("/?fixture=10");
  await ready(page, 10);
  const lifecycle = await explorerDebug(page);
  expect(lifecycle.workersCreated).toBe(lifecycle.workersTerminated);
  expect(errors).toEqual([]);
});

test("daemon-shaped Search atomically loads, focuses, persists, and reloads one exact View", async ({ page }, testInfo) => {
  const transport = createFixtureTransport(10);
  await installOperationRoute(page, transport);
  const errors = watchErrors(page);
  await page.goto("/");
  await page.getByLabel("Authorized Search").fill("Research View 0003");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".view-dialog-identity code")).toHaveText("view:fixture:0003@1");
  await ready(page, 2);
  expect(new URL(page.url()).searchParams.get("root")).toBe("view:fixture:0003@1");
  expect(new URL(page.url()).searchParams.get("selected")).toBe("view:fixture:0003@1");
  await assertFocusedNodeVisible(page, "view:fixture:0003@1");
  expect((await canvasHistogram(page)).nonBackgroundPixels).toBeGreaterThan(20);
  const focusedCamera = cameraFromUrl(page.url());
  await page.screenshot({ path: testInfo.outputPath("real-operation-search.png"), animations: "disabled" });
  await page.reload();
  await expect(page.locator(".view-dialog-identity code")).toHaveText("view:fixture:0003@1");
  await ready(page, 2);
  expect(new URL(page.url()).searchParams.get("selected")).toBe("view:fixture:0003@1");
  await assertCameraEquals(page, focusedCamera);
  await page.waitForTimeout(400);
  await assertCameraEquals(page, focusedCamera);
  expect((await canvasHistogram(page)).nonBackgroundPixels).toBeGreaterThan(20);
  expect(transport.calls.some(call => call.operation === "view.search")).toBe(true);
  expect(errors).toEqual([]);
});

test("new Search supersedes stale Search, expansion, and projection responses", async ({ page }) => {
  const base = createFixtureTransport(10);
  const slowSearch = deferred();
  const slowSearchStarted = deferred();
  const slowExpand = deferred();
  const slowExpandStarted = deferred();
  const slowLoad = deferred();
  const slowLoadStarted = deferred();
  let holdNextLoad = false;
  const transport: FixtureTransport = {
    calls: base.calls,
    async call(operation, input, signal) {
      const request = input as { request?: { query?: { text?: string }; max_nodes?: number; roots?: Array<{ view_id: string }> } };
      if (operation === "view.search" && request.request?.query?.text === "Slow Search") {
        slowSearchStarted.resolve();
        await slowSearch.promise;
      }
      if (operation === "view.graph.project" && request.request?.max_nodes === 500) {
        slowExpandStarted.resolve();
        await slowExpand.promise;
      } else if (operation === "view.graph.project" && holdNextLoad && request.request?.roots?.[0]?.view_id === "view:fixture:0004") {
        holdNextLoad = false;
        slowLoadStarted.resolve();
        await slowLoad.promise;
      }
      return base.call(operation, input, signal);
    },
  };
  await installOperationRoute(page, transport);
  const errors = watchErrors(page);
  await page.goto("/");

  await page.getByLabel("Authorized Search").fill("Slow Search");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await slowSearchStarted.promise;
  await page.getByLabel("Authorized Search").fill("Research View 0002");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".view-dialog-identity code")).toHaveText("view:fixture:0002@3");
  slowSearch.resolve();
  await expect.poll(() => new URL(page.url()).searchParams.get("selected")).toBe("view:fixture:0002@3");

  await page.getByRole("button", { name: "Reveal connected Views" }).click();
  await slowExpandStarted.promise;
  await closeDialog(page);
  await page.getByRole("search").getByRole("textbox").fill("Research View 0004");
  await page.getByRole("button", { name: "Focus search result" }).click();
  await expect(page.locator(".view-dialog-identity code")).toHaveText("view:fixture:0004@2");
  slowExpand.resolve();
  await expect.poll(() => new URL(page.url()).searchParams.get("selected")).toBe("view:fixture:0004@2");

  holdNextLoad = true;
  await closeDialog(page);
  await openSettings(page);
  await page.getByRole("checkbox", { name: "References" }).uncheck();
  await page.getByRole("button", { name: "Update graph" }).click();
  await slowLoadStarted.promise;
  await page.getByRole("search").getByRole("textbox").fill("Research View 0006");
  await page.getByRole("button", { name: "Focus search result" }).click();
  await expect(page.locator(".view-dialog-identity code")).toHaveText("view:fixture:0006@1");
  slowLoad.resolve();
  await expect.poll(() => new URL(page.url()).searchParams.get("selected")).toBe("view:fixture:0006@1");
  await assertFocusedNodeVisible(page, "view:fixture:0006@1");
  expect(errors).toEqual([]);
});

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", error => errors.push(error.message));
  return errors;
}

async function ready(page: Page, size: number): Promise<void> {
  await expect(page.locator(".explorer-shell")).toHaveAttribute("data-node-count", String(size));
  await expect(page.locator(".sigma-container canvas").first()).toBeVisible();
  await expect(page.locator(".explorer-shell")).toHaveAttribute("data-layout-state", "ready");
}

async function installOperationRoute(page: Page, transport: FixtureTransport): Promise<void> {
  await page.route("**/metaflow/v1/operations/*", async route => {
    const operation = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1) ?? "") as ExplorerOperation;
    try {
      const result = await transport.call(operation, route.request().postDataJSON(), new AbortController().signal);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(result) });
    } catch {
      await route.abort("failed").catch(() => undefined);
    }
  });
}

async function assertFocusedNodeVisible(page: Page, key: string): Promise<void> {
  await expect.poll(async () => {
    const focused = (await explorerDebug(page)).focusedNode;
    return focused?.key === key && focused.visible && focused.x >= 0 && focused.x <= focused.width && focused.y >= 0 && focused.y <= focused.height;
  }).toBe(true);
}

async function explorerDebug(page: Page): Promise<{
  workersCreated: number;
  workersTerminated: number;
  camera?: CameraSnapshot;
  focusedNode?: { key: string; x: number; y: number; width: number; height: number; visible: boolean };
}> {
  return page.evaluate(() => (window as typeof window & { __METAFLOW_EXPLORER__: {
    workersCreated: number;
    workersTerminated: number;
    camera?: CameraSnapshot;
    focusedNode?: { key: string; x: number; y: number; width: number; height: number; visible: boolean };
  } }).__METAFLOW_EXPLORER__);
}

type CameraSnapshot = { x: number; y: number; ratio: number; angle: number };

async function currentCamera(page: Page): Promise<CameraSnapshot> {
  const camera = (await explorerDebug(page)).camera;
  if (!camera) throw new Error("Sigma camera debug state is unavailable");
  return camera;
}

function cameraFromUrl(value: string): CameraSnapshot {
  const url = new URL(value);
  const camera = {
    x: Number(url.searchParams.get("cx")),
    y: Number(url.searchParams.get("cy")),
    ratio: Number(url.searchParams.get("ratio")),
    angle: Number(url.searchParams.get("angle")),
  };
  if (!Object.values(camera).every(Number.isFinite) || camera.ratio <= 0) throw new Error(`URL has no valid camera: ${value}`);
  return camera;
}

function cameraDistance(left: CameraSnapshot, right: CameraSnapshot): number {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y), Math.abs(left.ratio - right.ratio), Math.abs(left.angle - right.angle));
}

async function assertCameraEquals(page: Page, expected: CameraSnapshot): Promise<void> {
  await expect.poll(async () => cameraDistance(await currentCamera(page), expected)).toBeLessThanOrEqual(0.0002);
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(next => { resolve = next; });
  return { promise, resolve };
}

async function canvasHistogram(page: Page): Promise<{ uniqueColors: number; nonBackgroundPixels: number }> {
  const image = PNG.sync.read(await page.locator(".sigma-container").screenshot({ animations: "disabled" }));
  const colors = new Set<string>();
  let nonBackgroundPixels = 0;
  for (let index = 0; index < image.data.length; index += 16) {
    const color = `${image.data[index]},${image.data[index + 1]},${image.data[index + 2]},${image.data[index + 3]}`;
    colors.add(color);
    if (image.data[index + 3]! > 0 && !(image.data[index]! > 225 && image.data[index + 1]! > 225 && image.data[index + 2]! > 225)) nonBackgroundPixels += 1;
  }
  return { uniqueColors: colors.size, nonBackgroundPixels };
}

async function assertGraphCanvasLayout(page: Page): Promise<void> {
  const boxes = await page.evaluate(() => Object.fromEntries([".topbar", ".graph-stage"].map(selector => {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    if (!rect) throw new Error(`Missing layout surface ${selector}`);
    return [selector, { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left }];
  })));
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  expect(boxes[".graph-stage"]!.top).toBeLessThanOrEqual(1);
  expect(boxes[".graph-stage"]!.left).toBeLessThanOrEqual(1);
  expect(boxes[".graph-stage"]!.right).toBeGreaterThanOrEqual(viewport!.width - 1);
  expect(boxes[".graph-stage"]!.bottom).toBeGreaterThanOrEqual(viewport!.height - 1);
  expect(boxes[".topbar"]!.top).toBeGreaterThanOrEqual(0);
  expect(boxes[".topbar"]!.left).toBeGreaterThanOrEqual(0);
  expect(boxes[".topbar"]!.right).toBeLessThanOrEqual(viewport!.width);
}

async function assertViewportContainment(page: Page, width: number, height: number): Promise<void> {
  const boxes = await page.evaluate(() => Object.fromEntries([
    ".topbar",
    ".graph-stage",
    ".view-dialog",
    ".view-dialog-header",
  ].map(selector => {
    const element = document.querySelector(selector);
    const rect = element?.getBoundingClientRect();
    if (!element || !rect) throw new Error(`Missing personalized workflow surface ${selector}`);
    return [selector, {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }];
  })));
  for (const [selector, box] of Object.entries(boxes)) {
    expect(box.top, `${selector} top`).toBeGreaterThanOrEqual(-1);
    expect(box.right, `${selector} right`).toBeLessThanOrEqual(width + 1);
    expect(box.bottom, `${selector} bottom`).toBeLessThanOrEqual(height + 1);
    expect(box.left, `${selector} left`).toBeGreaterThanOrEqual(-1);
    expect(box.scrollWidth, `${selector} horizontal overflow`).toBeLessThanOrEqual(box.clientWidth + 1);
  }
}

async function openSettings(page: Page): Promise<void> {
  const drawer = page.locator(".left-panel");
  if (!await drawer.evaluate(element => element.classList.contains("mobile-open"))) {
    await page.getByRole("button", { name: "Graph settings", exact: true }).click();
  }
  await expect(drawer).toHaveClass(/mobile-open/);
}

async function openBrowse(page: Page): Promise<void> {
  const drawer = page.locator(".companion");
  if (!await drawer.evaluate(element => element.classList.contains("drawer-open"))) {
    await page.getByRole("button", { name: "Browse Views", exact: true }).click();
  }
  await expect(drawer).toHaveClass(/drawer-open/);
}

async function browseAndSelect(page: Page, name: RegExp): Promise<void> {
  await closeDialog(page);
  await openBrowse(page);
  await page.getByRole("option", { name }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

async function closeDialog(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  if (await dialog.isVisible()) await page.getByRole("button", { name: "Close View", exact: true }).click();
}
