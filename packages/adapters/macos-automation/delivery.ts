import type { AutomationDeliveryRequest, AutomationSurfaceRenderer } from "@info/automation";

export type MacDeliveryCard = {
  delivery_id: string;
  request: AutomationDeliveryRequest;
  rendered_at: string;
};

export class MacDeliveryMailbox implements AutomationSurfaceRenderer {
  readonly surface = "macos";
  readonly capacity = "single" as const;
  private readonly cards = new Map<string, MacDeliveryCard>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async render(request: AutomationDeliveryRequest): Promise<{ delivery_id: string }> {
    if (request.surface !== this.surface) throw new Error(`macOS renderer cannot render surface: ${request.surface}`);
    const deliveryId = `macos-delivery:${request.id}`;
    const existing = this.cards.get(deliveryId);
    if (existing) {
      if (JSON.stringify(existing.request) !== JSON.stringify(request)) throw new Error(`macOS delivery id conflict: ${deliveryId}`);
      return { delivery_id: deliveryId };
    }
    this.cards.set(deliveryId, { delivery_id: deliveryId, request, rendered_at: this.now().toISOString() });
    return { delivery_id: deliveryId };
  }

  async withdraw(input: {
    delivery_id: string;
    request_id: string;
    reason: "replaced" | "expired" | "interaction";
  }): Promise<void> {
    const card = this.cards.get(input.delivery_id);
    if (!card) throw new Error(`macOS delivery is missing: ${input.delivery_id}`);
    if (card.request.id !== input.request_id) throw new Error(`macOS delivery request mismatch: ${input.delivery_id}`);
    this.cards.delete(input.delivery_id);
  }

  list(input: { after?: string; limit?: number } = {}): MacDeliveryCard[] {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("macOS delivery limit must be an integer between 1 and 1000");
    }
    return [...this.cards.values()]
      .filter(card => !input.after || card.rendered_at > input.after)
      .sort((left, right) => left.rendered_at.localeCompare(right.rendered_at))
      .slice(0, limit);
  }
}
