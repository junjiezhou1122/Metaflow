import {
  AutomationDeliveryInteractionSchema,
  AutomationDeliveryError,
  type AutomationDeliveryCoordinator,
  type AutomationDeliveryLedger,
  type AutomationDeliveryRequest,
  type AutomationSurfaceRenderer,
} from "@info/automation";
import type { ViewRepository } from "@info/view";

export type InboxDeliveryItem = {
  delivery_id: string;
  request: AutomationDeliveryRequest;
  rendered_at: string;
};

export class InboxDeliveryMailbox implements AutomationSurfaceRenderer {
  readonly surface = "inbox";
  readonly capacity = "multiple" as const;
  private readonly items = new Map<string, InboxDeliveryItem>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async render(request: AutomationDeliveryRequest): Promise<{ delivery_id: string }> {
    if (request.surface !== this.surface) {
      throw new Error(`Inbox renderer cannot render surface: ${request.surface}`);
    }
    const deliveryId = `inbox-delivery:${request.id}`;
    const existing = this.items.get(deliveryId);
    if (existing) {
      if (JSON.stringify(existing.request) !== JSON.stringify(request)) {
        throw new Error(`Inbox delivery id conflict: ${deliveryId}`);
      }
      return { delivery_id: deliveryId };
    }
    this.items.set(deliveryId, {
      delivery_id: deliveryId,
      request,
      rendered_at: this.now().toISOString(),
    });
    return { delivery_id: deliveryId };
  }

  async withdraw(input: {
    delivery_id: string;
    request_id: string;
    reason: "replaced" | "expired" | "interaction";
  }): Promise<void> {
    const item = this.items.get(input.delivery_id);
    if (!item) throw new Error(`Inbox delivery is missing: ${input.delivery_id}`);
    if (item.request.id !== input.request_id) {
      throw new Error(`Inbox delivery request mismatch: ${input.delivery_id}`);
    }
    this.items.delete(input.delivery_id);
  }

  list(input: { after?: string; limit?: number } = {}): InboxDeliveryItem[] {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Inbox delivery limit must be an integer between 1 and 1000");
    }
    return [...this.items.values()]
      .filter(item => !input.after || item.rendered_at > input.after)
      .sort((left, right) => left.rendered_at.localeCompare(right.rendered_at))
      .slice(0, limit);
  }
}

export class InboxAutomationHttpBridge {
  constructor(private readonly options: {
    mailbox: Pick<InboxDeliveryMailbox, "list">;
    delivery: Pick<AutomationDeliveryCoordinator, "interact">;
    ledger: Pick<AutomationDeliveryLedger, "findByDeliveryId">;
    views: Pick<ViewRepository, "get">;
  }) {}

  listDeliveries(input: { after?: string; limit?: number }) {
    return this.options.mailbox.list(input);
  }

  async interact(input: unknown) {
    const parsed = AutomationDeliveryInteractionSchema.safeParse(input);
    if (!parsed.success) {
      throw new AutomationDeliveryError("invalid Inbox Delivery interaction", "invalid_interaction", { cause: parsed.error });
    }
    const interaction = parsed.data;
    const entry = await this.options.ledger.findByDeliveryId(interaction.delivery_id);
    if (!entry || entry.result.status !== "delivered") {
      throw new AutomationDeliveryError(`unknown Inbox delivery: ${interaction.delivery_id}`, "unknown_delivery");
    }
    const automation = await this.options.views.get(entry.request.automation);
    if (!automation) {
      throw new AutomationDeliveryError(
        `Automation View is missing for Inbox interaction: ${entry.request.automation.view_id}@${entry.request.automation.revision}`,
        "unknown_delivery",
      );
    }
    return this.options.delivery.interact({ interaction, policy: automation.policy });
  }
}
