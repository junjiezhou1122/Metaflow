export const CONTENT_SCRIPT_RUNTIME_MESSAGE_TYPES = Object.freeze([
  "context.capture.browser_attention",
  "context.capture.writing_input",
  "automation.browser.signal",
  "youtube-comprehension-gap",
  "youtube-observation",
  "language.caption_gap.recent",
] as const);

export const PRIVILEGED_RUNTIME_MESSAGE_TYPES = Object.freeze([
  "context.explain.selection",
  "save-current-page",
  "ambient-current-page",
  "feedback-view",
  "poll-ambient-deliveries",
  "ambient-delivery-interaction",
  "get-ambient-exact-view",
  "poll-context-views",
  "list-ambient-tasks",
  "agent-tasks",
  "agent-task-action",
  "trigger-ambient",
  "get-current-status",
  "update-info-capture-settings",
  "retry-browser-capture",
  "list-browser-capture-failures",
  "selection-actions.get",
  "language.caption_gap.sync",
  "sidepanel.explain.selection",
  "sidepanel.run.selection_action",
  "sidepanel.consume-pending-prompt",
] as const);

export const ALL_RUNTIME_MESSAGE_TYPES = Object.freeze([
  ...CONTENT_SCRIPT_RUNTIME_MESSAGE_TYPES,
  ...PRIVILEGED_RUNTIME_MESSAGE_TYPES,
] as const);

type RuntimeSenderPolicyEnvironment = {
  extensionId: string;
  extensionRoot: string;
};

export type RuntimeSenderAuthorization = {
  ok: true;
  principal: "trusted-background" | "trusted-extension-page" | "content-script";
} | {
  ok: false;
  code: "runtime_sender_forbidden";
  error: string;
};

const contentScriptMessages = new Set<string>(CONTENT_SCRIPT_RUNTIME_MESSAGE_TYPES);
const privilegedMessages = new Set<string>(PRIVILEGED_RUNTIME_MESSAGE_TYPES);

const trustedBackgroundSenderMarker = Symbol("metaflow.trusted-background-runtime-sender");

// Runtime messages cannot forge this module-private symbol; object spread keeps it when a tab is attached.
export const TRUSTED_BACKGROUND_RUNTIME_SENDER = Object.freeze({
  [trustedBackgroundSenderMarker]: true,
}) as chrome.runtime.MessageSender;

export function authorizeRuntimeMessageSender(
  message: unknown,
  sender: chrome.runtime.MessageSender,
  environment: RuntimeSenderPolicyEnvironment = chromeRuntimeSenderPolicyEnvironment(),
): RuntimeSenderAuthorization {
  const type = runtimeMessageType(message);
  const principal = runtimeSenderPrincipal(sender, environment);
  const allowed = principal === "trusted-background"
    || (principal === "trusted-extension-page" && (contentScriptMessages.has(type) || privilegedMessages.has(type)))
    || (principal === "content-script" && contentScriptMessages.has(type));
  if (allowed) return { ok: true, principal };
  return {
    ok: false,
    code: "runtime_sender_forbidden",
    error: "The runtime sender is not authorized for this message type",
  };
}

export function isTrustedExtensionPage(
  sender: chrome.runtime.MessageSender,
  environment: RuntimeSenderPolicyEnvironment = chromeRuntimeSenderPolicyEnvironment(),
): boolean {
  return runtimeSenderPrincipal(sender, environment) === "trusted-extension-page";
}

export function projectRuntimeMessageResult(
  authorization: Extract<RuntimeSenderAuthorization, { ok: true }>,
  result: unknown,
): unknown {
  if (authorization.principal !== "content-script") return result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { ok: false, code: "runtime_response_invalid", error: "Capture or interaction response is invalid" };
  }
  const response = result as Record<string, unknown>;
  return {
    ok: response.ok === true,
    ...(typeof response.status === "number" ? { status: response.status } : {}),
    ...(typeof response.code === "string" ? { code: response.code } : {}),
    ...(typeof response.stored === "boolean" ? { stored: response.stored } : {}),
    ...(typeof response.reason === "string" ? { reason: response.reason } : {}),
    ...(typeof response.event_id === "string" ? { event_id: response.event_id } : {}),
    ...(response.ok === true ? {} : { error: "Capture or interaction failed" }),
  };
}

function runtimeSenderPrincipal(
  sender: chrome.runtime.MessageSender,
  environment: RuntimeSenderPolicyEnvironment,
): "trusted-background" | "trusted-extension-page" | "content-script" | "untrusted" {
  if ((sender as unknown as Record<PropertyKey, unknown>)[trustedBackgroundSenderMarker] === true) {
    return "trusted-background";
  }
  if (sender.id !== environment.extensionId || typeof sender.url !== "string") return "untrusted";
  if (sender.url.startsWith(environment.extensionRoot)) return "trusted-extension-page";
  if (sender.tab?.id !== undefined && isContentScriptUrl(sender.url)) return "content-script";
  return "untrusted";
}

function runtimeMessageType(message: unknown): string {
  if (!message || typeof message !== "object" || Array.isArray(message)) return "";
  const type = (message as { type?: unknown }).type;
  return typeof type === "string" ? type : "";
}

function isContentScriptUrl(rawUrl: string): boolean {
  try {
    return ["http:", "https:", "file:"].includes(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

function chromeRuntimeSenderPolicyEnvironment(): RuntimeSenderPolicyEnvironment {
  return {
    extensionId: chrome.runtime.id,
    extensionRoot: chrome.runtime.getURL(""),
  };
}
