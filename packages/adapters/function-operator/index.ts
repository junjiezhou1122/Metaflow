import type { OperatorReference } from "@info/transformation";
import type {
  OperatorExecutionEvent,
  OperatorExecutionInvocation,
  OperatorExecutionPort,
  OperatorExecutionResult,
} from "@info/execution";

export type FunctionOperatorReference = Extract<OperatorReference, { kind: "function" }>;

export type FunctionOperatorContext = {
  signal: AbortSignal;
  emit(event: OperatorExecutionEvent): Promise<void>;
};

export type FunctionOperatorImplementation = (
  invocation: OperatorExecutionInvocation,
  context: FunctionOperatorContext,
) => unknown | Promise<unknown>;

export type FunctionOperatorRegistration = {
  reference: FunctionOperatorReference;
  execute: FunctionOperatorImplementation;
};

type ActiveFunctionAttempt = {
  controller: AbortController;
  emit: FunctionOperatorContext["emit"];
  reference: FunctionOperatorReference;
  cancellation_event?: Promise<void>;
};

export class FunctionOperatorAdapter implements OperatorExecutionPort {
  private readonly implementations = new Map<string, FunctionOperatorImplementation>();
  private readonly activeAttempts = new Map<string, ActiveFunctionAttempt>();

  constructor(registrations: readonly FunctionOperatorRegistration[] = []) {
    for (const registration of registrations) this.register(registration);
  }

  register(registration: FunctionOperatorRegistration): this {
    const key = functionOperatorKey(registration.reference);
    if (this.implementations.has(key)) {
      throw new Error(`Function Operator is already registered: ${key}`);
    }
    this.implementations.set(key, registration.execute);
    return this;
  }

  async execute(
    invocation: OperatorExecutionInvocation,
    context: Parameters<OperatorExecutionPort["execute"]>[1],
  ): Promise<OperatorExecutionResult> {
    const reference = invocation.run.frozen.transformation.operator.reference;
    if (reference.kind !== "function") {
      return {
        status: "failed",
        error: {
          code: "operator_kind_mismatch",
          message: `Function adapter cannot execute ${reference.kind} Operator`,
        },
      };
    }
    const key = functionOperatorKey(reference);
    const implementation = this.implementations.get(key);
    if (!implementation) {
      return {
        status: "failed",
        error: {
          code: "function_operator_unregistered",
          message: `Function Operator is not registered: ${key}`,
          details: { function_id: reference.function_id, version: reference.version },
        },
      };
    }
    if (this.activeAttempts.has(invocation.attempt.id)) {
      throw new Error(`Function Operator attempt is already active: ${invocation.attempt.id}`);
    }

    const controller = new AbortController();
    const forwardAbort = () => controller.abort(context.signal.reason);
    context.signal.addEventListener("abort", forwardAbort, { once: true });
    if (context.signal.aborted) forwardAbort();
    const active: ActiveFunctionAttempt = {
      controller,
      emit: context.emit,
      reference,
    };
    this.activeAttempts.set(invocation.attempt.id, active);

    try {
      await context.emit({
        type: "function.started",
        payload: { function_id: reference.function_id, version: reference.version },
      });
      const candidate = await implementation(invocation, {
        signal: controller.signal,
        emit: context.emit,
      });
      await context.emit({
        type: "function.completed",
        payload: { function_id: reference.function_id, version: reference.version },
      });
      return { status: "succeeded", candidate };
    } catch (error) {
      if (controller.signal.aborted) {
        try {
          await this.emitCancellation(active);
        } catch (traceError) {
          throw new AggregateError([error, traceError], `Function Operator ${key} cancellation trace failed`);
        }
        throw error;
      }
      try {
        await context.emit({
          type: "function.failed",
          payload: {
            function_id: reference.function_id,
            version: reference.version,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      } catch (traceError) {
        throw new AggregateError([error, traceError], `Function Operator ${key} and failure trace both failed`);
      }
      throw error;
    } finally {
      context.signal.removeEventListener("abort", forwardAbort);
      this.activeAttempts.delete(invocation.attempt.id);
    }
  }

  async cancel(attemptId: string): Promise<void> {
    const active = this.activeAttempts.get(attemptId);
    if (!active) throw new Error(`Cannot cancel unknown Function Operator attempt: ${attemptId}`);
    active.controller.abort(new Error(`Function Operator attempt cancelled: ${attemptId}`));
    await this.emitCancellation(active);
  }

  private emitCancellation(active: ActiveFunctionAttempt): Promise<void> {
    active.cancellation_event ??= active.emit({
      type: "function.cancelled",
      payload: {
        function_id: active.reference.function_id,
        version: active.reference.version,
      },
    });
    return active.cancellation_event;
  }
}

export function functionOperatorKey(reference: FunctionOperatorReference): string {
  return `${reference.function_id}@${reference.version}`;
}
