import type { FunctionRef, RegisterFunctionOptions } from "iii-sdk";
import {
  parseAutomationView,
  type AutomationInvocationAdmissionResult,
  type AutomationInvocationPort,
  type ReactiveCascadeLedger,
  type ReactiveCascadeTerminalizer,
} from "@info/automation";
import { canonicalJson, exactViewRef, type ViewRepository } from "@info/view";
import {
  III_AUTOMATION_CONTRACT,
  III_AUTOMATION_FUNCTION_ID,
  III_ENGINE_VERSION,
  III_FUNCTION_ABI_VERSION,
  III_SDK_VERSION,
  IiiAutomationHandlerResponseSchema,
  IiiAutomationInvocationEnvelopeSchema,
  IiiDeadLetterMessagesSchema,
  IiiEngineWorkersResponseSchema,
  IiiFunctionDetailSchema,
  IiiQueueTopicStatsSchema,
  IiiRuntimeError,
  METAFLOW_AUTOMATION_QUEUE,
  assertCompatibleQueueConfiguration,
  contractDigest,
  extractIiiInvocationInput,
  type IiiDeadLetterMessage,
  type IiiQueueConfiguration,
  type IiiRuntimeEventSink,
} from "./contracts.js";
import {
  defaultIiiClientFactory,
  enforceIiiTracePayloadProtection,
  installedIiiSdkVersion,
  type IiiClientFactory,
  type IiiClientPort,
} from "./client.js";
import { IiiEventWriter } from "./events.js";
import {
  IiiAutomationInvocationQueue,
  assertDescriptorSafeSignal,
  errorMessage,
  isInvocationStopped,
} from "./automation-queue.js";
import {
  IiiOperatorExecutionClient,
  IiiOperatorFunctionHost,
  type IiiOperatorRegistration,
  type IiiOperatorRoute,
} from "./operator.js";

export type IiiRuntimeWorkerOptions = {
  engine_url: string;
  worker_name?: string;
  sdk_version?: string;
  expected_engine_version?: string;
  queue?: IiiQueueConfiguration;
  views: Pick<ViewRepository, "get">;
  automations: AutomationInvocationPort;
  operators?: readonly IiiOperatorRegistration[];
  events: IiiRuntimeEventSink;
  client_factory?: IiiClientFactory;
  now?: () => string;
  cascades?: ReactiveCascadeLedger;
  cascade_terminalizer?: ReactiveCascadeTerminalizer;
  dlq_poll_interval_ms?: number;
};

export class IiiRuntimeWorker {
  readonly automationQueue: IiiAutomationInvocationQueue;
  operatorClient: IiiOperatorExecutionClient;
  operatorRoutes: readonly IiiOperatorRoute[];

  private automationRef?: FunctionRef;
  private closed = false;
  private dlqMonitor?: ReturnType<typeof setInterval>;
  private dlqMonitorFailure?: Error;
  private readonly observedDeadLetters = new Set<string>();
  private readonly expectedFunctions = new Map<string, RegisterFunctionOptions>();

  private constructor(
    private readonly options: Required<Pick<IiiRuntimeWorkerOptions, "worker_name" | "sdk_version" | "expected_engine_version">>
      & Omit<IiiRuntimeWorkerOptions, "worker_name" | "sdk_version" | "expected_engine_version">,
    private readonly client: IiiClientPort,
    private readonly eventWriter: IiiEventWriter,
    private readonly operatorHost: IiiOperatorFunctionHost,
    routes: readonly IiiOperatorRoute[],
  ) {
    this.operatorRoutes = routes;
    this.automationQueue = new IiiAutomationInvocationQueue({
      client,
      queue: options.queue,
      events: eventWriter,
      now: options.now,
    });
    this.operatorClient = new IiiOperatorExecutionClient(client, routes, eventWriter);
  }

  static async start(input: IiiRuntimeWorkerOptions): Promise<IiiRuntimeWorker> {
    const options = normalizeOptions(input);
    if ((options.cascades === undefined) !== (options.cascade_terminalizer === undefined)) {
      throw new IiiRuntimeError(
        "III reactive cascade support requires both a durable ledger and a canonical terminalizer",
        "registration_failed",
      );
    }
    const queue = assertCompatibleQueueConfiguration(options.queue ?? METAFLOW_AUTOMATION_QUEUE);
    if (options.sdk_version !== III_SDK_VERSION) {
      throw new IiiRuntimeError(
        `III SDK ${options.sdk_version} is incompatible; expected ${III_SDK_VERSION}`,
        "sdk_version_incompatible",
      );
    }
    enforceIiiTracePayloadProtection();
    const client = (options.client_factory ?? defaultIiiClientFactory)({
      engine_url: options.engine_url,
      worker_name: options.worker_name,
    });
    const events = new IiiEventWriter({
      sink: options.events,
      worker: options.worker_name,
      now: options.now ?? (() => new Date().toISOString()),
    });
    const operatorHost = new IiiOperatorFunctionHost(client, events, {
      name: queue.name,
      config_version: queue.version,
    });
    const worker = new IiiRuntimeWorker({ ...options, queue }, client, events, operatorHost, []);

    try {
      await events.emit({
        type: "iii.worker.registration_started",
        payload: {
          sdk_version: options.sdk_version,
          expected_engine_version: options.expected_engine_version,
          queue: queue.name,
          queue_config_version: queue.version,
        },
      });
      const automationOptions = automationRegistrationOptions(queue);
      worker.automationRef = client.registerFunction(
        III_AUTOMATION_FUNCTION_ID,
        raw => worker.handleAutomation(raw),
        automationOptions,
      );
      worker.expectedFunctions.set(III_AUTOMATION_FUNCTION_ID, automationOptions);
      await events.emit({
        type: "iii.worker.function_registered",
        function_id: III_AUTOMATION_FUNCTION_ID,
        queue: queue.name,
        payload: { contract: III_AUTOMATION_CONTRACT },
      });
      const routes: IiiOperatorRoute[] = [];
      for (const registration of options.operators ?? []) {
        const route = operatorHost.register(registration);
        routes.push(route);
        worker.expectedFunctions.set(route.function_id, route.registration_options);
        worker.expectedFunctions.set(route.cancel_function_id, route.cancel_registration_options);
        await events.emit({
          type: "iii.worker.function_registered",
          function_id: route.function_id,
          payload: {
            contract: "metaflow.operator.execute.v1",
            operator_id: route.operator.id,
            operator_revision: route.operator.revision,
            cancel_function_id: route.cancel_function_id,
          },
        });
      }
      worker.operatorRoutes = routes;
      worker.operatorClient = new IiiOperatorExecutionClient(client, routes, events);
      await worker.verifyReadiness("startup");
      await events.emit({
        type: "iii.worker.registered",
        queue: queue.name,
        payload: { function_count: 1 + routes.length * 2 },
      });
      worker.startDlqMonitor();
      return worker;
    } catch (cause) {
      worker.automationRef?.unregister();
      operatorHost.unregister();
      try {
        await client.shutdown();
      } catch (shutdownError) {
        throw new AggregateError([cause, shutdownError], "III Worker startup and cleanup both failed");
      }
      if (cause instanceof IiiRuntimeError) throw cause;
      throw new IiiRuntimeError("III Worker registration failed", "registration_failed", { cause });
    }
  }

  async inspectDeadLetters(input: { offset?: number; limit?: number } = {}): Promise<IiiDeadLetterMessage[]> {
    const queue = assertCompatibleQueueConfiguration(this.options.queue ?? METAFLOW_AUTOMATION_QUEUE);
    try {
      const raw = await this.client.trigger<unknown, unknown>({
        function_id: queue.dlq.inspection_function_id,
        payload: { queue: queue.name, offset: input.offset ?? 0, limit: input.limit ?? 50 },
      });
      const messages = IiiDeadLetterMessagesSchema.parse(raw);
      for (const message of messages) {
        const envelope = IiiAutomationInvocationEnvelopeSchema.safeParse(message.payload);
        await this.eventWriter.emit({
          type: "iii.queue.dlq_observed",
          queue: queue.name,
          function_id: III_AUTOMATION_FUNCTION_ID,
          ...(envelope.success ? {
            message_id: envelope.data.message_id,
            correlation_id: envelope.data.correlation_id,
            automation: envelope.data.automation,
            signal_id: envelope.data.signal.id,
            ...(envelope.data.signal.cascade ? { cascade_attempt_id: envelope.data.signal.cascade.attempt_id } : {}),
          } : {}),
          payload: {
            dlq_message_id: message.id,
            retries: message.retries,
            failed_at_epoch_seconds: message.failed_at,
            error: message.error,
            payload_valid: envelope.success,
          },
        });
        if (envelope.success && envelope.data.signal.cascade && !this.observedDeadLetters.has(message.id)) {
          await this.terminalizeDeadLetter(envelope.data.signal.cascade.attempt_id, message);
          this.observedDeadLetters.add(message.id);
        }
      }
      return messages;
    } catch (cause) {
      await this.eventWriter.emit({
        type: "iii.queue.dlq_inspection_failed",
        queue: queue.name,
        function_id: queue.dlq.inspection_function_id,
        payload: { message: errorMessage(cause) },
      });
      throw new IiiRuntimeError("III DLQ inspection failed", "dlq_inspection_failed", { cause });
    }
  }

  async close(): Promise<void> {
    if (this.closed) throw new Error(`III Worker is already closed: ${this.options.worker_name}`);
    this.closed = true;
    if (this.dlqMonitor) clearInterval(this.dlqMonitor);
    await this.eventWriter.emit({ type: "iii.worker.shutdown_started" });
    this.automationRef?.unregister();
    this.operatorHost.unregister();
    await this.client.shutdown();
    await this.eventWriter.emit({ type: "iii.worker.shutdown_completed" });
  }

  assertHealthy(): void {
    if (this.dlqMonitorFailure) throw this.dlqMonitorFailure;
    if (this.closed) throw new Error(`III Worker is closed: ${this.options.worker_name}`);
  }

  async verifyReadiness(reason: "startup" | "restart" | "probe" = "probe"): Promise<void> {
    if (this.closed) throw new Error(`III Worker is closed: ${this.options.worker_name}`);
    await this.verifyEngineCompatibility();
    await this.verifyQueueCompatibility();
    for (const [functionId, expected] of this.expectedFunctions) {
      await this.verifyFunctionContract(functionId, expected);
    }
    await this.eventWriter.emit({
      type: "iii.worker.readiness_verified",
      queue: (this.options.queue ?? METAFLOW_AUTOMATION_QUEUE).name,
      payload: {
        reason,
        function_count: this.expectedFunctions.size,
        operator_count: this.operatorRoutes.length,
      },
    });
  }

  private startDlqMonitor(): void {
    const interval = this.options.dlq_poll_interval_ms;
    if (interval === undefined) return;
    if (!Number.isInteger(interval) || interval < 100) {
      throw new Error("dlq_poll_interval_ms must be an integer of at least 100ms");
    }
    this.dlqMonitor = setInterval(() => {
      void this.inspectDeadLetters().catch(cause => {
        this.dlqMonitorFailure = cause instanceof Error ? cause : new Error(String(cause));
        if (this.dlqMonitor) clearInterval(this.dlqMonitor);
      });
    }, interval);
    this.dlqMonitor.unref?.();
  }

  private async terminalizeDeadLetter(attemptId: string, message: IiiDeadLetterMessage): Promise<void> {
    if (!this.options.cascades) {
      throw new IiiRuntimeError(
        `DLQ message ${message.id} carries cascade attempt ${attemptId} but no durable cascade ledger is configured`,
        "dlq_inspection_failed",
      );
    }
    if (!this.options.cascade_terminalizer) {
      throw new IiiRuntimeError(
        `DLQ message ${message.id} carries cascade attempt ${attemptId} but no canonical terminalizer is configured`,
        "dlq_inspection_failed",
      );
    }
    const attempt = await this.options.cascades.getAttempt(attemptId);
    if (!attempt) {
      throw new IiiRuntimeError(`DLQ cascade attempt is missing: ${attemptId}`, "dlq_inspection_failed");
    }
    if (attempt.status === "succeeded" || attempt.status === "failed" || attempt.status === "stopped") return;
    const occurredAt = this.options.now?.() ?? new Date().toISOString();
    const terminal = await this.options.cascade_terminalizer.terminalize({
      attempt,
      code: "iii_dlq_terminal",
      message: message.error,
      stage: "transport",
      occurred_at: occurredAt,
    });
    if (attempt.run_id && terminal.run_id !== attempt.run_id) {
      throw new IiiRuntimeError(
        `DLQ terminalization changed cascade Run ${attempt.run_id} to ${terminal.run_id}`,
        "dlq_inspection_failed",
      );
    }
    await this.options.cascades.finalize({
      attempt_id: attemptId,
      status: terminal.status === "succeeded" ? "succeeded" : "stopped",
      completed_at: occurredAt,
      run_id: terminal.run_id,
      cost_usd: attempt.cost_usd,
      ...(terminal.status === "failed" ? {
        error_code: "iii_dlq_terminal",
        error_message: message.error,
      } : {}),
    });
    await this.eventWriter.emit({
      type: "iii.queue.dlq_terminalized",
      queue: (this.options.queue ?? METAFLOW_AUTOMATION_QUEUE).name,
      function_id: III_AUTOMATION_FUNCTION_ID,
      cascade_attempt_id: attemptId,
      run_id: terminal.run_id,
      payload: {
        dlq_message_id: message.id,
        execution_status: terminal.status,
        ...(terminal.status === "failed"
          ? { failure_view: terminal.failure_view }
          : { output_views: terminal.output_views }),
      },
    });
  }

  private async verifyEngineCompatibility(): Promise<void> {
    const raw = await this.client.trigger<unknown, unknown>({
      function_id: "engine::workers::list",
      payload: {},
    });
    const response = IiiEngineWorkersResponseSchema.parse(raw);
    const versions = [...new Set(response.workers
      .filter(worker => worker.runtime === "engine")
      .map(worker => worker.version)
      .filter((version): version is string => typeof version === "string"))];
    if (versions.length === 0 || versions.some(version => version !== this.options.expected_engine_version)) {
      throw new IiiRuntimeError(
        `III engine version is incompatible: observed ${versions.join(", ") || "none"}; expected ${this.options.expected_engine_version}`,
        "engine_version_incompatible",
      );
    }
    await this.eventWriter.emit({
      type: "iii.worker.compatibility_verified",
      payload: {
        engine_version: this.options.expected_engine_version,
        sdk_version: this.options.sdk_version,
        queue_config_version: this.options.queue?.version ?? METAFLOW_AUTOMATION_QUEUE.version,
      },
    });
  }

  private async verifyQueueCompatibility(): Promise<void> {
    const queue = assertCompatibleQueueConfiguration(this.options.queue ?? METAFLOW_AUTOMATION_QUEUE);
    const raw = await this.client.trigger<unknown, unknown>({
      function_id: "engine::queue::topic_stats",
      payload: { queue: queue.name },
    });
    const stats = IiiQueueTopicStatsSchema.parse(raw);
    if (stats.consumer_count !== queue.concurrency) {
      throw new IiiRuntimeError(
        `III queue ${queue.name} reports concurrency ${stats.consumer_count}; expected ${queue.concurrency}`,
        "queue_config_incompatible",
      );
    }
    if (stats.config && typeof stats.config === "object" && !Array.isArray(stats.config)) {
      const actual = stats.config as Record<string, unknown>;
      for (const key of ["max_retries", "concurrency", "type", "backoff_ms", "poll_interval_ms"] as const) {
        if (actual[key] !== undefined && actual[key] !== queue[key]) {
          throw new IiiRuntimeError(
            `III queue ${queue.name} has incompatible ${key}: ${String(actual[key])} != ${String(queue[key])}`,
            "queue_config_incompatible",
          );
        }
      }
    }
  }

  private async verifyFunctionContract(functionId: string, expected: RegisterFunctionOptions): Promise<void> {
    const raw = await this.client.trigger<unknown, unknown>({
      function_id: "engine::functions::info",
      payload: { function_id: functionId },
    });
    const detail = IiiFunctionDetailSchema.parse(raw);
    const expectedContract = {
      description: expected.description ?? null,
      request_schema: expected.request_format ?? null,
      response_schema: expected.response_format ?? null,
      metadata: expected.metadata ?? null,
    };
    const actualContract = {
      description: detail.description ?? null,
      request_schema: detail.request_schema ?? null,
      response_schema: detail.response_schema ?? null,
      metadata: detail.metadata ?? null,
    };
    if (
      detail.function_id !== functionId
      || detail.worker_name !== this.options.worker_name
      || canonicalJson(actualContract) !== canonicalJson(expectedContract)
    ) {
      throw new IiiRuntimeError(
        `III Function registration is incompatible for ${functionId}; expected ${contractDigest(expectedContract)}, observed ${contractDigest(actualContract)}`,
        "function_contract_incompatible",
      );
    }
  }

  private async handleAutomation(raw: unknown): Promise<unknown> {
    const input = extractIiiInvocationInput(raw);
    const parsed = IiiAutomationInvocationEnvelopeSchema.safeParse(input.payload);
    if (!parsed.success) {
      await this.eventWriter.emit({
        type: "iii.queue.retryable_failure",
        queue: METAFLOW_AUTOMATION_QUEUE.name,
        function_id: III_AUTOMATION_FUNCTION_ID,
        payload: { stage: "envelope_validation", message: parsed.error.message },
      });
      throw parsed.error;
    }
    const envelope = parsed.data;
    assertDescriptorSafeSignal(envelope.signal);
    await this.eventWriter.emit({
      type: "iii.queue.received",
      queue: envelope.queue.name,
      function_id: III_AUTOMATION_FUNCTION_ID,
      message_id: envelope.message_id,
      correlation_id: envelope.correlation_id,
      automation: envelope.automation,
      signal_id: envelope.signal.id,
      ...(envelope.signal.cascade ? { cascade_attempt_id: envelope.signal.cascade.attempt_id } : {}),
      payload: input.caller_worker_id ? { caller_worker_id: input.caller_worker_id } : {},
    });
    try {
      const view = await this.options.views.get(envelope.automation);
      if (!view) {
        throw new IiiRuntimeError(
          `exact Automation View is unavailable: ${envelope.automation.view_id}@${envelope.automation.revision}`,
          "automation_resolution_failed",
        );
      }
      const automation = parseAutomationView(view);
      const resolvedRef = exactViewRef(automation.view);
      if (
        resolvedRef.view_id !== envelope.automation.view_id
        || resolvedRef.revision !== envelope.automation.revision
      ) {
        throw new IiiRuntimeError(
          `Automation repository returned ${resolvedRef.view_id}@${resolvedRef.revision} for ${envelope.automation.view_id}@${envelope.automation.revision}`,
          "automation_resolution_failed",
        );
      }
      const result = await this.options.automations.invoke({
        automation,
        signal: envelope.signal,
        ...(envelope.predicate_match ? { predicate_match: envelope.predicate_match } : {}),
        ...(envelope.attempt ? { attempt: envelope.attempt } : {}),
      });
      if (result.status === "duplicate" && result.existing_status === "reserved") {
        throw new IiiRuntimeError(
          `Automation occurrence is still reserved: ${result.correlation_id}`,
          "automation_occurrence_incomplete",
        );
      }
      const response = handlerResponse(result);
      await this.eventWriter.emit({
        type: result.status === "duplicate" ? "iii.queue.duplicate" : "iii.queue.completed",
        queue: envelope.queue.name,
        function_id: III_AUTOMATION_FUNCTION_ID,
        message_id: envelope.message_id,
        correlation_id: "correlation_id" in result ? result.correlation_id : envelope.correlation_id,
        automation: envelope.automation,
        signal_id: envelope.signal.id,
        ...(envelope.signal.cascade ? { cascade_attempt_id: envelope.signal.cascade.attempt_id } : {}),
        ...(response.run_id ? { run_id: response.run_id } : {}),
        payload: { status: result.status },
      });
      return response;
    } catch (cause) {
      const cancelled = isInvocationStopped(cause);
      await this.eventWriter.emit({
        type: cancelled ? "iii.queue.cancelled" : "iii.queue.retryable_failure",
        queue: envelope.queue.name,
        function_id: III_AUTOMATION_FUNCTION_ID,
        message_id: envelope.message_id,
        correlation_id: envelope.correlation_id,
        automation: envelope.automation,
        signal_id: envelope.signal.id,
        ...(envelope.signal.cascade ? { cascade_attempt_id: envelope.signal.cascade.attempt_id } : {}),
        payload: { message: errorMessage(cause), stage: "handler" },
      });
      if (cancelled) {
        await this.eventWriter.emit({
          type: "iii.worker.disconnected",
          function_id: III_AUTOMATION_FUNCTION_ID,
          message_id: envelope.message_id,
          correlation_id: envelope.correlation_id,
          automation: envelope.automation,
          signal_id: envelope.signal.id,
          ...(envelope.signal.cascade ? { cascade_attempt_id: envelope.signal.cascade.attempt_id } : {}),
          payload: { message: errorMessage(cause) },
        });
      }
      throw cause;
    }
  }
}

function normalizeOptions(input: IiiRuntimeWorkerOptions) {
  if (!input.engine_url.trim()) throw new Error("III engine_url is required");
  return {
    ...input,
    engine_url: input.engine_url,
    worker_name: input.worker_name ?? "metaflow-v1",
    sdk_version: input.sdk_version ?? installedIiiSdkVersion(),
    expected_engine_version: input.expected_engine_version ?? III_ENGINE_VERSION,
    dlq_poll_interval_ms: input.dlq_poll_interval_ms,
  };
}

function handlerResponse(result: AutomationInvocationAdmissionResult) {
  const correlationId = "correlation_id" in result ? result.correlation_id : undefined;
  const runId = "run_id" in result ? result.run_id : undefined;
  return IiiAutomationHandlerResponseSchema.parse({
    accepted: true,
    status: result.status,
    ...(correlationId ? { correlation_id: correlationId } : {}),
    ...(runId ? { run_id: runId } : {}),
  });
}

function automationRegistrationOptions(queue: IiiQueueConfiguration): RegisterFunctionOptions {
  const requestFormat = {
    type: "object" as const,
    required: ["schema_version", "contract", "message_id", "correlation_id", "queue", "automation", "signal"],
    properties: {
      schema_version: { const: 1 },
      contract: { const: III_AUTOMATION_CONTRACT },
      message_id: { type: "string" },
      correlation_id: { type: "string" },
      queue: { type: "object" },
      automation: { type: "object" },
      signal: { type: "object" },
    },
    additionalProperties: false,
  };
  const responseFormat = {
    type: "object" as const,
    required: ["accepted", "status"],
    properties: {
      accepted: { const: true },
      status: { enum: ["ignored", "duplicate", "skipped", "succeeded", "failed"] },
    },
    additionalProperties: true,
  };
  return {
    description: "Resolve an exact Automation View and invoke the canonical Metaflow Automation Runtime",
    request_format: requestFormat,
    response_format: responseFormat,
    metadata: {
      metaflow_contract: III_AUTOMATION_CONTRACT,
      function_abi_version: III_FUNCTION_ABI_VERSION,
      input_contract: {
        id: III_AUTOMATION_CONTRACT,
        schema_sha256: contractDigest(requestFormat),
      },
      output_contract: {
        id: "metaflow.automation.invoke-result.v1",
        schema_sha256: contractDigest(responseFormat),
      },
      queue: { name: queue.name, config_version: queue.version },
      capabilities: ["descriptor_only", "durable_queue", "retry", "dlq"],
      canonical_owner: "metaflow-automation",
    },
  };
}
