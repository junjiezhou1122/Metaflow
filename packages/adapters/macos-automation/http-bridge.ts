import {
  AutomationDeliveryError,
  AutomationDeliveryInteractionSchema,
  type AutomationDeliveryCoordinator,
  type AutomationDeliveryLedger,
} from "@info/automation";
import type { ViewRepository } from "@info/view";
import type { BrowserDomRequestBroker } from "./browser-context.js";
import type { MacAutomationController } from "./controller.js";
import type { MacDeliveryMailbox } from "./delivery.js";

export type MacAutomationHttpBridgeOptions = {
  controller: Pick<MacAutomationController, "submit">;
  mailbox: Pick<MacDeliveryMailbox, "list">;
  delivery: Pick<AutomationDeliveryCoordinator, "interact">;
  ledger: Pick<AutomationDeliveryLedger, "findByDeliveryId">;
  views: Pick<ViewRepository, "get">;
  browser_context: Pick<BrowserDomRequestBroker, "list" | "respond" | "fail">;
};

export class MacAutomationHttpBridge {
  constructor(private readonly options: MacAutomationHttpBridgeOptions) {}

  submit(input: unknown) {
    return this.options.controller.submit(input);
  }

  listDeliveries(input: { after?: string; limit?: number }) {
    return this.options.mailbox.list(input);
  }

  listBrowserContextRequests() {
    return this.options.browser_context.list();
  }

  respondBrowserContext(input: unknown) {
    if (isObject(input) && input.status === "failed") {
      const requestId = requiredText(input.request_id, "request_id");
      const code = requiredText(input.code, "code");
      const message = requiredText(input.message, "message");
      this.options.browser_context.fail({ request_id: requestId, code, message });
      return { request_id: requestId, status: "failed" as const };
    }
    const response = this.options.browser_context.respond(input);
    return { request_id: response.request_id, status: "accepted" as const };
  }

  async interact(input: unknown) {
    const parsed = AutomationDeliveryInteractionSchema.safeParse(input);
    if (!parsed.success) {
      throw new AutomationDeliveryError("invalid macOS Delivery interaction", "invalid_interaction", { cause: parsed.error });
    }
    const interaction = parsed.data;
    const entry = await this.options.ledger.findByDeliveryId(interaction.delivery_id);
    if (!entry || entry.result.status !== "delivered") {
      throw new AutomationDeliveryError(`unknown macOS delivery: ${interaction.delivery_id}`, "unknown_delivery");
    }
    const automation = await this.options.views.get(entry.request.automation);
    if (!automation) {
      throw new AutomationDeliveryError(
        `Automation View is missing for macOS interaction: ${entry.request.automation.view_id}@${entry.request.automation.revision}`,
        "unknown_delivery",
      );
    }
    return this.options.delivery.interact({ interaction, policy: automation.policy });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Browser context failure requires ${field}`);
  return value;
}
