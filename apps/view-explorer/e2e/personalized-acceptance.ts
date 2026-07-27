import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import { createServer } from "vite";
import { refKey, type ExactViewRef, type ExplorerOperation } from "../src/contracts.js";

const EXPLORER_OPERATIONS = new Set<ExplorerOperation>([
  "view.graph.project",
  "view.get",
  "view.search",
]);

type OperationPrincipal = {
  id: string;
  grants: string[];
};

export type PersonalizedExplorerOperationService = {
  execute(request: unknown, context: unknown): Promise<unknown>;
};

export type PersonalizedViewExplorerAcceptanceInput = {
  operations: PersonalizedExplorerOperationService;
  principal: OperationPrincipal;
  application_space: ExactViewRef;
  working_state: ExactViewRef;
  timeout_ms?: number;
};

export type PersonalizedViewExplorerAcceptanceEvidence = {
  contract_version: 1;
  graph_ready: true;
  exact_working_state_selected: true;
  accessible_dom_synchronized: true;
  node_count: number;
  edge_count: number;
  canvas_non_background_samples: number;
  canvas_unique_colors: number;
  operations: {
    view_graph_project: number;
    view_get: number;
    view_search: number;
  };
  browser_console_errors: 0;
  browser_console_warnings: 0;
  chromium_webgl_driver_warnings: number;
  retained_artifacts: false;
};

export class PersonalizedViewExplorerAcceptanceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: Readonly<Record<string, number | string | boolean>> = {},
  ) {
    super(message);
    this.name = "PersonalizedViewExplorerAcceptanceError";
  }
}

export async function runPersonalizedViewExplorerAcceptance(
  input: PersonalizedViewExplorerAcceptanceInput,
): Promise<PersonalizedViewExplorerAcceptanceEvidence> {
  requireExactRef(input.application_space, "application_space");
  requireExactRef(input.working_state, "working_state");
  if (!input.principal.id || input.principal.grants.length === 0) {
    throw new PersonalizedViewExplorerAcceptanceError(
      "Graph Explorer acceptance requires an authenticated principal with explicit grants",
      "explorer_principal_invalid",
    );
  }
  const timeout = input.timeout_ms ?? 20_000;
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 120_000) {
    throw new PersonalizedViewExplorerAcceptanceError(
      "Graph Explorer acceptance timeout is outside the supported range",
      "explorer_timeout_invalid",
      { timeout_ms: timeout },
    );
  }

  const cacheDirectory = await mkdtemp(join(tmpdir(), "metaflow-view-explorer-acceptance-"));
  const explorerRoot = fileURLToPath(new URL("../", import.meta.url));
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    vite = await createServer({
      root: explorerRoot,
      cacheDir: cacheDirectory,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, strictPort: true },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") {
      throw new PersonalizedViewExplorerAcceptanceError(
        "Vite did not expose an isolated TCP listener",
        "explorer_vite_listener_missing",
      );
    }
    browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
    const context = await browser.newContext({
      viewport: { width: 1_440, height: 900 },
      colorScheme: "light",
      locale: "en-US",
      timezoneId: "UTC",
      reducedMotion: "reduce",
    });
    try {
      const page = await context.newPage();
      const evidence = await verifyPersonalizedViewExplorerPage(
        page,
        input,
        timeout,
        `http://127.0.0.1:${address.port}`,
      );
      await page.close();
      return evidence;
    } finally {
      await context.close();
    }
  } finally {
    await browser?.close();
    await vite?.close();
    await rm(cacheDirectory, { recursive: true, force: true });
  }
}

async function verifyPersonalizedViewExplorerPage(
  page: Page,
  input: PersonalizedViewExplorerAcceptanceInput,
  timeout: number,
  baseUrl: string,
): Promise<PersonalizedViewExplorerAcceptanceEvidence> {
  const calls = new Map<ExplorerOperation, number>([
    ["view.graph.project", 0],
    ["view.get", 0],
    ["view.search", 0],
  ]);
  let consoleErrors = 0;
  let consoleWarnings = 0;
  let webglDriverWarnings = 0;
  page.on("console", message => {
    if (message.type() === "error") consoleErrors += 1;
    if (message.type() === "warning") {
      if (isChromiumReadPixelsWarning(message.text())) webglDriverWarnings += 1;
      else consoleWarnings += 1;
    }
  });
  page.on("pageerror", () => { consoleErrors += 1; });

  let failRoute!: (error: Error) => void;
  const routeFailure = new Promise<never>((_resolve, reject) => { failRoute = reject; });
  let requestSequence = 0;
  await page.route("**/metaflow/v1/operations/*", async route => {
    const request = route.request();
    const operationValue = decodeURIComponent(new URL(request.url()).pathname.split("/").at(-1) ?? "");
    if (request.method() !== "POST" || !EXPLORER_OPERATIONS.has(operationValue as ExplorerOperation)) {
      failRoute(new PersonalizedViewExplorerAcceptanceError(
        "View Explorer requested an operation outside its bounded surface",
        "explorer_operation_invalid",
      ));
      await route.abort("blockedbyclient").catch(() => undefined);
      return;
    }
    const operation = operationValue as ExplorerOperation;
    calls.set(operation, calls.get(operation)! + 1);
    try {
      const envelope = await input.operations.execute(
        { operation, input: request.postDataJSON() },
        {
          request_id: `request:personalized-view-explorer:${++requestSequence}`,
          principal: input.principal,
        },
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify(envelope),
      });
    } catch {
      failRoute(new PersonalizedViewExplorerAcceptanceError(
        "The injected OperationService failed while serving View Explorer",
        "explorer_operation_failed",
        { operation },
      ));
      await route.abort("failed").catch(() => undefined);
    }
  });

  const applicationSpaceKey = refKey(input.application_space);
  const workingStateKey = refKey(input.working_state);
  const url = new URL("/", baseUrl);
  url.searchParams.set("root", applicationSpaceKey);
  url.searchParams.set("selected", workingStateKey);

  await Promise.race([
    (async () => {
      await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout });
      await page.locator(".explorer-shell").waitFor({ state: "visible", timeout });
      await page.waitForFunction(() => {
        const shell = document.querySelector(".explorer-shell");
        const count = Number(shell?.getAttribute("data-node-count"));
        return shell?.getAttribute("data-layout-state") === "ready" && Number.isInteger(count) && count > 0;
      }, undefined, { timeout });
      await page.locator(".sigma-container canvas").first().waitFor({ state: "visible", timeout });
      await page.locator(".detail-heading code").waitFor({ state: "visible", timeout });
      await page.waitForFunction(expected => document.querySelector(".detail-heading code")?.textContent === expected, workingStateKey, { timeout });
    })(),
    routeFailure,
  ]);

  const state = await page.evaluate(({ applicationSpaceKey, workingStateKey }) => {
    const shell = document.querySelector(".explorer-shell");
    const listbox = document.querySelector('[role="listbox"]');
    const status = document.querySelector(".sr-status");
    const selected = document.querySelector(".detail-heading code");
    const debug = (window as typeof window & {
      __METAFLOW_EXPLORER__?: { graph?: { nodes?: number; edges?: number } };
    }).__METAFLOW_EXPLORER__;
    const nodeCount = Number(shell?.getAttribute("data-node-count"));
    const edgeText = document.querySelector(".canvas-stats span:nth-child(2)")?.textContent ?? "";
    const edgeCount = Number(edgeText.split(" ")[0]);
    return {
      nodeCount,
      edgeCount,
      debugNodes: debug?.graph?.nodes,
      debugEdges: debug?.graph?.edges,
      selected: selected?.textContent === workingStateKey,
      root: new URL(location.href).searchParams.get("root") === applicationSpaceKey,
      accessible: listbox?.getAttribute("aria-rowcount") === String(nodeCount)
        && status?.textContent?.startsWith(`${nodeCount} Views and ${edgeCount} relations.`) === true,
    };
  }, { applicationSpaceKey, workingStateKey });
  if (!state.root || !state.selected || !state.accessible
    || state.nodeCount < 1 || state.edgeCount < 1
    || state.debugNodes !== state.nodeCount || state.debugEdges !== state.edgeCount) {
    throw new PersonalizedViewExplorerAcceptanceError(
      "View Explorer browser state did not agree across URL, Sigma, details, and accessible DOM",
      "explorer_state_unsynchronized",
      {
        root: state.root,
        selected: state.selected,
        accessible: state.accessible,
        node_count: state.nodeCount,
        edge_count: state.edgeCount,
      },
    );
  }

  const pixels = await canvasPixels(page);
  await page.waitForTimeout(50);
  if (consoleErrors > 0 || consoleWarnings > 0) {
    throw new PersonalizedViewExplorerAcceptanceError(
      "View Explorer emitted browser console diagnostics",
      "explorer_browser_diagnostic",
      { errors: consoleErrors, warnings: consoleWarnings },
    );
  }
  if (pixels.nonBackgroundSamples <= 20 || pixels.uniqueColors <= 4) {
    throw new PersonalizedViewExplorerAcceptanceError(
      "Sigma canvas did not contain enough rendered graph pixels",
      "explorer_canvas_blank",
      {
        non_background_samples: pixels.nonBackgroundSamples,
        unique_colors: pixels.uniqueColors,
      },
    );
  }
  if ((calls.get("view.graph.project") ?? 0) < 1 || (calls.get("view.get") ?? 0) < 1) {
    throw new PersonalizedViewExplorerAcceptanceError(
      "View Explorer did not consume both graph projection and exact View Operations",
      "explorer_operations_missing",
    );
  }
  if ((calls.get("view.search") ?? 0) !== 0) {
    throw new PersonalizedViewExplorerAcceptanceError(
      "Exact-root Graph Explorer acceptance invoked Search unexpectedly",
      "explorer_search_unexpected",
      { calls: calls.get("view.search") ?? 0 },
    );
  }

  return {
    contract_version: 1,
    graph_ready: true,
    exact_working_state_selected: true,
    accessible_dom_synchronized: true,
    node_count: state.nodeCount,
    edge_count: state.edgeCount,
    canvas_non_background_samples: pixels.nonBackgroundSamples,
    canvas_unique_colors: pixels.uniqueColors,
    operations: {
      view_graph_project: calls.get("view.graph.project") ?? 0,
      view_get: calls.get("view.get") ?? 0,
      view_search: calls.get("view.search") ?? 0,
    },
    browser_console_errors: 0,
    browser_console_warnings: 0,
    chromium_webgl_driver_warnings: webglDriverWarnings,
    retained_artifacts: false,
  };
}

async function canvasPixels(page: Page): Promise<{ uniqueColors: number; nonBackgroundSamples: number }> {
  const screenshot = await page.locator(".sigma-container").screenshot({ animations: "disabled" });
  let image: PNG | undefined;
  try {
    image = PNG.sync.read(screenshot);
    const colors = new Set<string>();
    let nonBackgroundSamples = 0;
    for (let index = 0; index < image.data.length; index += 16) {
      const red = image.data[index]!;
      const green = image.data[index + 1]!;
      const blue = image.data[index + 2]!;
      const alpha = image.data[index + 3]!;
      colors.add(`${red},${green},${blue},${alpha}`);
      if (alpha > 0 && !(red > 225 && green > 225 && blue > 225)) nonBackgroundSamples += 1;
    }
    return { uniqueColors: colors.size, nonBackgroundSamples };
  } finally {
    screenshot.fill(0);
    image?.data.fill(0);
  }
}

function requireExactRef(ref: ExactViewRef, field: string): void {
  if (!ref.view_id.trim() || !Number.isInteger(ref.revision) || ref.revision < 1) {
    throw new PersonalizedViewExplorerAcceptanceError(
      "Graph Explorer acceptance requires exact positive-revision View refs",
      "explorer_exact_ref_invalid",
      { field },
    );
  }
}

function isChromiumReadPixelsWarning(message: string): boolean {
  return /^\[\.WebGL-[^\]]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels(?: \(this message will no longer repeat\))?$/u.test(message);
}
