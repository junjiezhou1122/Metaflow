/**
 * Current-page automation router — selects the safest tool tier for
 * current-page browser actions.
 *
 * Priority: DOM > vision > CDP (debugger)
 * Policy: refuse sensitive domains and actions, never open new browser
 */
import type { ProcessorDefinition, ProcessorHandler } from "../types.js";

// ─── Public types ────────────────────────────────────────────────────

export type ToolTier = "dom" | "vision" | "cdp";

export type ActionRequest = {
  /** e.g. "click", "type", "scroll", "delete_account" */
  action: string;
  /** e.g. "bank.com", "github.com" */
  domain?: string;
  /** Set when DOM tools reported they cannot accomplish the action */
  domInsufficient?: boolean;
  /** True when VISION_LLM_* env vars are configured */
  visionAvailable?: boolean;
  /** Explicitly enable CDP / debugger tier */
  advancedMode?: boolean;
  /** If true, refuse and return denied decision */
  openNewBrowser?: boolean;
};

export type ActionPolicy = {
  /** Additional sensitive domain patterns to refuse */
  sensitiveDomains?: string[];
  /** Additional sensitive action patterns to refuse */
  sensitiveActions?: string[];
  /** Allow CDP tier even without advancedMode (default: false) */
  allowCdpByDefault?: boolean;
};

export type RouterDecision = {
  tier: ToolTier;
  allowed: boolean;
  reason: string;
  sensitive: boolean;
};

export type ActionTrace = {
  action: string;
  tier: ToolTier;
  outcome: "success" | "fallback" | "denied";
  durationMs: number;
};

// ─── Sensitive domain / action lists ─────────────────────────────────

const SENSITIVE_DOMAIN_PATTERNS: readonly string[] = [
  "bank",
  "banking",
  "chase",
  "wellsfargo",
  "citibank",
  "hsbc",
  "amex",
  "americanexpress",
  "capitalone",
  "schwab",
  "fidelity",
  "vanguard",
  "paypal",
  "venmo",
  "health",
  "medical",
  "mychart",
  "epic",
  "cigna",
  "aetna",
  "kaiser",
  "healthcare",
  "pharmacy",
  "rx",
];

const SENSITIVE_ACTION_PATTERNS: readonly string[] = [
  "delete_account",
  "transfer_money",
  "send_payment",
  "change_password",
  "reset_password",
  "remove_2fa",
  "disable_security",
  "authorize_transaction",
  "confirm_purchase",
  "submit_payment",
  "delete_data",
  "wipe_account",
  "grant_admin",
];

// ─── Core router ─────────────────────────────────────────────────────

/**
 * Route a current-page action to the safest available tool tier.
 *
 * 1. Refuse if a new browser session is requested.
 * 2. Refuse if the domain or action is sensitive.
 * 3. Prefer DOM tier (always).
 * 4. Fall back to vision only when DOM is insufficient AND vision is available.
 * 5. CDP / debugger requires explicit `advancedMode: true`.
 */
export function routeAction(
  request: ActionRequest,
  policy: ActionPolicy = {},
): RouterDecision {
  // 1. Never open a new browser for current-page ops
  if (request.openNewBrowser) {
    return {
      tier: "dom",
      allowed: false,
      reason: "Current-page automation must not open a new browser session",
      sensitive: false,
    };
  }

  // 2. Sensitive domain / action check
  const domainSensitive = request.domain
    ? isSensitiveDomain(request.domain, policy.sensitiveDomains)
    : false;
  const actionSensitive = isSensitiveAction(
    request.action,
    policy.sensitiveActions,
  );

  if (domainSensitive || actionSensitive) {
    return {
      tier: "dom",
      allowed: false,
      reason: domainSensitive
        ? `Domain "${request.domain}" is sensitive — action refused`
        : `Action "${request.action}" is sensitive — action refused`,
      sensitive: true,
    };
  }

  // 3. Prefer DOM
  if (!request.domInsufficient) {
    return {
      tier: "dom",
      allowed: true,
      reason: "DOM tools sufficient for this action",
      sensitive: false,
    };
  }

  // 4. Vision fallback (only when configured)
  if (request.domInsufficient && request.visionAvailable) {
    return {
      tier: "vision",
      allowed: true,
      reason: "DOM insufficient; falling back to vision tier",
      sensitive: false,
    };
  }

  // 5. CDP / debugger opt-in
  if (request.advancedMode || policy.allowCdpByDefault) {
    return {
      tier: "cdp",
      allowed: true,
      reason: "CDP tier enabled via advancedMode",
      sensitive: false,
    };
  }

  // 6. DOM insufficient, no vision available, CDP not opted-in — deny
  return {
    tier: "cdp",
    allowed: false,
    reason: "DOM insufficient, vision unavailable, and CDP not opted-in — enable advancedMode or configure VISION_LLM",
    sensitive: false,
  };
}

// ─── Sensitive helpers ───────────────────────────────────────────────

export function isSensitiveDomain(
  domain: string,
  extra?: string[],
): boolean {
  const normalized = domain.toLowerCase().replace(/^www\./, "");
  const allPatterns = [
    ...SENSITIVE_DOMAIN_PATTERNS,
    ...(extra ?? []),
  ].map(p => p.toLowerCase());

  return allPatterns.some(pattern => {
    // Match if the domain contains the pattern anywhere (handles subdomains)
    return normalized === pattern || normalized.endsWith(`.${pattern}`) || normalized.includes(pattern);
  });
}

export function isSensitiveAction(
  action: string,
  extra?: string[],
): boolean {
  const normalized = action.toLowerCase().trim();
  const allPatterns = [
    ...SENSITIVE_ACTION_PATTERNS,
    ...(extra ?? []),
  ].map(p => p.toLowerCase());

  return allPatterns.some(pattern => normalized === pattern || normalized.includes(pattern));
}

// ─── DOM availability check ─────────────────────────────────────────

/**
 * Check whether VISION_LLM env vars are present.
 * In production this reads `process.env`; the result is cached for the
 * process lifetime but can be overridden for tests via `visionAvailable`
 * on the ActionRequest.
 */
export function isVisionLlmConfigured(): boolean {
  return Boolean(
    process.env.VISION_LLM_API_KEY ||
    process.env.VISION_LLM_MODEL ||
    process.env.VISION_LLM_BASE_URL,
  );
}

// ─── Trace recorder ─────────────────────────────────────────────────

const globalTraceLog: ActionTrace[] = [];

export function recordTrace(trace: ActionTrace): void {
  globalTraceLog.push(trace);
}

/** Return all recorded traces (useful for diagnostics / testing). */
export function getTraces(): readonly ActionTrace[] {
  return globalTraceLog;
}

/** Clear the global trace log (for test isolation). */
export function clearTraces(): void {
  globalTraceLog.length = 0;
}

// ─── Processor definition ───────────────────────────────────────────

export const CURRENT_PAGE_ROUTER_PROCESSOR_ID =
  "processor.current_page_router";
export const CURRENT_PAGE_ROUTER_SCHEMA =
  "observation.current_page_router_decision";

export type CurrentPageRouterOptions = {
  now?: Date;
};

export function createCurrentPageRouterProcessor(
  options: CurrentPageRouterOptions = {},
): ProcessorDefinition {
  return {
    id: CURRENT_PAGE_ROUTER_PROCESSOR_ID,
    title: "Current-Page Automation Router",
    version: "0.0.1",
    description:
      "Routes current-page actions to the safest tool tier (DOM > vision > CDP) with policy enforcement.",
    consumes: {
      observations: ["observation.browser_*", "observation.editor.*"],
    },
    produces: { observations: [CURRENT_PAGE_ROUTER_SCHEMA] },
    runtime: { kind: "local" },
    policy: { speed: "reflex", autonomy: "draft", privacy: "private" },
    handler: currentPageRouterHandler(options),
  };
}

export function currentPageRouterHandler(
  _options: CurrentPageRouterOptions = {},
): ProcessorHandler {
  return (input) => {
    const observation = input.observation;
    if (!observation) return { observations: [] };

    const domain = observation.scope?.domain;
    const action = String(observation.payload?.action ?? "read");
    const domInsufficient = Boolean(observation.payload?.dom_insufficient);
    const visionAvailable = Boolean(observation.payload?.vision_available) || isVisionLlmConfigured();
    const advancedMode = Boolean(observation.payload?.advanced_mode);
    const openNewBrowser = Boolean(observation.payload?.open_new_browser);

    const decision = routeAction(
      { action, domain, domInsufficient, visionAvailable, advancedMode, openNewBrowser },
    );

    const now = _options.now ?? new Date();
    return {
      observations: [
        {
          id: `${CURRENT_PAGE_ROUTER_PROCESSOR_ID}:${observation.id}:${Date.now()}`,
          schema: { name: CURRENT_PAGE_ROUTER_SCHEMA, version: 1 },
          source: { type: "runtime", connector: CURRENT_PAGE_ROUTER_PROCESSOR_ID },
          scope: observation.scope,
          content: {
            title: `Router decision: ${decision.tier} ${decision.allowed ? "allowed" : "denied"}`,
            text: decision.reason,
          },
          time: { observed_at: now.toISOString(), captured_at: now.toISOString() },
          acquisition: { mode: "derived", actor: "system", reason: "current-page automation routing" },
          signal: { status: "candidate", confidence: decision.allowed ? 0.9 : 0.1 },
          privacy: { level: "private", retention: "ephemeral" },
          memory: { kind: "observation", stability: "ephemeral" },
          payload: {
            source_observation_id: observation.id,
            decision,
            action,
            domain,
          },
        },
      ],
      diagnostics: { tier: decision.tier, allowed: decision.allowed, reason: decision.reason },
    };
  };
}
