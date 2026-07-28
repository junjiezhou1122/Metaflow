import type { RuntimeSenderAuthorization } from "./runtime-sender-policy";

const SELECTION_PROMPT_MESSAGE_TYPES = new Set([
  "sidepanel.explain.selection",
  "sidepanel.run.selection_action",
]);

export class SidepanelPromptQueue {
  private pending: unknown = null;

  async handle(
    message: unknown,
    authorization: RuntimeSenderAuthorization,
    sender: chrome.runtime.MessageSender,
    open: (tabId: number) => Promise<void>,
  ): Promise<unknown | undefined> {
    const type = runtimeMessageType(message);
    if (!SELECTION_PROMPT_MESSAGE_TYPES.has(type) && type !== "sidepanel.consume-pending-prompt") {
      return undefined;
    }
    if (!authorization.ok || authorization.principal !== "trusted-extension-page") {
      return {
        ok: false,
        code: "runtime_sender_forbidden",
        error: "The runtime sender is not authorized for this message type",
      };
    }
    if (type === "sidepanel.consume-pending-prompt") {
      const pending = this.pending;
      this.pending = null;
      return { ok: true, pending };
    }

    const input = message as Record<string, unknown>;
    this.pending = {
      type: "selection-action",
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      action: input.action ?? {
        id: "explain",
        label: "Explain",
        prompt: "Explain this selected text in plain language. Keep it concise, and mention the page context if it matters.",
      },
      payload: input.payload,
    };
    if (sender.tab?.id !== undefined) await open(sender.tab.id);
    return { ok: true, pending: this.pending };
  }
}

function runtimeMessageType(message: unknown): string {
  if (!message || typeof message !== "object" || Array.isArray(message)) return "";
  const type = (message as Record<string, unknown>).type;
  return typeof type === "string" ? type : "";
}
