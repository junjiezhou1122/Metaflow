import type { OperatorReference } from "@info/transformation";
import type {
  OperatorExecutionInvocation,
  OperatorExecutionPort,
  OperatorExecutionResult,
} from "./runtime-contracts.js";

export type OperatorKind = OperatorReference["kind"];

export type OperatorExecutionRoute = {
  kind: OperatorKind;
  port: OperatorExecutionPort;
};

export class OperatorExecutionRouter implements OperatorExecutionPort {
  private readonly routes = new Map<OperatorKind, OperatorExecutionPort>();
  private readonly activeAttempts = new Map<string, OperatorExecutionPort>();

  constructor(routes: readonly OperatorExecutionRoute[] = []) {
    for (const route of routes) this.register(route);
  }

  register(route: OperatorExecutionRoute): this {
    if (this.routes.has(route.kind)) {
      throw new Error(`Operator execution route is already registered for ${route.kind}`);
    }
    this.routes.set(route.kind, route.port);
    return this;
  }

  async execute(
    invocation: OperatorExecutionInvocation,
    context: Parameters<OperatorExecutionPort["execute"]>[1],
  ): Promise<OperatorExecutionResult> {
    const kind = invocation.run.frozen.transformation.operator.reference.kind;
    const port = this.routes.get(kind);
    if (!port) {
      return {
        status: "failed",
        error: {
          code: "operator_kind_unregistered",
          message: `No Operator execution route is registered for ${kind}`,
          details: { operator_kind: kind },
        },
      };
    }
    if (this.activeAttempts.has(invocation.attempt.id)) {
      throw new Error(`Operator attempt is already active: ${invocation.attempt.id}`);
    }
    this.activeAttempts.set(invocation.attempt.id, port);
    try {
      return await port.execute(invocation, context);
    } finally {
      this.activeAttempts.delete(invocation.attempt.id);
    }
  }

  async cancel(attemptId: string): Promise<void> {
    const port = this.activeAttempts.get(attemptId);
    if (!port) throw new Error(`Cannot cancel unknown Operator attempt: ${attemptId}`);
    await port.cancel(attemptId);
  }
}
