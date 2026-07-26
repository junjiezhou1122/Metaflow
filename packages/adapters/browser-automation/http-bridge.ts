import {
  AutomationDeliveryInteractionSchema,
  AutomationDeliveryError,
  type AutomationDeliveryCoordinator,
  type AutomationDeliveryLedger,
} from "@info/automation";
import type { ViewRepository } from "@info/view";
import type { BrowserAutomationController } from "./controller.js";
import type { BrowserDeliveryMailbox } from "./delivery.js";

export type BrowserAutomationHttpBridgeOptions = {
  controller: Pick<BrowserAutomationController, "submit">;
  mailbox: Pick<BrowserDeliveryMailbox, "list">;
  delivery: Pick<AutomationDeliveryCoordinator, "interact">;
  ledger: Pick<AutomationDeliveryLedger, "findByDeliveryId">;
  views: Pick<ViewRepository, "get">;
};

export class BrowserAutomationHttpBridge {
  constructor(private readonly options: BrowserAutomationHttpBridgeOptions) {}

  submit(input: unknown) {
    return this.options.controller.submit(input);
  }

  listDeliveries(input: { after?: string; limit?: number }) {
    return this.options.mailbox.list(input);
  }

  async interact(input: unknown) {
    const parsed = AutomationDeliveryInteractionSchema.safeParse(input);
    if (!parsed.success) {
      throw new AutomationDeliveryError("invalid Browser Delivery interaction", "invalid_interaction", { cause: parsed.error });
    }
    const interaction = parsed.data;
    const entry = await this.options.ledger.findByDeliveryId(interaction.delivery_id);
    if (!entry || entry.result.status !== "delivered") {
      throw new AutomationDeliveryError(`unknown Browser delivery: ${interaction.delivery_id}`, "unknown_delivery");
    }
    const automation = await this.options.views.get(entry.request.automation);
    if (!automation) {
      throw new AutomationDeliveryError(
        `Automation View is missing for Browser interaction: ${entry.request.automation.view_id}@${entry.request.automation.revision}`,
        "unknown_delivery",
      );
    }
    return this.options.delivery.interact({ interaction, policy: automation.policy });
  }
}
