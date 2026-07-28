import { deflateSync } from "node:zlib";
import { expect, test, type Page, type Route } from "@playwright/test";

const SUBJECT = { view_id: "view:screenpipe:timeline-index:fixture", revision: 1 };
const SCREENSHOT = fixturePng(640, 360);

type FixtureEntry = {
  key: string;
  evidence: Array<{ view_id: string; revision: number }>;
  value: {
    at: string;
    modality: "screen" | "audio";
    title: string;
    text: string;
    app?: string;
    window?: string;
    focused?: boolean;
    image?: { kind: "screenpipe_frame"; frame_id: number; view: { view_id: string; revision: number } };
  };
};

const entries: FixtureEntry[] = Array.from({ length: 120 }, (_, index) => {
  const isScreen = index % 3 !== 2;
  const ref = { view_id: `view:screenpipe:${isScreen ? "frame" : "audio"}:${index + 1}`, revision: 1 };
  return {
    key: `timeline:fixture:${index + 1}`,
    evidence: [ref],
    value: {
      at: new Date(Date.UTC(2026, 6, 28, 8, 0) - index * 60_000).toISOString(),
      modality: isScreen ? "screen" : "audio",
      title: isScreen ? `Screen capture ${index + 1}` : `Audio segment ${index + 1}`,
      text: isScreen
        ? `Working in ${index % 2 === 0 ? "Codex" : "Chrome"} on Timeline record ${index + 1}.${index === 0 ? " Long accessibility context.".repeat(80) : ""}`
        : `Audio transcript ${index + 1}`,
      ...(isScreen ? {
        app: index % 2 === 0 ? "Codex" : "Chrome",
        window: `Timeline implementation ${index + 1}`,
        focused: index % 4 === 0,
        image: { kind: "screenpipe_frame" as const, frame_id: index + 1, view: ref },
      } : {}),
    },
  };
});

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
  await installFixtureApi(page);
});

test("desktop Timeline pages 120 small Views, filters by Method parameters, and renders stable screenshots", async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.goto("/");

  await expect(page.locator(".stream-meta")).toContainText("50 条已加载");
  await expect(page.locator(".timeline-row")).toHaveCount(50);
  const refreshRequest = page.waitForRequest(request => request.url().endsWith("/capture.connection.run"));
  await page.getByRole("button", { name: "刷新数据" }).click();
  const refreshBody = (await refreshRequest).postDataJSON() as Record<string, unknown>;
  expect(refreshBody.connection_id).toBe("screenpipe:fixture");
  expect(refreshBody.expected_generation).toBe(3);
  await expect(page.locator(".timeline-row")).toHaveCount(50);
  const firstImage = page.locator(".thumbnail-frame img").first();
  await firstImage.scrollIntoViewIfNeeded();
  await expect(firstImage).toBeVisible();
  await expect.poll(async () => {
    const source = await firstImage.getAttribute("src");
    return source ? new URL(source, "http://localhost").searchParams.get("width") : null;
  }).toBe("720");
  await expect.poll(() => firstImage.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(640);
  const frame = await firstImage.locator("..").boundingBox();
  expect(frame).not.toBeNull();
  expect(Math.abs(frame!.width / frame!.height - 16 / 9)).toBeLessThan(0.03);
  const longText = page.locator(".entry-text").first();
  const collapsedHeight = (await longText.boundingBox())!.height;
  await page.getByRole("button", { name: "展开" }).first().click();
  await expect.poll(async () => (await longText.boundingBox())!.height).toBeGreaterThan(collapsedHeight * 2);
  await page.getByRole("button", { name: "收起" }).first().click();

  await expect.poll(async () => {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    return page.locator(".timeline-row").count();
  }).toBe(120);
  await expect(page.locator(".stream-meta")).toContainText("120 条已加载");
  await expect(page.locator(".timeline-row")).toHaveCount(120);

  await page.getByLabel("应用").selectOption("Codex");
  await expect(page.locator(".timeline-row")).toHaveCount(40);
  await expect(page.locator(".entry-title strong")).toHaveText(Array(40).fill("Codex"));
  await page.getByText("只看前台", { exact: true }).click();
  await expect(page.getByLabel("只看前台")).toBeChecked();
  await expect(page.locator(".timeline-row")).toHaveCount(20);

  await page.getByLabel("日期").fill("2026-07-27");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("7月27日");
  await page.screenshot({ path: testInfo.outputPath("timeline-desktop.png"), animations: "disabled", fullPage: false });
  expect(errors).toEqual([]);
});

test("mobile Timeline keeps the filter drawer and stream separated", async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator(".stream-meta")).toContainText("50 条已加载");
  await page.getByRole("button", { name: "打开过滤器" }).click();
  await expect(page.locator(".filter-rail")).toHaveClass(/open/);
  const drawer = await page.locator(".filter-rail").boundingBox();
  const viewport = page.viewportSize();
  expect(drawer).not.toBeNull();
  expect(drawer!.x).toBeGreaterThanOrEqual(0);
  expect(drawer!.width).toBeLessThanOrEqual(viewport!.width);
  await page.getByRole("button", { name: "关闭过滤器" }).first().click();
  await expect(page.locator(".filter-rail")).not.toHaveClass(/open/);
  await expect(page.locator(".topbar")).toBeInViewport();
  await expect(page.locator(".timeline-row").first()).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("timeline-mobile.png"), animations: "disabled" });
  expect(errors).toEqual([]);
});

async function installFixtureApi(page: Page): Promise<void> {
  await page.route("**/ambient/v1/timeline", route => json(route, {
    ok: true,
    connection_id: "screenpipe:fixture",
    generation: 3,
    index_view_id: SUBJECT.view_id,
    timezone: "Asia/Shanghai",
  }));
  await page.route("**/metaflow/v1/assets/screenpipe-frame-thumbnail?*", route => route.fulfill({
    status: 200,
    contentType: "image/png",
    headers: { etag: "fixture-frame" },
    body: SCREENSHOT,
  }));
  await page.route("**/metaflow/v1/operations/*", async route => {
    const operation = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const input = route.request().postDataJSON() as any;
    if (operation === "view.resolve.latest") return json(route, success(operation, SUBJECT));
    if (operation === "capture.connection.run") {
      expect(input.connection_id).toBe("screenpipe:fixture");
      expect(input.expected_generation).toBe(3);
      expect(input.delivery).toBe("pull");
      return json(route, success(operation, { action: "run", generation: 3 }));
    }
    if (operation !== "view.query") return json(route, failure(operation, "operation_unknown"), 404);

    const parameters = input.request.parameters;
    const filters = parameters.filters ?? {};
    const filtered = entries.filter(entry => {
      if (filters.modalities && !filters.modalities.includes(entry.value.modality)) return false;
      if (filters.apps && !filters.apps.includes(entry.value.app)) return false;
      if (filters.has_image === true && !entry.value.image) return false;
      if (filters.focused === true && entry.value.focused !== true) return false;
      if (filters.text && !JSON.stringify(entry.value).toLocaleLowerCase().includes(String(filters.text).toLocaleLowerCase())) return false;
      return true;
    });
    const limit = input.request.page.limit as number;
    const offset = input.request.page.cursor ? Number(String(input.request.page.cursor).split(":")[1]) : 0;
    const items = filtered.slice(offset, offset + limit);
    const next = offset + items.length < filtered.length ? `offset:${offset + items.length}` : undefined;
    return json(route, success(operation, {
      contract_version: 1,
      subject: SUBJECT,
      profile: { id: "screenpipe.timeline.entries", version: 1 },
      items,
      ...(next ? { next_cursor: next } : {}),
      redacted_boundary: false,
    }));
  });
}

function success(operation: string, data: unknown) {
  return { ok: true, request_id: `request:${operation}`, operation, data };
}

function failure(operation: string, code: string) {
  return { ok: false, request_id: `request:${operation}`, operation, error: { code, message: code, category: "not_found", details: {} } };
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  return errors;
}

function fixturePng(width: number, height: number): Buffer {
  const stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    pixels[y * stride] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = y * stride + 1 + x * 3;
      const panel = x < width * 0.22 ? [35, 44, 47] : y < 58 ? [231, 235, 229] : [245, 246, 241];
      const line = y > 84 && y % 38 < 4 && x > width * 0.28 && x < width * 0.86;
      pixels[offset] = line ? 31 : panel[0]!;
      pixels[offset + 1] = line ? 111 : panel[1]!;
      pixels[offset + 2] = line ? 101 : panel[2]!;
    }
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([signature, pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0))]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return chunk;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
