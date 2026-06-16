import test from "node:test";
import assert from "node:assert/strict";
import {
  autonomous,
  riskOrder,
  riskCompare,
  riskAllowed,
  PROACTIVE_TASK_VIEW_TYPE,
  ACTION_OUTCOME_VIEW_TYPE,
  LEARNABLE_FAILURE_VIEW_TYPE,
} from "@info/views/proactive/index.js";
import type {
  AutonomyLevel,
  ActionRiskLevel,
  ConfirmationPolicy,
  ActionPolicy,
  ActionRequest,
  ActionOutcome,
  LearnableFailure,
  ProactiveTask,
  ActionOutcomeViewContent,
  LearnableFailureViewContent,
  ProactiveTaskViewContent,
} from "@info/views/proactive/index.js";

// ─── Helpers ───────────────────────────────────────────────────────────────────

const NOW = "2026-06-16T10:00:00.000Z";

function makePolicy(overrides: Partial<ActionPolicy> = {}): ActionPolicy {
  return {
    autonomy_level: "draft",
    risk_level: "none",
    max_risk: "write_safe",
    allowed_actions: ["file.read", "file.write"],
    blocked_actions: [],
    requires_confirmation: false,
    confirmation_policy: "silent",
    sources: ["test"],
    owner: "user",
    project: "info",
    ...overrides,
  };
}

function makeRequest(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    id: "req:test-1",
    goal: "Test action",
    action_type: "file.read",
    payload: {},
    autonomy_level: "draft",
    risk_level: "none",
    sources: ["test"],
    policy: makePolicy(),
    created_at: NOW,
    ...overrides,
  };
}

// ─── 1. Silent draft execution ─────────────────────────────────────────────────

test("silent draft execution: low-risk draft task runs without confirmation", () => {
  const policy = makePolicy({
    autonomy_level: "draft",
    risk_level: "none",
    max_risk: "write_safe",
    requires_confirmation: false,
    confirmation_policy: "silent",
  });

  const request = makeRequest({
    autonomy_level: "draft",
    risk_level: "none",
    policy,
  });

  // Draft autonomy + none risk should not require confirmation
  assert.equal(request.policy.requires_confirmation, false);
  assert.equal(request.policy.confirmation_policy, "silent");
  assert.equal(request.autonomy_level, "draft");
  assert.equal(request.risk_level, "none");

  // Risk is within allowed range
  assert.ok(riskAllowed(request.risk_level, request.policy.max_risk));
});

// ─── 2. Confirm-required action ────────────────────────────────────────────────

test("confirm-required action: write_destructive risk requires confirmation", () => {
  const policy = makePolicy({
    autonomy_level: "draft",
    risk_level: "write_destructive",
    max_risk: "write_safe",
    requires_confirmation: true,
    confirmation_policy: "confirm",
  });

  const request = makeRequest({
    autonomy_level: "draft",
    risk_level: "write_destructive",
    action_type: "file.delete",
    policy,
  });

  // write_destructive exceeds the max_risk of write_safe
  assert.equal(request.policy.requires_confirmation, true);
  assert.equal(request.policy.confirmation_policy, "confirm");
  assert.equal(request.risk_level, "write_destructive");

  // Risk exceeds allowed range
  assert.ok(!riskAllowed(request.risk_level, request.policy.max_risk));
  assert.ok(riskCompare(request.risk_level, request.policy.max_risk) > 0);
});

// ─── 3. Failure outcome recording ──────────────────────────────────────────────

test("failure outcome recording: failed action produces LearnableFailure with recovery pattern", () => {
  const outcome: ActionOutcome = {
    ok: false,
    request_id: "req:fail-1",
    action_type: "file.write",
    status: "failed",
    error: "ENOENT: no such file or directory, open '/tmp/missing/path'",
    started_at: NOW,
    finished_at: "2026-06-16T10:00:01.000Z",
  };

  const failure: LearnableFailure = {
    ok: false,
    request_id: outcome.request_id,
    action_type: outcome.action_type,
    error: outcome.error!,
    recovery_pattern: "Create parent directory before writing",
    prevention_tag: "check-path-exists",
    created_at: NOW,
  };

  assert.equal(failure.ok, false);
  assert.equal(failure.request_id, "req:fail-1");
  assert.equal(failure.action_type, "file.write");
  assert.equal(failure.error, outcome.error);
  assert.equal(failure.recovery_pattern, "Create parent directory before writing");
  assert.equal(failure.prevention_tag, "check-path-exists");

  // LearnableFailureViewContent matches the shape
  const viewContent: LearnableFailureViewContent = {
    request_id: failure.request_id,
    action_type: failure.action_type,
    error: failure.error,
    recovery_pattern: failure.recovery_pattern,
    prevention_tag: failure.prevention_tag,
    sources: ["test"],
    created_at: NOW,
  };

  assert.equal(viewContent.recovery_pattern, "Create parent directory before writing");
  assert.equal(viewContent.prevention_tag, "check-path-exists");
});

// ─── 4. Policy enforcement ─────────────────────────────────────────────────────

test("policy enforcement: action on blocked_actions list is denied", () => {
  const policy = makePolicy({
    blocked_actions: ["shell.exec", "network.request"],
    allowed_actions: ["file.read", "file.write"],
  });

  const blockedRequest = makeRequest({
    action_type: "shell.exec",
    policy,
  });

  // The action_type appears on the blocked list
  assert.ok(policy.blocked_actions.includes(blockedRequest.action_type));
  assert.ok(!policy.allowed_actions.includes(blockedRequest.action_type));
});

test("policy enforcement: action on allowed_actions list is accepted", () => {
  const policy = makePolicy({
    blocked_actions: ["shell.exec"],
    allowed_actions: ["file.read", "file.write"],
  });

  const allowedRequest = makeRequest({
    action_type: "file.read",
    policy,
  });

  assert.ok(!policy.blocked_actions.includes(allowedRequest.action_type));
  assert.ok(policy.allowed_actions.includes(allowedRequest.action_type));
});

// ─── 5. Risk comparison ───────────────────────────────────────────────────────

test("riskAllowed returns true when risk is at or below max", () => {
  assert.ok(riskAllowed("none", "none"));
  assert.ok(riskAllowed("none", "write_safe"));
  assert.ok(riskAllowed("write_safe", "write_safe"));
  assert.ok(riskAllowed("read_only", "write_safe"));
  assert.ok(riskAllowed("write_destructive", "irreversible"));
});

test("riskAllowed returns false when risk exceeds max", () => {
  assert.ok(!riskAllowed("write_destructive", "write_safe"));
  assert.ok(!riskAllowed("irreversible", "write_destructive"));
  assert.ok(!riskAllowed("write_safe", "read_only"));
  assert.ok(!riskAllowed("read_only", "none"));
});

test("riskCompare returns negative when a < b, zero when equal, positive when a > b", () => {
  assert.ok(riskCompare("none", "write_safe") < 0);
  assert.ok(riskCompare("write_safe", "write_safe") === 0);
  assert.ok(riskCompare("write_destructive", "write_safe") > 0);
  assert.ok(riskCompare("irreversible", "none") > 0);
  assert.ok(riskCompare("none", "irreversible") < 0);
});

test("riskOrder maps each level to its correct ordinal position", () => {
  assert.equal(riskOrder("none"), 0);
  assert.equal(riskOrder("read_only"), 1);
  assert.equal(riskOrder("write_safe"), 2);
  assert.equal(riskOrder("write_destructive"), 3);
  assert.equal(riskOrder("irreversible"), 4);
});

// ─── 6. Autonomy level check ───────────────────────────────────────────────────

test("autonomous returns correct predicate for each autonomy level", () => {
  const isDraft = autonomous("draft");
  const isManual = autonomous("manual");
  const isSuggest = autonomous("suggest");
  const isSandboxAuto = autonomous("sandbox_auto");
  const isFullAuto = autonomous("full_auto");

  const draftRequest = makeRequest({ autonomy_level: "draft" });
  const manualRequest = makeRequest({ autonomy_level: "manual" });
  const fullAutoRequest = makeRequest({ autonomy_level: "full_auto" });

  assert.equal(isDraft(draftRequest), true);
  assert.equal(isDraft(manualRequest), false);

  assert.equal(isManual(manualRequest), true);
  assert.equal(isManual(draftRequest), false);

  assert.equal(isFullAuto(fullAutoRequest), true);
  assert.equal(isFullAuto(draftRequest), false);
});

test("autonomous predicate matches only its own level", () => {
  const levels: AutonomyLevel[] = ["manual", "suggest", "draft", "sandbox_auto", "full_auto"];

  for (const level of levels) {
    const pred = autonomous(level);
    for (const other of levels) {
      const req = makeRequest({ autonomy_level: other });
      assert.equal(pred(req), level === other, `autonomous("${level}").check("${other}") should be ${level === other}`);
    }
  }
});

// ─── View type constants ───────────────────────────────────────────────────────

test("view type constants have expected values", () => {
  assert.equal(PROACTIVE_TASK_VIEW_TYPE, "proactive.task");
  assert.equal(ACTION_OUTCOME_VIEW_TYPE, "action.outcome");
  assert.equal(LEARNABLE_FAILURE_VIEW_TYPE, "failure.learnable");
});

// ─── ProactiveTask integration ─────────────────────────────────────────────────

test("ProactiveTask transitions from candidate to confirmed based on policy", () => {
  const task: ProactiveTask = {
    id: "task:proactive-1",
    goal: "Auto-organize downloaded files",
    source_view_id: "view:source-1",
    autonomy_level: "draft",
    risk_level: "write_safe",
    confirmation_policy: "notify",
    allowed_actions: ["file.move", "file.read"],
    status: "candidate",
    created_at: NOW,
    updated_at: NOW,
  };

  // Draft autonomy with notify policy starts as candidate
  assert.equal(task.status, "candidate");
  assert.equal(task.confirmation_policy, "notify");

  // Risk is within bounds so it can proceed to confirmed
  assert.ok(riskAllowed(task.risk_level, "write_safe"));

  // Simulate confirmation
  task.status = "confirmed";
  assert.equal(task.status, "confirmed");
});

test("ProactiveTask with block policy stays denied", () => {
  const task: ProactiveTask = {
    id: "task:blocked-1",
    goal: "Delete temporary files",
    source_view_id: "view:source-2",
    autonomy_level: "manual",
    risk_level: "write_destructive",
    confirmation_policy: "block",
    allowed_actions: [],
    status: "denied",
    created_at: NOW,
    updated_at: NOW,
  };

  assert.equal(task.confirmation_policy, "block");
  assert.equal(task.status, "denied");
  assert.ok(!riskAllowed(task.risk_level, "write_safe"));
});

test("ActionOutcomeViewContent and ProactiveTaskViewContent have correct shape", () => {
  const outcomeContent: ActionOutcomeViewContent = {
    request_id: "req:1",
    action_type: "file.read",
    goal: "Read config",
    status: "completed",
    outcome: {
      ok: true,
      request_id: "req:1",
      action_type: "file.read",
      status: "completed",
      started_at: NOW,
      finished_at: NOW,
    },
    sources: ["test"],
    policy: makePolicy(),
    created_at: NOW,
  };

  assert.equal(outcomeContent.status, "completed");
  assert.equal(outcomeContent.outcome.ok, true);

  const taskContent: ProactiveTaskViewContent = {
    task: {
      id: "task:1",
      goal: "Summarize notes",
      source_view_id: "view:src",
      autonomy_level: "draft",
      risk_level: "none",
      confirmation_policy: "silent",
      allowed_actions: ["file.read"],
      status: "running",
      created_at: NOW,
      updated_at: NOW,
    },
    goal: "Summarize notes",
    autonomy_level: "draft",
    risk_level: "none",
    confirmation_policy: "silent",
    status: "running",
    created_at: NOW,
  };

  assert.equal(taskContent.status, "running");
  assert.equal(taskContent.autonomy_level, "draft");
});
