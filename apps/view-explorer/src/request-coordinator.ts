export type ExplorerRequestKind = "search" | "projection" | "expand";
export type ExplorerRequestToken = Readonly<{ generation: number }>;

export class ExplorerRequestCoordinator {
  private generation = 0;
  private readonly controllers = new Map<ExplorerRequestKind, AbortController>();

  begin(kind: ExplorerRequestKind): { token: ExplorerRequestToken; controller: AbortController } {
    this.supersede(`${kind} request superseded prior explorer work`);
    const token = { generation: this.generation };
    return { token, controller: this.attach(token, kind) };
  }

  attach(token: ExplorerRequestToken, kind: ExplorerRequestKind): AbortController {
    if (!this.isCurrent(token)) throw new DOMException("Explorer request was superseded", "AbortError");
    this.controllers.get(kind)?.abort(new DOMException(`${kind} request was replaced`, "AbortError"));
    const controller = new AbortController();
    this.controllers.set(kind, controller);
    return controller;
  }

  isCurrent(token: ExplorerRequestToken, controller?: AbortController): boolean {
    return token.generation === this.generation && !controller?.signal.aborted;
  }

  finish(kind: ExplorerRequestKind, controller: AbortController): void {
    if (this.controllers.get(kind) === controller) this.controllers.delete(kind);
  }

  supersede(reason: string): void {
    this.generation += 1;
    for (const controller of this.controllers.values()) {
      controller.abort(new DOMException(reason, "AbortError"));
    }
    this.controllers.clear();
  }

  dispose(): void {
    this.supersede("View Explorer disposed");
  }
}
