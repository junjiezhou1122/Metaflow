import { ContextStore } from "@info/core";
import type { ContextRecord, ContextView, RuntimeEvent, StoredContextRecord, StoredContextView } from "@info/core";
import { activeContextView } from "@info/core";
import { buildContextPack, filterViewsForPlugin } from "@info/core";
import { signalFromObject } from "./signals.js";
import type { AttentionInfluence, AutonomyProfile, Capability, CapabilityRunResult, ContextSignal, ContextWriteSet, Program, ProgramRunResult, SpeedTier } from "./types.js";

export type ProgramRuntimeOptions = {
  speed?: SpeedTier;
  autonomy?: AutonomyProfile;
  max_programs?: number;
  program_id?: string;
  context_plugin_id?: string;
  dry_run?: boolean;
};

export type ProgramRuntimeResult = {
  ok: true;
  generated_at: string;
  signal: ContextSignal;
  decisions: Array<{ program_id: string; action: string; reason?: string; confidence?: number; capability_ids?: string[]; attention_influences?: Array<AttentionInfluence & { program_id: string }> }>;
  runs: Array<{ program_id: string; ok: boolean; reason?: string; written_records: string[]; written_views: string[]; diagnostics?: Record<string, unknown> }>;
  diagnostics: Record<string, unknown>;
};

export class ProgramRuntime {
  private programs = new Map<string, Program>();
  private capabilities = new Map<string, Capability>();

  constructor(private store = new ContextStore()) {}

  registerProgram(program: Program): this {
    this.programs.set(program.id, program);
    return this;
  }

  registerCapability(capability: Capability): this {
    this.capabilities.set(capability.id, capability);
    return this;
  }

  listPrograms(): Program[] {
    return [...this.programs.values()];
  }

  listCapabilities(): Capability[] {
    return [...this.capabilities.values()];
  }

  async processObject(object: StoredContextRecord | StoredContextView, options: ProgramRuntimeOptions = {}): Promise<ProgramRuntimeResult> {
    return this.processSignal(signalFromObject(object), options);
  }

  async processSignal(signal: ContextSignal, options: ProgramRuntimeOptions = {}): Promise<ProgramRuntimeResult> {
    const generatedAt = new Date().toISOString();
    const decisions: ProgramRuntimeResult["decisions"] = [];
    const runs: ProgramRuntimeResult["runs"] = [];
    const policyDenials: Array<Record<string, unknown>> = [];
    const capabilityFailures: Array<Record<string, unknown>> = [];
    const allPrograms = this.listPrograms();
    const maxPrograms = options.max_programs ?? allPrograms.length;
    const routing = options.program_id ? { missing: [] } : routingShortcutForSignal(this.store, signal, new Set(allPrograms.map(program => program.id)));
    for (const missing of routing.missing) {
      this.store.appendRuntimeEvent({
        event_type: "program_runtime.routing_target_missing",
        actor: "system",
        status: "failed",
        subject_type: signal.object_kind === "view" ? "view" : "record",
        subject_id: signal.object_id,
        plugin_id: missing.program_id,
        related_views: [missing.view.id],
        payload: { signal, program_id: missing.program_id, routing_shortcut_view_id: missing.view.id },
      });
    }
    const routed = routing.selected;
    let candidatePrograms = options.program_id
      ? allPrograms.filter(program => program.id === options.program_id)
      : routed?.program_id
        ? allPrograms.filter(program => program.id === routed.program_id).slice(0, maxPrograms)
        : allPrograms.slice(0, maxPrograms);

    this.store.appendRuntimeEvent({
      event_type: "program_runtime.signal_received",
      actor: "system",
      status: "started",
      subject_type: signal.object_kind === "view" ? "view" : "record",
      subject_id: signal.object_id,
      payload: {
        signal,
        speed: options.speed,
        autonomy: options.autonomy,
        dry_run: options.dry_run,
        program_id: options.program_id,
        selected_program_ids: candidatePrograms.map(program => program.id),
        routing_shortcut_view_id: routed?.view.id,
        routing_shortcut_program_id: routed?.program_id,
        routing_missing_target_count: routing.missing.length,
        routing_missing_target_view_ids: routing.missing.map(missing => missing.view.id),
        routing_missing_target_program_ids: routing.missing.map(missing => missing.program_id),
      },
    });

    if (options.program_id && candidatePrograms.length === 0) {
      this.store.appendRuntimeEvent({
        event_type: "program_runtime.program_not_found",
        actor: "system",
        status: "failed",
        subject_type: signal.object_kind === "view" ? "view" : "record",
        subject_id: signal.object_id,
        plugin_id: options.program_id,
        payload: { signal, program_id: options.program_id },
      });
    }

    for (const program of candidatePrograms) {
      let decision;
      try {
        decision = await program.attention(signal, this.store);
      } catch (error) {
        const reason = errorMessage(error);
        decision = { action: "ignore" as const, reason, confidence: 0 };
        this.store.appendRuntimeEvent({
          event_type: "program.attention_failed",
          actor: "system",
          status: "failed",
          subject_type: signal.object_kind === "view" ? "view" : "record",
          subject_id: signal.object_id,
          plugin_id: program.id,
          payload: { reason, error: reason, signal },
        });
      }
      const attentionInfluences = decision.attention_influences?.map(influence => ({ program_id: program.id, ...influence }));
      decisions.push({ program_id: program.id, action: decision.action, reason: decision.reason, confidence: decision.confidence, capability_ids: decision.action === "run" ? decision.capability_ids : undefined, attention_influences: attentionInfluences });
      this.store.appendRuntimeEvent({
        event_type: "program.attention_decision",
        actor: "system",
        status: "completed",
        subject_type: signal.object_kind === "view" ? "view" : "record",
        subject_id: signal.object_id,
        plugin_id: program.id,
        payload: { decision, signal },
      });
      if (decision.action !== "run" && decision.action !== "attach") continue;

      if (decision.action === "attach" && decision.view) {
        const inputRecords = signal.object_kind === "observation" ? [signal.object_id] : signal.source_records ?? [];
        const inputViews = signal.object_kind === "view" ? [signal.object_id] : signal.source_views ?? [];
        const autonomyPolicy = options.autonomy ? undefined : autonomyPolicyForProgram(this.store, program);
        const resolvedAutonomy = options.autonomy ?? autonomyPolicy?.autonomy ?? program.default_autonomy;
        this.store.appendRuntimeEvent({
          event_type: "program.run.started",
          actor: "system",
          status: "started",
          subject_type: "plugin",
          subject_id: program.id,
          plugin_id: program.id,
          related_records: inputRecords,
          related_views: inputViews,
          payload: { signal, action: "attach", speed: options.speed ?? program.default_speed, autonomy: resolvedAutonomy, autonomy_policy_view_id: autonomyPolicy?.view_id, dry_run: options.dry_run },
        });
        let written: { records: ContextRecord[]; views: ContextView[]; events: RuntimeEvent[] };
        try {
          written = options.dry_run ? dryRunWriteSet(this.store, { views: [decision.view] }) : writeSet(this.store, { views: [decision.view] });
        } catch (error) {
          const reason = errorMessage(error);
          runs.push({ program_id: program.id, ok: false, reason, written_records: [], written_views: [], diagnostics: { error: reason } });
          this.store.appendRuntimeEvent({
            event_type: "program.run.failed",
            actor: "system",
            status: "failed",
            subject_type: "plugin",
            subject_id: program.id,
            plugin_id: program.id,
            related_records: inputRecords,
            related_views: inputViews,
            payload: { reason, error: reason, signal, action: "attach", speed: options.speed ?? program.default_speed, autonomy: resolvedAutonomy, autonomy_policy_view_id: autonomyPolicy?.view_id, dry_run: options.dry_run },
          });
          continue;
        }
        runs.push({ program_id: program.id, ok: true, reason: decision.reason, written_records: written.records.map(r => r.id!), written_views: written.views.map(v => v.id!) });
        this.store.appendRuntimeEvent({
          event_type: "program.run.completed",
          actor: "system",
          status: "completed",
          subject_type: "plugin",
          subject_id: program.id,
          plugin_id: program.id,
          related_records: inputRecords,
          related_views: [...new Set([...inputViews, ...written.views.map(v => v.id!)])],
          payload: { reason: decision.reason, signal, action: "attach", speed: options.speed ?? program.default_speed, autonomy: resolvedAutonomy, autonomy_policy_view_id: autonomyPolicy?.view_id, dry_run: options.dry_run },
        });
        continue;
      }

      const resolvedSpeed = decision.action === "run" ? decision.speed ?? options.speed ?? program.default_speed : options.speed ?? program.default_speed;
      const autonomyPolicy = options.autonomy ? undefined : autonomyPolicyForProgram(this.store, program);
      const resolvedAutonomy = options.autonomy ?? autonomyPolicy?.autonomy ?? program.default_autonomy;
      const inputRecords = signal.object_kind === "observation" ? [signal.object_id] : signal.source_records ?? [];
      const inputViews = signal.object_kind === "view" ? [signal.object_id] : signal.source_views ?? [];
      this.store.appendRuntimeEvent({
        event_type: "program.run.started",
        actor: "system",
        status: "started",
        subject_type: "plugin",
        subject_id: program.id,
        plugin_id: program.id,
        related_records: inputRecords,
        related_views: inputViews,
        payload: { signal, speed: resolvedSpeed, autonomy: resolvedAutonomy, autonomy_policy_view_id: autonomyPolicy?.view_id, dry_run: options.dry_run },
      });
      let result: ProgramRunResult;
      let written: { records: ContextRecord[]; views: ContextView[]; events: RuntimeEvent[] };
      try {
        result = await program.run({
          program,
          signal,
          store: this.store,
          speed: resolvedSpeed,
          autonomy: resolvedAutonomy,
          context_plugin_id: options.context_plugin_id,
          buildContextPack: (query = {}) => buildContextPack({
            ...query,
            goal: query.goal ?? `Context for ${program.id}`,
            plugin_id: query.plugin_id ?? options.context_plugin_id ?? program.id,
            scope: {
              ...(signal.domain ? { domain: signal.domain } : {}),
              ...(signal.project_path ? { project_path: signal.project_path } : {}),
              ...(signal.repo ? { repo: signal.repo } : {}),
              ...(query.scope ?? {}),
            },
          }, this.store),
          runCapability: (capabilityId, capabilityInput = {}) =>
            this.runCapability(capabilityId, {
              signal: capabilityInput.signal ?? signal,
              program,
              speed: capabilityInput.speed ?? resolvedSpeed,
              autonomy: capabilityInput.autonomy ?? resolvedAutonomy,
              context_plugin_id: options.context_plugin_id,
              dry_run: capabilityInput.dry_run ?? options.dry_run,
              payload: capabilityInput.payload,
            }).then(result => {
              if (!result.ok) {
                capabilityFailures.push({
                  program_id: program.id,
                  capability_id: capabilityId,
                  reason: result.reason,
                });
              }
              if (result.diagnostics?.policy_denied) {
                policyDenials.push({
                  program_id: program.id,
                  capability_id: capabilityId,
                  policy: result.diagnostics.policy,
                  reason: result.reason,
                  requested_autonomy: result.diagnostics.requested_autonomy,
                  required_autonomy: result.diagnostics.required_autonomy,
                  related_records: result.diagnostics.related_records,
                  related_views: result.diagnostics.related_views,
                });
              }
              return result;
            }),
        });
        written = options.dry_run ? dryRunWriteSet(this.store, result) : writeSet(this.store, result);
      } catch (error) {
        const reason = errorMessage(error);
        runs.push({ program_id: program.id, ok: false, reason, written_records: [], written_views: [], diagnostics: { error: reason } });
        this.store.appendRuntimeEvent({
          event_type: "program.run.failed",
          actor: "system",
          status: "failed",
          subject_type: "plugin",
          subject_id: program.id,
          plugin_id: program.id,
          related_records: inputRecords,
          related_views: inputViews,
          payload: { reason, error: reason, signal, speed: resolvedSpeed, autonomy: resolvedAutonomy, autonomy_policy_view_id: autonomyPolicy?.view_id, dry_run: options.dry_run },
        });
        continue;
      }
      runs.push({
        program_id: program.id,
        ok: result.ok,
        reason: result.reason,
        written_records: written.records.map(r => r.id!),
        written_views: written.views.map(v => v.id!),
        diagnostics: result.diagnostics,
      });
      this.store.appendRuntimeEvent({
        event_type: result.ok ? "program.run.completed" : "program.run.failed",
        actor: "system",
        status: result.ok ? "completed" : "failed",
        subject_type: "plugin",
        subject_id: program.id,
        plugin_id: program.id,
        related_records: [...new Set([...inputRecords, ...written.records.map(r => r.id!)])],
        related_views: [...new Set([...inputViews, ...written.views.map(v => v.id!)])],
        payload: { reason: result.reason, diagnostics: eventSafeDiagnostics(result.diagnostics), signal, speed: resolvedSpeed, autonomy: resolvedAutonomy, autonomy_policy_view_id: autonomyPolicy?.view_id, dry_run: options.dry_run },
      });
    }

    const skippedPrograms = decisions
      .filter(decision => decision.action !== "run" && decision.action !== "attach")
      .map(decision => ({
        program_id: decision.program_id,
        action: decision.action,
        reason: decision.reason,
      }));

    return {
      ok: true,
      generated_at: generatedAt,
      signal,
      decisions,
      runs,
      diagnostics: {
        program_count: this.programs.size,
        candidate_program_count: candidatePrograms.length,
        selected_program_ids: candidatePrograms.map(program => program.id),
        skipped_program_ids: skippedPrograms.map(program => program.program_id),
        skipped_programs: skippedPrograms,
        requested_capability_ids: [...new Set(decisions.flatMap(decision => decision.capability_ids ?? []))],
        attention_influences: decisions.flatMap(decision => decision.attention_influences ?? []),
        policy_denials: policyDenials.map(compactObject),
        capability_failures: capabilityFailures.map(compactObject),
        capability_count: this.capabilities.size,
        dry_run: Boolean(options.dry_run),
        program_id: options.program_id,
        routing_shortcut_view_id: routed?.view.id,
        routing_shortcut_program_id: routed?.program_id,
        routing_missing_target_count: routing.missing.length,
        routing_missing_target_view_ids: routing.missing.map(missing => missing.view.id),
        routing_missing_target_program_ids: routing.missing.map(missing => missing.program_id),
      },
    };
  }

  async runCapability(capabilityId: string, input: { signal: ContextSignal; program?: Program; speed?: SpeedTier; autonomy?: AutonomyProfile; context_plugin_id?: string; dry_run?: boolean; payload?: Record<string, unknown> }): Promise<CapabilityRunResult & { written_records?: string[]; written_views?: string[] }> {
    const eventCapabilityInput = eventSafeCapabilityInput(capabilityId, input.payload);
    const capability = this.capabilities.get(capabilityId);
    if (!capability) {
      const reason = `capability not found: ${capabilityId}`;
      this.store.appendRuntimeEvent({
        event_type: "capability.run.failed",
        actor: "system",
        status: "failed",
        subject_type: "plugin",
        subject_id: capabilityId,
        plugin_id: capabilityId,
        related_records: input.signal.object_kind === "observation" ? [input.signal.object_id] : input.signal.source_records,
        related_views: input.signal.object_kind === "view" ? [input.signal.object_id] : input.signal.source_views,
        payload: { reason, signal: input.signal, program_id: input.program?.id, speed: input.speed, autonomy: input.autonomy, dry_run: input.dry_run, capability_input: eventCapabilityInput },
      });
      return { ok: false, reason, written_records: [], written_views: [] };
    }
    const autonomyPolicy = input.autonomy ? undefined : autonomyPolicyForCapability(this.store, capability);
    const requestedAutonomy = input.autonomy ?? autonomyPolicy?.autonomy ?? "manual";
    const requiredAutonomy = capability.default_autonomy ?? "manual";
    if (!autonomyAllows(requestedAutonomy, requiredAutonomy)) {
      const reason = `denied: capability ${capability.id} requires ${requiredAutonomy} autonomy, got ${requestedAutonomy}`;
      this.store.appendRuntimeEvent({
        event_type: "policy.denied_action",
        actor: "system",
        status: "denied",
        subject_type: "plugin",
        subject_id: capability.id,
        plugin_id: capability.id,
        related_records: input.signal.object_kind === "observation" ? [input.signal.object_id] : input.signal.source_records,
        related_views: input.signal.object_kind === "view" ? [input.signal.object_id] : input.signal.source_views,
        payload: { reason, requested_autonomy: requestedAutonomy, required_autonomy: requiredAutonomy, autonomy_policy_view_id: autonomyPolicy?.view_id, signal: input.signal, program_id: input.program?.id, speed: input.speed, capability_input: eventCapabilityInput },
      });
      return {
        ok: false,
        reason,
        diagnostics: {
          policy_denied: true,
          policy: "autonomy",
          ...(input.program?.id ? { program_id: input.program.id } : {}),
          requested_autonomy: requestedAutonomy,
          required_autonomy: requiredAutonomy,
        },
        written_records: [],
        written_views: [],
      };
    }
    const privacyDenial = privacyDenialForCapability(this.store, capability, input.signal);
    if (privacyDenial) {
      this.store.appendRuntimeEvent({
        event_type: "policy.denied_action",
        actor: "system",
        status: "denied",
        subject_type: "plugin",
        subject_id: capability.id,
        plugin_id: capability.id,
        related_records: privacyDenial.related_records,
        related_views: privacyDenial.related_views,
        payload: { reason: privacyDenial.reason, policy: privacyDenial.policy, signal: input.signal, program_id: input.program?.id, speed: input.speed, autonomy: requestedAutonomy, capability_input: eventCapabilityInput },
      });
      return {
        ok: false,
        reason: privacyDenial.reason,
        diagnostics: {
          policy_denied: true,
          policy: privacyDenial.policy,
          ...(input.program?.id ? { program_id: input.program.id } : {}),
          related_records: privacyDenial.related_records,
          related_views: privacyDenial.related_views,
        },
        written_records: [],
        written_views: [],
      };
    }
    if (input.dry_run && capability.mode === "external") {
      const reason = `dry_run skipped external capability: ${capability.id}`;
      this.store.appendRuntimeEvent({
        event_type: "capability.run.skipped",
        actor: "system",
        status: "completed",
        subject_type: "plugin",
        subject_id: capability.id,
        plugin_id: capability.id,
        related_records: input.signal.object_kind === "observation" ? [input.signal.object_id] : input.signal.source_records,
        related_views: input.signal.object_kind === "view" ? [input.signal.object_id] : input.signal.source_views,
        payload: { reason, signal: input.signal, program_id: input.program?.id, speed: input.speed, autonomy: requestedAutonomy, autonomy_policy_view_id: autonomyPolicy?.view_id, dry_run: input.dry_run, capability_input: eventCapabilityInput },
      });
      return { ok: true, reason, written_records: [], written_views: [], diagnostics: { dry_run_skipped: true, mode: capability.mode } };
    }
    this.store.appendRuntimeEvent({
      event_type: "capability.run.started",
      actor: "system",
      status: "started",
      subject_type: "plugin",
      subject_id: capability.id,
      plugin_id: capability.id,
      related_records: input.signal.object_kind === "observation" ? [input.signal.object_id] : input.signal.source_records,
      related_views: input.signal.object_kind === "view" ? [input.signal.object_id] : input.signal.source_views,
      payload: { signal: input.signal, program_id: input.program?.id, speed: input.speed, autonomy: requestedAutonomy, autonomy_policy_view_id: autonomyPolicy?.view_id, dry_run: input.dry_run, capability_input: eventCapabilityInput },
    });

    let result: CapabilityRunResult;
    let written: { records: ContextRecord[]; views: ContextView[]; events: RuntimeEvent[] };
    try {
      result = await capability.run({ capability, program: input.program, signal: input.signal, store: this.store, speed: input.speed, autonomy: input.autonomy, context_plugin_id: input.context_plugin_id, dry_run: input.dry_run, payload: input.payload });
      written = input.dry_run ? dryRunWriteSet(this.store, result) : writeSet(this.store, result);
    } catch (error) {
      const reason = errorMessage(error);
      this.store.appendRuntimeEvent({
        event_type: "capability.run.failed",
        actor: "system",
        status: "failed",
        subject_type: "plugin",
        subject_id: capability.id,
        plugin_id: capability.id,
        related_records: input.signal.object_kind === "observation" ? [input.signal.object_id] : input.signal.source_records,
        related_views: input.signal.object_kind === "view" ? [input.signal.object_id] : input.signal.source_views,
        payload: { reason, error: reason, signal: input.signal, program_id: input.program?.id, speed: input.speed, autonomy: requestedAutonomy, dry_run: input.dry_run, capability_input: eventCapabilityInput },
      });
      return { ok: false, reason, diagnostics: { error: reason }, written_records: [], written_views: [] };
    }
    const writtenRecords = written.records.map(r => r.id!);
    const writtenViews = written.views.map(v => v.id!);
    this.store.appendRuntimeEvent({
      event_type: result.ok ? "capability.run.completed" : "capability.run.failed",
      actor: "system",
      status: result.ok ? "completed" : "failed",
      subject_type: "plugin",
      subject_id: capability.id,
      plugin_id: capability.id,
      related_records: [...new Set([...(input.signal.object_kind === "observation" ? [input.signal.object_id] : input.signal.source_records ?? []), ...writtenRecords])],
      related_views: [...new Set([...(input.signal.object_kind === "view" ? [input.signal.object_id] : input.signal.source_views ?? []), ...writtenViews])],
      payload: { reason: result.reason, diagnostics: eventSafeDiagnostics(result.diagnostics), signal: input.signal, program_id: input.program?.id, speed: input.speed, autonomy: requestedAutonomy, autonomy_policy_view_id: autonomyPolicy?.view_id, dry_run: input.dry_run, capability_input: eventCapabilityInput },
    });
    return { ...result, written_records: input.dry_run ? [] : writtenRecords, written_views: input.dry_run ? [] : writtenViews };
  }
}

function autonomyPolicyForCapability(store: ContextStore, capability: Capability): { autonomy: AutonomyProfile; view_id: string } | undefined {
  const policies = filterViewsForPlugin(store.listViews({ view_types: ["policy.autonomy_profile"], limit: 200 }), store).filter(activePolicyView);
  const global: Array<{ autonomy: AutonomyProfile; view_id: string }> = [];
  for (const view of policies) {
    const forCapabilities = Array.isArray(view.content?.capability_ids) ? view.content.capability_ids : undefined;
    const value = view.content?.default_autonomy;
    if (!isAutonomyProfile(value)) continue;
    if (forCapabilities?.includes(capability.id)) return { autonomy: value, view_id: view.id };
    if (!forCapabilities) global.push({ autonomy: value, view_id: view.id });
  }
  return global[0];
}

function autonomyPolicyForProgram(store: ContextStore, program: Program): { autonomy: AutonomyProfile; view_id: string } | undefined {
  const policies = filterViewsForPlugin(store.listViews({ view_types: ["policy.autonomy_profile"], limit: 200 }), store).filter(activePolicyView);
  const global: Array<{ autonomy: AutonomyProfile; view_id: string }> = [];
  for (const view of policies) {
    const forPrograms = Array.isArray(view.content?.program_ids) ? view.content.program_ids : undefined;
    const value = view.content?.default_autonomy;
    if (!isAutonomyProfile(value)) continue;
    if (forPrograms?.includes(program.id)) return { autonomy: value, view_id: view.id };
    if (!forPrograms) global.push({ autonomy: value, view_id: view.id });
  }
  return global[0];
}

function activePolicyView(view: StoredContextView): boolean {
  if ((view.confidence ?? 1) < 0.5) return false;
  return activeContextView(view);
}

function isAutonomyProfile(value: unknown): value is AutonomyProfile {
  return value === "manual" || value === "suggest" || value === "draft" || value === "sandbox_auto" || value === "full_auto";
}

function autonomyAllows(requested: AutonomyProfile, required: AutonomyProfile): boolean {
  return autonomyRank(requested) >= autonomyRank(required);
}

function autonomyRank(value: AutonomyProfile): number {
  return {
    manual: 0,
    suggest: 1,
    draft: 2,
    sandbox_auto: 3,
    full_auto: 4,
  }[value];
}


function eventSafeCapabilityInput(capabilityId: string, payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!payload || capabilityId !== "capability.agent_task.submit") return payload;
  const task = payload.task;
  if (!task || typeof task !== "object") return payload;
  const sanitizedTask = { ...(task as Record<string, unknown>) };
  delete sanitizedTask.skills;
  delete sanitizedTask.tools;
  if (sanitizedTask.context_pack && typeof sanitizedTask.context_pack === "object") {
    sanitizedTask.context_pack = eventSafeContextPack(sanitizedTask.context_pack as Record<string, unknown>);
  }
  return { ...payload, task: sanitizedTask };
}

function eventSafeContextPack(pack: Record<string, unknown>): Record<string, unknown> {
  return compactObject({
    markdown_length: typeof pack.markdown === "string" ? pack.markdown.length : undefined,
    source_count: Array.isArray(pack.sources) ? pack.sources.length : undefined,
    diagnostics: pack.diagnostics && typeof pack.diagnostics === "object" ? pack.diagnostics as Record<string, unknown> : undefined,
  });
}

function eventSafeDiagnostics(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(eventSafeDiagnostics);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "prompt_preview" && typeof item === "string") {
      output.prompt_preview_length = item.length;
      continue;
    }
    output[key] = eventSafeDiagnostics(item);
  }
  return output;
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function privacyDenialForCapability(store: ContextStore, capability: Capability, signal: ContextSignal): { reason: string; policy: string; related_records: string[]; related_views: string[] } | undefined {
  if (capability.mode !== "llm" && capability.mode !== "external") return undefined;
  const sources = privacySourcesForSignal(store, signal);
  const llmDenied = sources.records.find(record => record.privacy?.allow_external_llm === false) ?? sources.views.find(view => view.privacy?.allow_external_llm === false);
  if (capability.mode === "llm" && llmDenied) {
    return {
      reason: `privacy denied: ${signal.object_kind} ${signal.object_id} includes provenance that disallows external LLM use`,
      policy: "privacy.external_llm",
      related_records: sources.records.map(record => record.id),
      related_views: sources.views.map(view => view.id),
    };
  }
  const readerDenied = sources.records.find(record => record.privacy?.allow_external_reader === false) ?? sources.views.find(view => view.privacy?.allow_external_reader === false);
  if (capability.mode === "external" && readerDenied) {
    return {
      reason: `privacy denied: ${signal.object_kind} ${signal.object_id} includes provenance that disallows external reader/action use`,
      policy: "privacy.external_reader",
      related_records: sources.records.map(record => record.id),
      related_views: sources.views.map(view => view.id),
    };
  }
  return undefined;
}

function privacySourcesForSignal(store: ContextStore, signal: ContextSignal): { records: StoredContextRecord[]; views: StoredContextView[] } {
  const records = new Map<string, StoredContextRecord>();
  const views = new Map<string, StoredContextView>();
  if (signal.object_kind === "observation") {
    const record = store.getRecord(signal.object_id);
    if (record) records.set(record.id, record);
  } else {
    collectViewPrivacySources(store, signal.object_id, records, views, 0);
  }
  for (const id of signal.source_records ?? []) {
    const record = store.getRecord(id);
    if (record) records.set(record.id, record);
  }
  for (const id of signal.source_views ?? []) collectViewPrivacySources(store, id, records, views, 0);
  return { records: [...records.values()], views: [...views.values()] };
}

function collectViewPrivacySources(store: ContextStore, viewId: string, records: Map<string, StoredContextRecord>, views: Map<string, StoredContextView>, depth: number): void {
  if (depth > 3 || views.has(viewId)) return;
  const view = store.getView(viewId);
  if (!view) return;
  views.set(view.id, view);
  for (const id of view.source_records ?? []) {
    const record = store.getRecord(id);
    if (record) records.set(record.id, record);
  }
  for (const id of view.source_views ?? []) collectViewPrivacySources(store, id, records, views, depth + 1);
}

function routingShortcutForSignal(store: ContextStore, signal: ContextSignal, availableProgramIds: Set<string>): { selected?: { program_id: string; view: StoredContextView }; missing: Array<{ program_id: string; view: StoredContextView }> } {
  const shortcuts = filterViewsForPlugin(store.listViews({ view_types: ["routing.shortcut"], limit: 200 }), store);
  const missing: Array<{ program_id: string; view: StoredContextView }> = [];
  for (const item of shortcuts
    .filter(activeRoutingShortcut)
    .filter(view => (view.confidence ?? 0) >= 0.5)
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .map(view => ({ view, program_id: programIdFromShortcut(view), match: view.content?.match }))
    .filter((item): item is { view: StoredContextView; program_id: string; match: unknown } => Boolean(item.program_id))
    .filter(item => shortcutMatches(item.match, signal))) {
    if (availableProgramIds.has(item.program_id)) return { selected: { program_id: item.program_id, view: item.view }, missing };
    missing.push({ program_id: item.program_id, view: item.view });
  }
  return { missing };
}

function activeRoutingShortcut(view: StoredContextView): boolean {
  return activeContextView(view);
}

function programIdFromShortcut(view: StoredContextView): string | undefined {
  const value = view.content?.program_id ?? view.scope?.plugin_id;
  return typeof value === "string" && value.startsWith("program.") ? value : undefined;
}

function shortcutMatches(match: unknown, signal: ContextSignal): boolean {
  if (!match || typeof match !== "object") return false;
  const expected = match as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    const actual = (signal as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      if (!value.includes(actual)) return false;
    } else if (value !== actual) {
      return false;
    }
  }
  return true;
}

function writeSet(store: ContextStore, set: ContextWriteSet): { records: ContextRecord[]; views: ContextView[]; events: RuntimeEvent[] } {
  validateWriteSet(store, set);
  const records = (set.records ?? []).map(record => store.insertRecord(record));
  const views = (set.views ?? []).map(view => store.upsertView(view));
  const events = (set.events ?? []).map(event => store.appendRuntimeEvent(event));
  return { records, views, events };
}

function dryRunWriteSet(store: ContextStore, set: ContextWriteSet): { records: ContextRecord[]; views: ContextView[]; events: RuntimeEvent[] } {
  validateWriteSet(store, set);
  return { records: set.records ?? [], views: set.views ?? [], events: set.events ?? [] };
}

function validateWriteSet(store: ContextStore, set: ContextWriteSet): void {
  const writeSetRecordSchemas = new Map<string, string>();
  const writeSetRecordIds = new Set<string>();
  for (const record of set.records ?? []) {
    const error = validateRecordSchema(record.schema.name);
    if (error) throw new Error(error);
    if (record.id) {
      writeSetRecordSchemas.set(record.id, record.schema.name);
      writeSetRecordIds.add(record.id);
    }
  }
  const writeSetViews = new Map((set.views ?? []).filter((view): view is ContextView & { id: string } => Boolean(view.id)).map(view => [view.id, view]));
  for (const view of set.views ?? []) {
    validateViewProvenance(store, view, writeSetRecordSchemas, writeSetViews);
  }
  for (const view of set.views ?? []) {
    const error = validateViewType(view.view_type);
    if (error) throw new Error(error);
  }
  for (const event of set.events ?? []) {
    validateEventProvenance(store, event, writeSetRecordIds, writeSetViews);
  }
}

function validateViewProvenance(store: ContextStore, view: ContextView, writeSetRecordSchemas: Map<string, string>, writeSetViews: Map<string, ContextView>): void {
  for (const id of view.source_records ?? []) {
    const source = store.getRecord(id);
    const schemaName = writeSetRecordSchemas.get(id) ?? source?.schema.name;
    if (!schemaName || validateRecordSchema(schemaName)) throw new Error(`View source_record must reference an existing raw observation/feedback Record: ${id}`);
    if (source && !scopeCompatible(view.scope, source.scope)) throw new Error(`View scope conflicts with provenance source_record: ${id}`);
  }
  for (const id of view.source_views ?? []) {
    const source = writeSetViews.get(id) ?? store.getView(id);
    if (!source) throw new Error(`View source_view must reference an existing View: ${id}`);
    if (!scopeCompatible(view.scope, source.scope)) throw new Error(`View scope conflicts with provenance source_view: ${id}`);
  }
}

function scopeCompatible(target?: ContextView["scope"], source?: ContextView["scope"]): boolean {
  if (!target || !source) return true;
  for (const key of ["project", "project_path", "repo", "domain", "app", "session"] as const) {
    if (target[key] && source[key] && target[key] !== source[key]) return false;
  }
  return true;
}

function validateEventProvenance(store: ContextStore, event: RuntimeEvent, writeSetRecordIds: Set<string>, writeSetViews: Map<string, ContextView>): void {
  for (const id of event.related_records ?? []) {
    const record = store.getRecord(id);
    if (!writeSetRecordIds.has(id) && (!record || validateRecordSchema(record.schema.name))) {
      throw new Error(`Event related_record must reference an existing raw observation/feedback Record: ${id}`);
    }
  }
  for (const id of event.related_views ?? []) {
    if (!writeSetViews.has(id) && !store.getView(id)) throw new Error(`Event related_view must reference an existing View: ${id}`);
  }
}

function validateRecordSchema(schemaName: string): string | undefined {
  if (!/^(observation|feedback)(\.|$)/.test(schemaName)) return `Record schema must be raw observation/feedback: ${schemaName}`;
  return undefined;
}

function validateViewType(viewType: string): string | undefined {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(viewType)) return `invalid View type: ${viewType}`;
  if (/^(observation|feedback|episode|derived)(\.|$)/.test(viewType)) return `View type must not use record-like prefix: ${viewType}`;
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
