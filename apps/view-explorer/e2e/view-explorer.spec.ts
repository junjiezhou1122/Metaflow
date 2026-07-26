import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";

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

test("WebGL unavailability is a visible typed failure", async ({ page }) => {
  await page.goto("/?fixture=10&webgl=off");
  await expect(page.locator('[data-error-code="graph_webgl_unavailable"]')).toBeVisible();
  await expect(page.locator(".sigma-container")).toHaveCount(0);
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
