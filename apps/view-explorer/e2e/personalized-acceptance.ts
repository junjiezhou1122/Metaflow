import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import { createServer as createViteServer } from "vite";
import {
  OperationEnvelopeSchema,
  ViewRevisionSchema,
  refKey,
  type ExactViewRef,
  type ExplorerOperation,
  type View,
} from "../src/contracts.js";
import type { PersonalizedRendererAcceptanceEvidence } from "./personalized-renderer-acceptance.js";

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
  content_assertion?: {
    renderer: string;
    texts: readonly string[];
  };
  screenshot_path?: string;
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
  renderer: PersonalizedRendererAcceptanceEvidence;
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
    options?: ErrorOptions,
  ) {
    super(message, options);
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
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  let http: HttpServer | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    http = createHttpServer();
    vite = await createViteServer({
      root: explorerRoot,
      cacheDir: cacheDirectory,
      logLevel: "silent",
      appType: "spa",
      server: {
        middlewareMode: { server: http },
        ws: { server: http },
      },
    });
    http.on("request", vite.middlewares);
    await listenOnEphemeralPort(http);
    const address = http.address();
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
    try {
      await vite?.waitForRequestsIdle();
    } finally {
      try {
        await browser?.close();
      } finally {
        try {
          await closeHttpServer(http);
        } finally {
          try {
            await vite?.close();
          } finally {
            await rm(cacheDirectory, { recursive: true, force: true });
          }
        }
      }
    }
  }
}

async function listenOnEphemeralPort(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

async function closeHttpServer(server?: HttpServer): Promise<void> {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
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
  const browserFailures: string[] = [];
  page.on("console", message => {
    if (message.type() === "error") {
      consoleErrors += 1;
      retainFailure(browserFailures, `console:${message.text()}`);
    }
    if (message.type() === "warning") {
      if (isChromiumReadPixelsWarning(message.text())) webglDriverWarnings += 1;
      else {
        consoleWarnings += 1;
        retainFailure(browserFailures, `warning:${message.text()}`);
      }
    }
  });
  page.on("pageerror", error => {
    consoleErrors += 1;
    retainFailure(browserFailures, `pageerror:${error.message}`);
  });
  page.on("requestfailed", request => {
    retainFailure(browserFailures, `requestfailed:${request.resourceType()}:${request.url()}:${request.failure()?.errorText ?? "unknown"}`);
  });
  page.on("response", response => {
    if (response.status() >= 400) retainFailure(browserFailures, `response:${response.status()}:${response.url()}`);
  });

  let failRoute!: (error: Error) => void;
  const routeFailure = new Promise<never>((_resolve, reject) => { failRoute = reject; });
  let requestSequence = 0;
  let exactWorkingStateView: View | undefined;
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
      const operationInput: unknown = request.postDataJSON();
      validateExactOperationInput(operation, operationInput, input);
      const envelope = await input.operations.execute(
        { operation, input: operationInput },
        {
          request_id: `request:personalized-view-explorer:${++requestSequence}`,
          principal: input.principal,
        },
      );
      if (operation === "view.get") {
        exactWorkingStateView = validateExactViewGetResponse(envelope, input.working_state);
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify(envelope),
      });
    } catch (error) {
      failRoute(error instanceof PersonalizedViewExplorerAcceptanceError ? error
        : new PersonalizedViewExplorerAcceptanceError(
          "The injected OperationService failed while serving View Explorer",
          "explorer_operation_failed",
          { operation },
          { cause: error },
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
      try {
        await page.waitForFunction(() => {
          const shell = document.querySelector(".explorer-shell");
          const count = Number(shell?.getAttribute("data-node-count"));
          const state = shell?.getAttribute("data-layout-state");
          return state === "failed" || (state === "ready" && Number.isInteger(count) && count > 0);
        }, undefined, { timeout });
      } catch (error) {
        throw await layoutAcceptanceError(page, "Graph layout did not reach a terminal state", browserFailures, error);
      }
      if (await page.locator(".explorer-shell").getAttribute("data-layout-state") !== "ready") {
        throw await layoutAcceptanceError(page, "Graph layout failed before View Explorer became ready", browserFailures);
      }
      await page.locator(".sigma-container canvas").first().waitFor({ state: "visible", timeout });
      await page.locator(".detail-heading code").waitFor({ state: "visible", timeout });
      await page.waitForFunction(expected => document.querySelector(".detail-heading code")?.textContent === expected, workingStateKey, { timeout });
      if (input.content_assertion) {
        const content = page.locator(`[data-renderer="${input.content_assertion.renderer}"]`);
        await content.waitFor({ state: "visible", timeout });
        for (const expectedText of input.content_assertion.texts) {
          await content.getByText(expectedText, { exact: false }).first().waitFor({ state: "visible", timeout });
        }
      }
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
  if (!exactWorkingStateView) {
    throw new PersonalizedViewExplorerAcceptanceError(
      "View Explorer did not return the authorized exact working-state View",
      "explorer_exact_view_response_missing",
    );
  }

  const renderer = await runRendererAcceptance(page, baseUrl, exactWorkingStateView);
  if (input.screenshot_path) {
    await page.screenshot({ path: input.screenshot_path, fullPage: true, animations: "disabled" });
  }
  await page.waitForTimeout(50);
  if (consoleErrors > 0 || consoleWarnings > 0) {
    throw new PersonalizedViewExplorerAcceptanceError(
      "View Explorer or Web Renderer emitted browser console diagnostics",
      "explorer_browser_diagnostic",
      { errors: consoleErrors, warnings: consoleWarnings },
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
    renderer,
    browser_console_errors: 0,
    browser_console_warnings: 0,
    chromium_webgl_driver_warnings: webglDriverWarnings,
    retained_artifacts: false,
  };
}

async function layoutAcceptanceError(
  page: Page,
  message: string,
  browserFailures: readonly string[],
  cause?: unknown,
): Promise<PersonalizedViewExplorerAcceptanceError> {
  const diagnostics = await page.evaluate(() => {
    const shell = document.querySelector(".explorer-shell");
    const failure = document.querySelector<HTMLElement>("[role='alert']");
    return {
      state: shell?.getAttribute("data-layout-state") ?? "missing",
      node_count: shell?.getAttribute("data-node-count") ?? "missing",
      failure_code: failure?.dataset.errorCode ?? "missing",
      failure_message: failure?.innerText.trim().slice(0, 500) ?? "missing",
    };
  });
  return new PersonalizedViewExplorerAcceptanceError(
    message,
    "explorer_layout_not_ready",
    {
      layout_state: diagnostics.state,
      node_count: diagnostics.node_count,
      failure_code: diagnostics.failure_code,
      failure_message: diagnostics.failure_message,
      browser_failures: browserFailures.join(" | ").slice(0, 2_000) || "none",
    },
    cause === undefined ? undefined : { cause },
  );
}

function retainFailure(failures: string[], value: string): void {
  if (failures.length < 20) failures.push(value.slice(0, 1_000));
}

function validateExactOperationInput(
  operation: ExplorerOperation,
  value: unknown,
  expected: Pick<PersonalizedViewExplorerAcceptanceInput, "application_space" | "working_state">,
): void {
  if (operation === "view.graph.project") {
    const roots = asRecord(asRecord(value)?.request)?.roots;
    if (!Array.isArray(roots) || roots.length !== 1 || !sameExactRef(roots[0], expected.application_space)) {
      throw new PersonalizedViewExplorerAcceptanceError(
        "View Explorer graph projection must use the supplied exact Application Space as its sole root",
        "explorer_graph_root_mismatch",
        { expected_root: refKey(expected.application_space) },
      );
    }
  }
  if (operation === "view.get") {
    const ref = asRecord(value)?.ref;
    if (!sameExactRef(ref, expected.working_state)) {
      throw new PersonalizedViewExplorerAcceptanceError(
        "View Explorer exact read did not request the supplied working-state revision",
        "explorer_view_get_ref_mismatch",
        { expected_ref: refKey(expected.working_state) },
      );
    }
  }
}

function validateExactViewGetResponse(value: unknown, expected: ExactViewRef): View {
  const envelope = OperationEnvelopeSchema.safeParse(value);
  if (!envelope.success || !envelope.data.ok || envelope.data.operation !== "view.get") {
    throw new PersonalizedViewExplorerAcceptanceError(
      "View Explorer exact read did not return a successful view.get envelope",
      "explorer_view_get_response_invalid",
    );
  }
  const view = ViewRevisionSchema.safeParse(envelope.data.data);
  if (!view.success) {
    throw new PersonalizedViewExplorerAcceptanceError(
      "View Explorer exact read returned an invalid View revision",
      "explorer_view_get_response_invalid",
      { issue_count: view.error.issues.length },
    );
  }
  if (view.data.id !== expected.view_id || view.data.revision !== expected.revision) {
    throw new PersonalizedViewExplorerAcceptanceError(
      "View Explorer exact read returned a different View revision",
      "explorer_view_get_response_mismatch",
      { expected_ref: refKey(expected), actual_ref: `${view.data.id}@${view.data.revision}` },
    );
  }
  return view.data;
}

async function runRendererAcceptance(
  page: Page,
  baseUrl: string,
  view: View,
): Promise<PersonalizedRendererAcceptanceEvidence> {
  const screenpipe = view.schema.name === "metaflow.screenpipe.timeline" || view.schema.name === "metaflow.screenpipe.audio";
  const moduleUrl = new URL(screenpipe
    ? "/e2e/screenpipe-renderer-acceptance.ts"
    : "/e2e/personalized-renderer-acceptance.ts", baseUrl).toString();
  const authorizedViewJson = JSON.stringify(view);
  return page.evaluate<PersonalizedRendererAcceptanceEvidence, {
    rendererModuleUrl: string;
    authorizedViewJson: string;
  }>(async ({ rendererModuleUrl, authorizedViewJson: serializedView }) => {
    const rendererModule = await import(rendererModuleUrl) as {
      runPersonalizedRendererAcceptance?(value: unknown): Promise<PersonalizedRendererAcceptanceEvidence>;
      runScreenpipeRendererAcceptance?(value: unknown): Promise<PersonalizedRendererAcceptanceEvidence>;
    };
    const run = rendererModule.runScreenpipeRendererAcceptance ?? rendererModule.runPersonalizedRendererAcceptance;
    if (!run) throw new Error("Renderer acceptance module did not export a supported runner");
    return run(JSON.parse(serializedView));
  }, { rendererModuleUrl: moduleUrl, authorizedViewJson });
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sameExactRef(value: unknown, expected: ExactViewRef): boolean {
  const ref = asRecord(value);
  return ref?.view_id === expected.view_id && ref.revision === expected.revision
    && Object.keys(ref).length === 2;
}

function isChromiumReadPixelsWarning(message: string): boolean {
  return /^\[\.WebGL-[^\]]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels(?: \(this message will no longer repeat\))?$/u.test(message);
}
