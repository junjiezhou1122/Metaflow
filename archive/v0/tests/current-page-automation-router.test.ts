import test from "node:test";
import assert from "node:assert/strict";
import {
  routeAction,
  isSensitiveDomain,
  isSensitiveAction,
  createCurrentPageRouterProcessor,
  clearTraces,
} from "@info/processor-runtime";
import type { ActionRequest, ActionPolicy, RouterDecision } from "@info/processor-runtime";

// ─── Helper ──────────────────────────────────────────────────────────

function request(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    action: "click",
    domain: "example.com",
    domInsufficient: false,
    visionAvailable: false,
    advancedMode: false,
    openNewBrowser: false,
    ...overrides,
  };
}

function policy(overrides: Partial<ActionPolicy> = {}): ActionPolicy {
  return overrides;
}

// ─── DOM success path ────────────────────────────────────────────────

test("DOM success: default routing chooses dom tier when DOM is sufficient", () => {
  const decision = routeAction(request(), policy());
  assert.equal(decision.tier, "dom");
  assert.equal(decision.allowed, true);
  assert.equal(decision.sensitive, false);
  assert.ok(decision.reason.includes("DOM"));
});

test("DOM success: common actions like click, type, scroll route to dom", () => {
  for (const action of ["click", "type", "scroll", "read", "observe", "fill"]) {
    const decision = routeAction(request({ action }), policy());
    assert.equal(decision.tier, "dom", `expected dom tier for action "${action}"`);
    assert.equal(decision.allowed, true);
  }
});

// ─── Vision fallback ─────────────────────────────────────────────────

test("Vision fallback: when DOM insufficient and vision available, routes to vision", () => {
  const decision = routeAction(
    request({ domInsufficient: true, visionAvailable: true }),
    policy(),
  );
  assert.equal(decision.tier, "vision");
  assert.equal(decision.allowed, true);
  assert.equal(decision.sensitive, false);
  assert.ok(decision.reason.includes("vision"));
});

test("Vision fallback: when DOM insufficient but vision unavailable, does not route to vision", () => {
  const decision = routeAction(
    request({ domInsufficient: true, visionAvailable: false }),
    policy(),
  );
  assert.notEqual(decision.tier, "vision");
  assert.equal(decision.allowed, false);
});

test("Vision fallback: DOM still preferred even when vision is available", () => {
  const decision = routeAction(
    request({ domInsufficient: false, visionAvailable: true }),
    policy(),
  );
  assert.equal(decision.tier, "dom");
});

// ─── CDP disabled by default ────────────────────────────────────────

test("CDP: disabled by default — denied when DOM insufficient and no vision", () => {
  const decision = routeAction(
    request({ domInsufficient: true, visionAvailable: false }),
    policy(),
  );
  assert.equal(decision.allowed, false);
  assert.ok(decision.reason.includes("advancedMode") || decision.reason.includes("CDP"));
});

test("CDP: enabled when advancedMode is true", () => {
  const decision = routeAction(
    request({ domInsufficient: true, visionAvailable: false, advancedMode: true }),
    policy(),
  );
  assert.equal(decision.tier, "cdp");
  assert.equal(decision.allowed, true);
});

test("CDP: advancedMode propagates to CDP even when DOM is sufficient (CDP still available)", () => {
  // When advancedMode is on and DOM is sufficient, we still prefer DOM
  const decision = routeAction(
    request({ domInsufficient: false, advancedMode: true }),
    policy(),
  );
  assert.equal(decision.tier, "dom");
  assert.equal(decision.allowed, true);
});

test("CDP: policy allowCdpByDefault enables CDP without advancedMode", () => {
  const decision = routeAction(
    request({ domInsufficient: true, visionAvailable: false, advancedMode: false }),
    policy({ allowCdpByDefault: true }),
  );
  assert.equal(decision.tier, "cdp");
  assert.equal(decision.allowed, true);
});

// ─── Sensitive domain refusal ────────────────────────────────────────

test("Sensitive domain: bank.com is refused", () => {
  const decision = routeAction(request({ domain: "bank.com" }), policy());
  assert.equal(decision.allowed, false);
  assert.equal(decision.sensitive, true);
  assert.ok(decision.reason.includes("sensitive"));
});

test("Sensitive domain: health.example.com is refused", () => {
  const decision = routeAction(request({ domain: "health.example.com" }), policy());
  assert.equal(decision.allowed, false);
  assert.equal(decision.sensitive, true);
});

test("Sensitive domain: wellsfargo.com is refused", () => {
  const decision = routeAction(request({ domain: "wellsfargo.com" }), policy());
  assert.equal(decision.allowed, false);
  assert.equal(decision.sensitive, true);
});

test("Sensitive domain: www.chase.com is refused (strips www prefix)", () => {
  const decision = routeAction(request({ domain: "www.chase.com" }), policy());
  assert.equal(decision.allowed, false);
  assert.equal(decision.sensitive, true);
});

test("Sensitive domain: mychart.hospital.org is refused (contains 'mychart')", () => {
  const decision = routeAction(request({ domain: "mychart.hospital.org" }), policy());
  assert.equal(decision.allowed, false);
  assert.equal(decision.sensitive, true);
});

test("Non-sensitive domain: github.com is allowed", () => {
  const decision = routeAction(request({ domain: "github.com" }), policy());
  assert.equal(decision.allowed, true);
  assert.equal(decision.sensitive, false);
});

test("Non-sensitive domain: docs.google.com is allowed", () => {
  const decision = routeAction(request({ domain: "docs.google.com" }), policy());
  assert.equal(decision.allowed, true);
  assert.equal(decision.sensitive, false);
});

// ─── Sensitive action refusal ────────────────────────────────────────

test("Sensitive action: delete_account is refused", () => {
  const decision = routeAction(request({ action: "delete_account" }), policy());
  assert.equal(decision.allowed, false);
  assert.equal(decision.sensitive, true);
  assert.ok(decision.reason.includes("sensitive"));
});

test("Sensitive action: transfer_money is refused", () => {
  const decision = routeAction(request({ action: "transfer_money" }), policy());
  assert.equal(decision.allowed, false);
  assert.equal(decision.sensitive, true);
});

test("Sensitive action: change_password is refused", () => {
  const decision = routeAction(request({ action: "change_password" }), policy());
  assert.equal(decision.allowed, false);
  assert.equal(decision.sensitive, true);
});

test("Sensitive action: disable_security is refused", () => {
  const decision = routeAction(request({ action: "disable_security" }), policy());
  assert.equal(decision.allowed, false);
  assert.equal(decision.sensitive, true);
});

// ─── No new browser session ─────────────────────────────────────────

test("No new browser: openNewBrowser=true is always refused", () => {
  const decision = routeAction(
    request({ openNewBrowser: true, action: "click", domain: "example.com" }),
    policy(),
  );
  assert.equal(decision.allowed, false);
  assert.ok(decision.reason.includes("new browser"));
});

test("No new browser: refused even on non-sensitive domain with simple action", () => {
  const decision = routeAction(
    request({ openNewBrowser: true, action: "read" }),
    policy(),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.sensitive, false);
});

test("No new browser: normal request without openNewBrowser is allowed", () => {
  const decision = routeAction(request({ openNewBrowser: false }), policy());
  assert.equal(decision.allowed, true);
});

// ─── isSensitiveDomain / isSensitiveAction unit tests ────────────────

test("isSensitiveDomain: matches built-in sensitive patterns", () => {
  assert.equal(isSensitiveDomain("bank.com"), true);
  assert.equal(isSensitiveDomain("bank.example.com"), true);
  assert.equal(isSensitiveDomain("mychart.health.org"), true);
  assert.equal(isSensitiveDomain("github.com"), false);
  assert.equal(isSensitiveDomain("docs.example.com"), false);
});

test("isSensitiveDomain: respects extra patterns from policy", () => {
  assert.equal(isSensitiveDomain("internal-corp.com"), false);
  assert.equal(isSensitiveDomain("internal-corp.com", ["internal-corp"]), true);
});

test("isSensitiveAction: matches built-in sensitive actions", () => {
  assert.equal(isSensitiveAction("delete_account"), true);
  assert.equal(isSensitiveAction("transfer_money"), true);
  assert.equal(isSensitiveAction("click"), false);
  assert.equal(isSensitiveAction("scroll"), false);
});

test("isSensitiveAction: respects extra patterns from policy", () => {
  assert.equal(isSensitiveAction("nuke_database"), false);
  assert.equal(isSensitiveAction("nuke_database", ["nuke_database"]), true);
});

// ─── Processor definition ───────────────────────────────────────────

test("createCurrentPageRouterProcessor returns valid ProcessorDefinition", () => {
  const processor = createCurrentPageRouterProcessor();
  assert.equal(processor.id, "processor.current_page_router");
  assert.equal(processor.runtime.kind, "local");
  assert.ok(processor.consumes.observations?.some(p => p.includes("browser")));
  assert.ok(processor.produces.observations?.some(p => p.includes("current_page_router")));
});

// ─── Combined sensitive domain + action ──────────────────────────────

test("Combined: sensitive domain with sensitive action still refused (not double-counted)", () => {
  const decision = routeAction(
    request({ action: "transfer_money", domain: "bank.com" }),
    policy(),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.sensitive, true);
});

// ─── Trace recording ────────────────────────────────────────────────

test("clearTraces empties the global trace log", () => {
  clearTraces();
  // Just verifying it doesn't throw and the API works
  clearTraces();
});
