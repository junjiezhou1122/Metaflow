import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import { createFixtureTransport, type FixtureTransport } from "../src/fixtures.js";
import type { ExplorerOperation } from "../src/contracts.js";

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
    await expect(page.getByRole("checkbox", { name: "application_composition" })).toBeChecked();
    await expect(page.getByLabel("Relations in projection")).toContainText("application_composition:");
    const histogram = await canvasHistogram(page);
    expect(histogram).toMatchObject({ nonBackgroundPixels: expect.any(Number) });
    expect(histogram.nonBackgroundPixels).toBeGreaterThan(20);
    await expect(page.locator(".topbar")).toBeInViewport();
    await expect(page.locator(".companion")).toBeInViewport();
    await assertSeparatedLayout(page);
    await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-fixture-10.png`), animations: "disabled" });
    if (viewport.name === "mobile") {
      await page.getByRole("button", { name: "Toggle graph filters" }).click();
      await expect(page.locator(".left-panel")).toHaveClass(/mobile-open/);
      await page.getByRole("button", { name: "Toggle exact View details" }).click();
      await expect(page.locator(".left-panel")).not.toHaveClass(/mobile-open/);
      await expect(page.locator(".right-panel")).toHaveClass(/mobile-open/);
      await assertSeparatedLayout(page);
    }
    expect(errors).toEqual([]);
  });
}

for (const size of [1, 10, 500, 2_000]) {
  test(`${size}-node fixture preserves counts and virtual-list bounds`, async ({ page }) => {
    await page.setViewportSize({ width: 1_440, height: 900 });
    const operationRequests: string[] = [];
    const errors = watchErrors(page);
    page.on("request", request => { if (request.url().includes("/metaflow/v1/operations/")) operationRequests.push(request.url()); });
    await page.goto(`/?fixture=${size}`);
    await ready(page, size);
    await expect(page.locator(".explorer-shell")).toHaveAttribute("data-node-count", String(size));
    await expect(page.locator('[role="listbox"]')).toHaveAttribute("aria-rowcount", String(size));
    const rendered = await page.locator('[role="option"]').count();
    expect(rendered).toBeLessThanOrEqual(Math.min(size, 30));
    if (size === 2_000) {
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
  await page.getByRole("option", { name: /Research View 0001/ }).click();
  await expect(page.locator(".detail-heading code")).toHaveText("view:fixture:0001@2");
  await page.getByRole("option", { name: /Research View 0002/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".detail-heading code")).toHaveText("view:fixture:0002@3");
  await page.getByRole("search").getByRole("textbox").fill("Research View 0003");
  await page.getByRole("button", { name: "Focus search result" }).click();
  await expect(page.locator(".detail-heading code")).toHaveText("view:fixture:0003@1");
  await assertFocusedNodeVisible(page, "view:fixture:0003@1");
  expect((await canvasHistogram(page)).nonBackgroundPixels).toBeGreaterThan(20);
  await page.getByRole("button", { name: "Next neighbor" }).click();
  await expect(page.locator(".detail-heading code")).not.toHaveText("view:fixture:0003@1");
  await page.getByRole("search").getByRole("textbox").fill("Research View 0003");
  await page.getByRole("button", { name: "Focus search result" }).click();
  await page.getByRole("button", { name: "Expand one hop" }).click();
  await expect(page.locator(".explorer-shell")).toHaveAttribute("data-node-count", "11");
  const beforeEdges = Number((await page.locator(".canvas-stats span").nth(1).textContent())?.split(" ")[0]);
  await page.getByRole("checkbox", { name: "references" }).uncheck();
  await page.getByRole("button", { name: "Apply projection" }).click();
  await expect.poll(async () => Number((await page.locator(".canvas-stats span").nth(1).textContent())?.split(" ")[0])).toBeLessThan(beforeEdges);
  const filteredCount = Number(await page.locator(".explorer-shell").getAttribute("data-node-count"));
  const selectedBeforeReload = await page.locator(".detail-heading code").textContent();
  await page.reload();
  await ready(page, filteredCount);
  expect(new URL(page.url()).searchParams.get("edges")).not.toContain("references");
  await expect(page.locator(".detail-heading code")).toHaveText(selectedBeforeReload ?? "");
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get("selected")).not.toBe(selectedBeforeReload);
  const lifecycle = await page.evaluate(() => (window as typeof window & { __METAFLOW_EXPLORER__?: { sigmaCreated: number; sigmaKilled: number } }).__METAFLOW_EXPLORER__);
  expect((lifecycle?.sigmaCreated ?? 0) - (lifecycle?.sigmaKilled ?? 0)).toBe(1);
  expect(await page.locator(".sigma-container canvas").count()).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test("pointer hover reveals only the loaded neighborhood and restores selection without side effects", async ({ page }) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  const errors = watchErrors(page);
  await page.goto("/?fixture=10");
  await ready(page, 10);
  await page.getByRole("option", { name: /Research View 0003/ }).click();
  await expect(page.locator(".detail-heading code")).toHaveText("view:fixture:0003@1");
  await assertFocusedNodeVisible(page, "view:fixture:0003@1");
  await expect.poll(async () => fixtureCallCount(page)).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(100);
  await expect.poll(async () => cameraDistance(await currentCamera(page), cameraFromUrl(page.url()))).toBeLessThanOrEqual(0.0002);

  const baselineUrl = page.url();
  const baselineCamera = await currentCamera(page);
  const baselineCalls = await fixtureCallCount(page);
  const graphBounds = await page.locator(".sigma-container").boundingBox();
  const focused = (await explorerDebug(page)).focusedNode;
  expect(graphBounds).not.toBeNull();
  expect(focused).toBeDefined();

  await page.mouse.move(graphBounds!.x + focused!.x, graphBounds!.y + focused!.y);
  await expect.poll(async () => (await explorerDebug(page)).hoveredNeighborhood).toMatchObject({
    key: "view:fixture:0003@1",
    neighborCount: 2,
    incidentEdgeCount: 2,
    unrelatedNodeCount: 7,
  });
  const hovered = (await explorerDebug(page)).hoveredNeighborhood;
  expect(hovered!.unrelatedEdgeCount).toBeGreaterThan(0);
  expect((await explorerDebug(page)).hoverEnterCount).toBeGreaterThanOrEqual(1);
  await expect(page.locator(".detail-heading code")).toHaveText("view:fixture:0003@1");
  expect(page.url()).toBe(baselineUrl);
  expect(await fixtureCallCount(page)).toBe(baselineCalls);
  expect(cameraDistance(await currentCamera(page), baselineCamera)).toBeLessThanOrEqual(0.0002);

  await page.mouse.move(20, 20);
  await expect.poll(async () => (await explorerDebug(page)).hoveredNeighborhood).toBeUndefined();
  expect((await explorerDebug(page)).hoverLeaveCount).toBeGreaterThanOrEqual(1);
  await expect(page.locator(".detail-heading code")).toHaveText("view:fixture:0003@1");
  expect(page.url()).toBe(baselineUrl);
  expect(await fixtureCallCount(page)).toBe(baselineCalls);
  expect(cameraDistance(await currentCamera(page), baselineCamera)).toBeLessThanOrEqual(0.0002);
  expect(errors).toEqual([]);
});

test("URL reload and Visited cameras remain authoritative after layout and exact-View focus", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  const errors = watchErrors(page);
  await page.goto("/?fixture=10");
  await ready(page, 10);
  await page.getByRole("option", { name: /Research View 0003/ }).click();
  await expect(page.locator(".detail-heading code")).toHaveText("view:fixture:0003@1");
  await assertFocusedNodeVisible(page, "view:fixture:0003@1");

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
  await assertCameraEquals(page, savedCamera);
  await page.waitForTimeout(400);
  await assertCameraEquals(page, savedCamera);
  expect((await canvasHistogram(page)).nonBackgroundPixels).toBeGreaterThan(20);
  await page.screenshot({ path: testInfo.outputPath("camera-restored-reload.png"), animations: "disabled" });

  await page.getByRole("option", { name: /Research View 0004/ }).click();
  await expect(page.locator(".detail-heading code")).toHaveText("view:fixture:0004@2");
  await assertFocusedNodeVisible(page, "view:fixture:0004@2");
  await page.waitForTimeout(400);
  const secondCamera = cameraFromUrl(page.url());
  await page.locator(".history-strip").getByRole("button", { name: "Research View 0003", exact: true }).click();
  await expect(page.locator(".detail-heading code")).toHaveText("view:fixture:0003@1");
  await assertCameraEquals(page, savedCamera);
  await page.waitForTimeout(400);
  await assertCameraEquals(page, savedCamera);
  expect(cameraDistance(cameraFromUrl(page.url()), savedCamera)).toBeLessThanOrEqual(0.0001);
  expect((await canvasHistogram(page)).nonBackgroundPixels).toBeGreaterThan(20);
  await page.screenshot({ path: testInfo.outputPath("camera-restored-visited.png"), animations: "disabled" });
  await page.goBack();
  await expect(page.locator(".detail-heading code")).toHaveText("view:fixture:0004@2");
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
  await expect(page.locator(".detail-heading code")).toHaveText("view:fixture:0003@1");
  await ready(page, 2);
  expect(new URL(page.url()).searchParams.get("root")).toBe("view:fixture:0003@1");
  expect(new URL(page.url()).searchParams.get("selected")).toBe("view:fixture:0003@1");
  await expect(page.locator(".history-strip").getByRole("button", { name: "Research View 0003" })).toBeVisible();
  await assertFocusedNodeVisible(page, "view:fixture:0003@1");
  expect((await canvasHistogram(page)).nonBackgroundPixels).toBeGreaterThan(20);
  const focusedCamera = cameraFromUrl(page.url());
  await page.screenshot({ path: testInfo.outputPath("real-operation-search.png"), animations: "disabled" });
  await page.reload();
  await expect(page.locator(".detail-heading code")).toHaveText("view:fixture:0003@1");
  await ready(page, 2);
  expect(new URL(page.url()).searchParams.get("selected")).toBe("view:fixture:0003@1");
  await expect(page.locator(".history-strip").getByRole("button", { name: "Research View 0003" })).toBeVisible();
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
  await expect(page.locator(".detail-heading code")).toHaveText("view:fixture:0002@3");
  slowSearch.resolve();
  await expect.poll(() => new URL(page.url()).searchParams.get("selected")).toBe("view:fixture:0002@3");

  await page.getByRole("button", { name: "Expand one hop" }).click();
  await slowExpandStarted.promise;
  await page.getByRole("search").getByRole("textbox").fill("Research View 0004");
  await page.getByRole("button", { name: "Focus search result" }).click();
  await expect(page.locator(".detail-heading code")).toHaveText("view:fixture:0004@2");
  slowExpand.resolve();
  await expect.poll(() => new URL(page.url()).searchParams.get("selected")).toBe("view:fixture:0004@2");

  holdNextLoad = true;
  await page.getByRole("checkbox", { name: "references" }).uncheck();
  await page.getByRole("button", { name: "Apply projection" }).click();
  await slowLoadStarted.promise;
  await page.getByRole("search").getByRole("textbox").fill("Research View 0006");
  await page.getByRole("button", { name: "Focus search result" }).click();
  await expect(page.locator(".detail-heading code")).toHaveText("view:fixture:0006@1");
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
  hoveredNeighborhood?: { key: string; neighborCount: number; incidentEdgeCount: number; unrelatedNodeCount: number; unrelatedEdgeCount: number };
  hoverEnterCount?: number;
  hoverLeaveCount?: number;
}> {
  return page.evaluate(() => (window as typeof window & { __METAFLOW_EXPLORER__: {
    workersCreated: number;
    workersTerminated: number;
    camera?: CameraSnapshot;
    focusedNode?: { key: string; x: number; y: number; width: number; height: number; visible: boolean };
    hoveredNeighborhood?: { key: string; neighborCount: number; incidentEdgeCount: number; unrelatedNodeCount: number; unrelatedEdgeCount: number };
    hoverEnterCount?: number;
    hoverLeaveCount?: number;
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

async function fixtureCallCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as typeof window & { __METAFLOW_FIXTURE_CALLS__?: unknown[] }).__METAFLOW_FIXTURE_CALLS__?.length ?? 0);
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

async function assertSeparatedLayout(page: Page): Promise<void> {
  const boxes = await page.evaluate(() => Object.fromEntries([".topbar", ".graph-stage", ".companion", ".left-panel", ".right-panel"].map(selector => {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    if (!rect) throw new Error(`Missing layout surface ${selector}`);
    return [selector, { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left }];
  })));
  expect(boxes[".topbar"]!.bottom).toBeLessThanOrEqual(boxes[".graph-stage"]!.top + 1);
  expect(boxes[".graph-stage"]!.bottom).toBeLessThanOrEqual(boxes[".companion"]!.top + 1);
  expect(boxes[".left-panel"]!.bottom).toBeLessThanOrEqual(boxes[".companion"]!.top + 1);
  expect(boxes[".right-panel"]!.bottom).toBeLessThanOrEqual(boxes[".companion"]!.top + 1);
}
