import type { FunctionRef, RegisterFunctionOptions } from "iii-sdk";
import {
  type OperatorExecutionInvocation,
  type OperatorExecutionPort,
  type OperatorExecutionResult,
} from "@info/execution";
import {
  exactTransformationRef,
  type OperatorSnapshot,
  type Transformation,
} from "@info/transformation";
import { canonicalJson, type JsonObject } from "@info/view";
import type { IiiClientPort } from "./client.js";
import {
  III_FUNCTION_ABI_VERSION,
  III_OPERATOR_CANCEL_CONTRACT,
  III_OPERATOR_CONTRACT,
  III_OPERATOR_RESULT_CONTRACT,
  IiiOperatorCancelRequestSchema,
  IiiOperatorCancelResponseSchema,
  IiiOperatorExecutionResultSchema,
  IiiOperatorInvocationEnvelopeSchema,
  IiiRuntimeError,
  contractDigest,
  extractIiiInvocationInput,
  iiiOperatorCancelFunctionId,
  iiiOperatorFunctionId,
  operatorInvocationEnvelope,
  operatorKey,
} from "./contracts.js";
import { IiiEventWriter } from "./events.js";
import { errorMessage, isInvocationStopped } from "./automation-queue.js";

export type IiiOperatorRegistration = {
  operator: OperatorSnapshot;
  port: OperatorExecutionPort;
  formations?: readonly IiiOperatorFormationContract[];
};

export type IiiOperatorFormationContract = {
  kind: "parser" | "processor";
  id: string;
  version: number;
  abi_version: 1;
  transformation: Transformation;
};

export type IiiOperatorRoute = {
  operator: OperatorSnapshot;
  function_id: string;
  cancel_function_id: string;
  registration_options: RegisterFunctionOptions;
  cancel_registration_options: RegisterFunctionOptions;
};

export type IiiOperatorRuntimeQueueEvidence = {
  name: string;
  config_version: number;
};

type ActiveOperator = {
  controller: AbortController;
  port: OperatorExecutionPort;
};

export class IiiOperatorFunctionHost {
  private readonly active = new Map<string, ActiveOperator>();
  private readonly refs: FunctionRef[] = [];

  constructor(
    private readonly client: IiiClientPort,
    private readonly events: IiiEventWriter,
    private readonly queue: IiiOperatorRuntimeQueueEvidence,
  ) {}

  register(registration: IiiOperatorRegistration): IiiOperatorRoute {
    const formations = validateFormationContracts(registration);
    const functionId = iiiOperatorFunctionId(registration.operator);
    const cancelFunctionId = iiiOperatorCancelFunctionId(registration.operator);
    const metadata = operatorRegistrationMetadata(registration.operator, formations, this.queue);
    const registrationOptions = operatorRegistrationOptions(registration.operator, metadata);
    const cancelRegistrationOptionsValue = cancelRegistrationOptions(registration.operator, metadata);
    this.refs.push(this.client.registerFunction(
      functionId,
      input => this.execute(registration, input),
      registrationOptions,
    ));
    this.refs.push(this.client.registerFunction(
      cancelFunctionId,
      input => this.cancel(registration, input),
      cancelRegistrationOptionsValue,
    ));
    return {
      operator: registration.operator,
      function_id: functionId,
      cancel_function_id: cancelFunctionId,
      registration_options: registrationOptions,
      cancel_registration_options: cancelRegistrationOptionsValue,
    };
  }

  unregister(): void {
    for (const ref of this.refs.splice(0).reverse()) ref.unregister();
  }

  private async execute(registration: IiiOperatorRegistration, raw: unknown): Promise<OperatorExecutionResult> {
    const input = extractIiiInvocationInput(raw);
    const envelope = IiiOperatorInvocationEnvelopeSchema.parse(input.payload);
    assertOperatorMatch(registration.operator, envelope.operator, envelope.invocation);
    const attemptId = envelope.invocation.attempt.id;
    if (this.active.has(attemptId)) {
      throw new IiiRuntimeError(`III Operator attempt is already active: ${attemptId}`, "operator_mismatch");
    }
    const controller = new AbortController();
    this.active.set(attemptId, { controller, port: registration.port });
    try {
      await this.events.emit({
        type: "iii.operator.received",
        function_id: iiiOperatorFunctionId(registration.operator),
        message_id: envelope.message_id,
        correlation_id: envelope.invocation.run.correlation_id,
        run_id: envelope.invocation.run.id,
        attempt_id: attemptId,
        ...(envelope.invocation.run.frozen.cascade ? { cascade_attempt_id: envelope.invocation.run.frozen.cascade.attempt_id } : {}),
        payload: {
          operator: operatorKey(registration.operator),
          ...(input.caller_worker_id ? { caller_worker_id: input.caller_worker_id } : {}),
        },
      });
      const result = await registration.port.execute(envelope.invocation, {
        signal: controller.signal,
        emit: event => this.events.emit({
          type: "iii.operator.event",
          function_id: iiiOperatorFunctionId(registration.operator),
          message_id: envelope.message_id,
          correlation_id: envelope.invocation.run.correlation_id,
          run_id: envelope.invocation.run.id,
          attempt_id: attemptId,
          ...(envelope.invocation.run.frozen.cascade ? { cascade_attempt_id: envelope.invocation.run.frozen.cascade.attempt_id } : {}),
          payload: {
            phase: "operator_event",
            operator_event_type: event.type,
            ...(event.occurred_at ? { operator_occurred_at: event.occurred_at } : {}),
            ...(event.payload ? { operator_payload: event.payload } : {}),
          },
        }),
      });
      const parsed = IiiOperatorExecutionResultSchema.parse(result);
      await this.events.emit({
        type: parsed.status === "cancelled" ? "iii.operator.cancelled" : "iii.operator.completed",
        function_id: iiiOperatorFunctionId(registration.operator),
        message_id: envelope.message_id,
        correlation_id: envelope.invocation.run.correlation_id,
        run_id: envelope.invocation.run.id,
        attempt_id: attemptId,
        ...(envelope.invocation.run.frozen.cascade ? { cascade_attempt_id: envelope.invocation.run.frozen.cascade.attempt_id } : {}),
        payload: { status: parsed.status, operator: operatorKey(registration.operator) },
      });
      return parsed;
    } catch (cause) {
      await this.events.emit({
        type: controller.signal.aborted ? "iii.operator.cancelled" : "iii.operator.failed",
        function_id: iiiOperatorFunctionId(registration.operator),
        message_id: envelope.message_id,
        correlation_id: envelope.invocation.run.correlation_id,
        run_id: envelope.invocation.run.id,
        attempt_id: attemptId,
        ...(envelope.invocation.run.frozen.cascade ? { cascade_attempt_id: envelope.invocation.run.frozen.cascade.attempt_id } : {}),
        payload: { message: errorMessage(cause), operator: operatorKey(registration.operator) },
      });
      throw cause;
    } finally {
      this.active.delete(attemptId);
    }
  }

  private async cancel(registration: IiiOperatorRegistration, raw: unknown): Promise<unknown> {
    const input = extractIiiInvocationInput(raw);
    const request = IiiOperatorCancelRequestSchema.parse(input.payload);
    if (canonicalJson(request.operator) !== canonicalJson(registration.operator)) {
      throw new IiiRuntimeError("III Operator cancellation targets an incompatible Operator", "operator_mismatch");
    }
    const active = this.active.get(request.attempt_id);
    if (!active) throw new Error(`Cannot cancel unknown III Operator attempt: ${request.attempt_id}`);
    active.controller.abort(new Error(`III Operator attempt cancelled: ${request.attempt_id}`));
    await active.port.cancel(request.attempt_id);
    await this.events.emit({
      type: "iii.operator.cancelled",
      function_id: iiiOperatorCancelFunctionId(registration.operator),
      attempt_id: request.attempt_id,
      payload: {
        operator: operatorKey(registration.operator),
        ...(input.caller_worker_id ? { caller_worker_id: input.caller_worker_id } : {}),
      },
    });
    return IiiOperatorCancelResponseSchema.parse({ accepted: true, attempt_id: request.attempt_id });
  }
}

export class IiiOperatorExecutionClient implements OperatorExecutionPort {
  private readonly routes = new Map<string, IiiOperatorRoute>();
  private readonly active = new Map<string, IiiOperatorRoute>();

  constructor(
    private readonly client: IiiClientPort,
    routes: readonly IiiOperatorRoute[],
    private readonly events: IiiEventWriter,
  ) {
    for (const route of routes) {
      const key = operatorKey(route.operator);
      if (this.routes.has(key)) throw new Error(`Duplicate III Operator route: ${key}`);
      this.routes.set(key, route);
    }
  }

  async execute(
    invocation: OperatorExecutionInvocation,
    context: Parameters<OperatorExecutionPort["execute"]>[1],
  ): Promise<OperatorExecutionResult> {
    const operator = invocation.run.frozen.transformation.operator;
    const route = this.routes.get(operatorKey(operator));
    if (!route || canonicalJson(route.operator) !== canonicalJson(operator)) {
      return {
        status: "failed",
        error: {
          code: "iii_operator_unregistered",
          message: `No compatible III Worker Function is registered for ${operatorKey(operator)}`,
        },
      };
    }
    const envelope = operatorInvocationEnvelope(invocation);
    if (this.active.has(invocation.attempt.id)) {
      throw new Error(`III Operator attempt is already active: ${invocation.attempt.id}`);
    }
    this.active.set(invocation.attempt.id, route);
    try {
      const result = await this.client.trigger<typeof envelope, unknown>({
        function_id: route.function_id,
        payload: envelope,
        ...(invocation.run.frozen.transformation.budget?.limits.timeout_ms
          ? { timeoutMs: invocation.run.frozen.transformation.budget.limits.timeout_ms }
          : {}),
      });
      return IiiOperatorExecutionResultSchema.parse(result);
    } catch (cause) {
      if (isInvocationStopped(cause) || context.signal.aborted) {
        await this.events.emit({
          type: isInvocationStopped(cause) ? "iii.worker.disconnected" : "iii.operator.cancelled",
          function_id: route.function_id,
          message_id: envelope.message_id,
          correlation_id: invocation.run.correlation_id,
          run_id: invocation.run.id,
          attempt_id: invocation.attempt.id,
          ...(invocation.run.frozen.cascade ? { cascade_attempt_id: invocation.run.frozen.cascade.attempt_id } : {}),
          payload: { message: errorMessage(cause) },
        });
        return { status: "cancelled", reason: errorMessage(cause) };
      }
      throw cause;
    } finally {
      this.active.delete(invocation.attempt.id);
    }
  }

  async cancel(attemptId: string): Promise<void> {
    const route = this.active.get(attemptId);
    if (!route) throw new Error(`Cannot cancel unknown III Operator attempt: ${attemptId}`);
    const response = await this.client.trigger<unknown, unknown>({
      function_id: route.cancel_function_id,
      payload: IiiOperatorCancelRequestSchema.parse({
        schema_version: 1,
        contract: III_OPERATOR_CANCEL_CONTRACT,
        operator: route.operator,
        attempt_id: attemptId,
      }),
    });
    IiiOperatorCancelResponseSchema.parse(response);
  }
}

function assertOperatorMatch(
  registered: OperatorSnapshot,
  requested: OperatorSnapshot,
  invocation: OperatorExecutionInvocation,
): void {
  const frozen = invocation.run.frozen.transformation.operator;
  const attempted = invocation.attempt.operator;
  if (
    canonicalJson(registered) !== canonicalJson(requested)
    || canonicalJson(registered) !== canonicalJson(frozen)
    || canonicalJson(registered) !== canonicalJson(attempted)
  ) {
    throw new IiiRuntimeError(
      `III Function ${iiiOperatorFunctionId(registered)} rejected an incompatible frozen Operator`,
      "operator_mismatch",
    );
  }
}

function operatorRegistrationOptions(operator: OperatorSnapshot, metadata: JsonObject): RegisterFunctionOptions {
  return {
    description: `Execute frozen Metaflow Operator ${operatorKey(operator)} without committing canonical state`,
    request_format: OPERATOR_REQUEST_FORMAT,
    response_format: OPERATOR_RESPONSE_FORMAT,
    metadata,
  };
}

function cancelRegistrationOptions(operator: OperatorSnapshot, metadata: JsonObject): RegisterFunctionOptions {
  return {
    description: `Cancel active Metaflow Operator ${operatorKey(operator)}`,
    request_format: OPERATOR_CANCEL_REQUEST_FORMAT,
    response_format: OPERATOR_CANCEL_RESPONSE_FORMAT,
    metadata: {
      ...metadata,
      metaflow_contract: III_OPERATOR_CANCEL_CONTRACT,
      input_contract: {
        id: III_OPERATOR_CANCEL_CONTRACT,
        schema_sha256: contractDigest(OPERATOR_CANCEL_REQUEST_FORMAT),
      },
      output_contract: {
        id: "metaflow.operator.cancel-result.v1",
        schema_sha256: contractDigest(OPERATOR_CANCEL_RESPONSE_FORMAT),
      },
    },
  };
}

function operatorRegistrationMetadata(
  operator: OperatorSnapshot,
  formations: readonly IiiOperatorFormationContract[],
  queue: IiiOperatorRuntimeQueueEvidence,
): JsonObject {
  return {
    metaflow_contract: III_OPERATOR_CONTRACT,
    function_abi_version: III_FUNCTION_ABI_VERSION,
    operator: {
      id: operator.id,
      revision: operator.revision,
      snapshot_sha256: contractDigest(operator),
    },
    input_contract: {
      id: III_OPERATOR_CONTRACT,
      schema_sha256: contractDigest(OPERATOR_REQUEST_FORMAT),
    },
    output_contract: {
      id: III_OPERATOR_RESULT_CONTRACT,
      schema_sha256: contractDigest(OPERATOR_RESPONSE_FORMAT),
    },
    invocation: {
      direct: true,
      automation_queue: {
        name: queue.name,
        config_version: queue.config_version,
      },
    },
    capabilities: [...new Set([
      ...operator.required_capabilities,
      ...formations.map(formation => `metaflow.${formation.kind}`),
    ])].sort(),
    formation_contracts: formations.map(formation => ({
      kind: formation.kind,
      id: formation.id,
      version: formation.version,
      abi_version: formation.abi_version,
      transformation: exactTransformationRef(formation.transformation),
      input_contract_sha256: contractDigest(formation.transformation.inputs),
      output_contract_sha256: contractDigest(formation.transformation.output),
    })),
    canonical_owner: "metaflow-execution",
  };
}

function validateFormationContracts(registration: IiiOperatorRegistration): readonly IiiOperatorFormationContract[] {
  const formations = [...(registration.formations ?? [])].sort((left, right) => (
    left.kind.localeCompare(right.kind)
    || left.id.localeCompare(right.id)
    || left.version - right.version
    || left.abi_version - right.abi_version
    || left.transformation.id.localeCompare(right.transformation.id)
    || left.transformation.revision - right.transformation.revision
  ));
  const identities = new Set<string>();
  for (const formation of formations) {
    if (!formation.id.trim() || !Number.isInteger(formation.version) || formation.version < 1 || formation.abi_version !== 1) {
      throw new IiiRuntimeError("III Operator formation contract is invalid", "function_contract_incompatible");
    }
    if (canonicalJson(formation.transformation.operator) !== canonicalJson(registration.operator)) {
      throw new IiiRuntimeError(
        `III ${formation.kind} ${formation.id}@${formation.version} does not use ${operatorKey(registration.operator)}`,
        "operator_mismatch",
      );
    }
    const identity = `${formation.kind}:${formation.id}@${formation.version}@${formation.abi_version}:${formation.transformation.id}@${formation.transformation.revision}`;
    if (identities.has(identity)) {
      throw new IiiRuntimeError(`Duplicate III Operator formation contract: ${identity}`, "function_contract_incompatible");
    }
    identities.add(identity);
  }
  return formations;
}

const OPERATOR_REQUEST_FORMAT = {
  type: "object" as const,
  required: ["schema_version", "contract", "message_id", "operator", "invocation"],
  properties: {
    schema_version: { const: 1 },
    contract: { const: III_OPERATOR_CONTRACT },
    message_id: { type: "string" },
    operator: { type: "object" },
    invocation: { type: "object" },
  },
  additionalProperties: false,
};

const OPERATOR_RESPONSE_FORMAT = {
  type: "object" as const,
  required: ["status"],
  properties: { status: { enum: ["succeeded", "failed", "cancelled"] } },
  additionalProperties: true,
};

const OPERATOR_CANCEL_REQUEST_FORMAT = {
  type: "object" as const,
  required: ["schema_version", "contract", "operator", "attempt_id"],
  properties: {
    schema_version: { const: 1 },
    contract: { const: III_OPERATOR_CANCEL_CONTRACT },
    operator: { type: "object" },
    attempt_id: { type: "string" },
  },
  additionalProperties: false,
};

const OPERATOR_CANCEL_RESPONSE_FORMAT = {
  type: "object" as const,
  required: ["accepted", "attempt_id"],
  properties: { accepted: { const: true }, attempt_id: { type: "string" } },
  additionalProperties: false,
};
