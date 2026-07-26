import {
  DeclaredMethodIdsSchema,
  RendererLifecycleEventSchema,
  WEB_RENDERER_ABI_VERSION,
  WebRendererDescriptorSchema,
  WebRendererIdentitySchema,
  WebRendererInputSchema,
  rendererIdentityKey,
  type MountedWebRenderer,
  type MountWebRendererRequest,
  type RendererHostServices,
  type WebRendererDescriptor,
  type WebRendererDisposableV1,
  type WebRendererFactoryV1,
  type WebRendererIdentity,
  type WebRendererInput,
  type WebRendererRegistration,
} from "./contracts.js";
import { WebRendererError } from "./errors.js";
import { createWebRendererHostSession, type HostLifecycleDetail } from "./host.js";

type StoredRegistration = WebRendererRegistration & { loaded?: Promise<unknown> };

export class WebRendererRegistry {
  private readonly registrations = new Map<string, StoredRegistration>();

  constructor(registrations: readonly WebRendererRegistration[] = []) {
    for (const registration of registrations) this.register(registration);
  }

  register(registration: WebRendererRegistration): void {
    const descriptor = WebRendererIdentitySchema.safeParse(registration.descriptor);
    if (!descriptor.success || typeof registration.load !== "function") {
      throw new WebRendererError("Web Renderer registration failed validation", "invalid_registration", {
        issue_count: descriptor.success ? 0 : descriptor.error.issues.length,
      }, descriptor.success ? undefined : { cause: descriptor.error });
    }
    const key = rendererIdentityKey(descriptor.data);
    if (this.registrations.has(key)) {
      throw new WebRendererError(`Duplicate Web Renderer registration: ${key}`, "duplicate_registration", {
        renderer: key,
      });
    }
    this.registrations.set(key, { descriptor: descriptor.data, load: registration.load });
  }

  list(): WebRendererIdentity[] {
    return [...this.registrations.values()]
      .map(registration => registration.descriptor)
      .sort(compareIdentities);
  }

  select(descriptorsInput: readonly unknown[], inputValue: WebRendererInput): WebRendererDescriptor {
    const descriptors = descriptorsInput.map((descriptorInput, index) => {
      const descriptor = WebRendererDescriptorSchema.safeParse(descriptorInput);
      if (!descriptor.success) {
        throw new WebRendererError(`Web Renderer descriptor ${index} failed validation`, "invalid_descriptor", {
          descriptor_index: index,
          issue_count: descriptor.error.issues.length,
        }, { cause: descriptor.error });
      }
      return descriptor.data;
    });
    const matches = descriptors
      .filter(descriptor => descriptor.schema.name === inputValue.envelope.schema.name
        && descriptor.schema.version === inputValue.envelope.schema.version)
      .filter(descriptor => descriptor.surfaces.includes("web"))
      .filter(descriptor => descriptor.representation_kinds.includes(inputValue.representation.kind))
      .filter(descriptor => descriptor.media_types === undefined
        || (inputValue.representation.media_type !== undefined
          && descriptor.media_types.includes(inputValue.representation.media_type)))
      .sort(compareDescriptors);
    const selected = matches[0];
    if (!selected) {
      throw new WebRendererError("No Web Renderer descriptor matches the exact View input", "no_matching_renderer", {
        schema: `${inputValue.envelope.schema.name}@${inputValue.envelope.schema.version}`,
        representation_kind: inputValue.representation.kind,
      });
    }
    return selected;
  }

  async mount(request: MountWebRendererRequest): Promise<MountedWebRenderer> {
    const parsedInput = WebRendererInputSchema.safeParse(request.input);
    const declaredMethodIds = DeclaredMethodIdsSchema.safeParse(request.declared_method_ids);
    if (!parsedInput.success || !declaredMethodIds.success || !request.container || typeof request.container !== "object") {
      throw new WebRendererError("Web Renderer input failed validation", "invalid_input", {
        issue_count: (parsedInput.success ? 0 : parsedInput.error.issues.length)
          + (declaredMethodIds.success ? 0 : declaredMethodIds.error.issues.length),
      }, {
        cause: new AggregateError([
          ...(parsedInput.success ? [] : [parsedInput.error]),
          ...(declaredMethodIds.success ? [] : [declaredMethodIds.error]),
        ], "Web Renderer input validation failed"),
      });
    }
    const rendererInput = parsedInput.data;
    const descriptor = this.select(request.descriptors, rendererInput);
    const lifecycle = createLifecycleEmitter(request.services, descriptor, rendererInput);
    const registration = this.resolveRegistration(descriptor);
    if (request.signal.aborted) {
      const emissionFailure = captureFailure(() => lifecycle({ event: "renderer.aborted", stage: "load" }));
      throw abortedError(descriptor, "load", emissionFailure);
    }

    lifecycle({ event: "renderer.load.started" });
    const loadStartedAt = monotonicNow(request.services);
    let factory: WebRendererFactoryV1;
    try {
      const loaded = await withAbort(this.load(registration), request.signal, "load");
      factory = parseFactory(loaded, descriptor);
    } catch (error) {
      if (request.signal.aborted || isAborted(error)) {
        const emissionFailure = captureFailure(() => lifecycle({ event: "renderer.aborted", stage: "load" }));
        throw abortedError(descriptor, "load", aggregateFailures([error, emissionFailure], "Renderer load abort failed"));
      }
      const emissionFailure = captureFailure(() => lifecycle({
        event: "renderer.load.failed",
        duration_ms: elapsed(loadStartedAt, monotonicNow(request.services)),
        error_code: "load_failed",
      }));
      throw new WebRendererError(`Web Renderer failed to load: ${rendererIdentityKey(descriptor)}`, "load_failed", {
        renderer: rendererIdentityKey(descriptor),
      }, { cause: aggregateFailures([error, emissionFailure], "Renderer load failed") });
    }
    lifecycle({
      event: "renderer.load.succeeded",
      duration_ms: elapsed(loadStartedAt, monotonicNow(request.services)),
    });

    const hostSession = createWebRendererHostSession({
      rendererInput,
      declaredMethodIds: declaredMethodIds.data,
      services: request.services,
      emit: lifecycle,
    });
    const rendererSignal = linkedAbortController(request.signal);
    try {
      lifecycle({ event: "renderer.mount.started" });
    } catch (error) {
      rendererSignal.controller.abort();
      rendererSignal.dispose();
      throw new WebRendererError(`Web Renderer mount telemetry failed: ${rendererIdentityKey(descriptor)}`, "mount_failed", {
        renderer: rendererIdentityKey(descriptor),
      }, { cause: error });
    }
    const mountStartedAt = monotonicNow(request.services);
    let disposable: WebRendererDisposableV1;
    const mountPromise = Promise.resolve().then(() =>
      factory.mount(request.container, rendererInput, hostSession.host, rendererSignal.controller.signal));
    try {
      disposable = await withAbort(mountPromise, rendererSignal.controller.signal, "mount");
      if (!disposable || typeof disposable.dispose !== "function") {
        throw new TypeError("Web Renderer mount must return a disposable");
      }
    } catch (error) {
      rendererSignal.controller.abort();
      const aborted = request.signal.aborted || isAborted(error);
      if (aborted) {
        scheduleLateMountDisposal({
          descriptor,
          lifecycle,
          mountPromise,
          releaseAssets: hostSession.releaseAssets,
          rendererSignal,
          services: request.services,
        });
      }
      let mountError = error;
      try {
        await releaseAfterFailedMount(hostSession.releaseAssets, error);
      } catch (cleanupError) {
        mountError = cleanupError;
      } finally {
        rendererSignal.dispose();
      }
      if (aborted) {
        const emissionFailure = captureFailure(() => lifecycle({ event: "renderer.aborted", stage: "mount" }));
        throw abortedError(descriptor, "mount", aggregateFailures([mountError, emissionFailure], "Renderer mount abort failed"));
      }
      const emissionFailure = captureFailure(() => lifecycle({
        event: "renderer.mount.failed",
        duration_ms: elapsed(mountStartedAt, monotonicNow(request.services)),
        error_code: "mount_failed",
      }));
      throw new WebRendererError(`Web Renderer failed to mount: ${rendererIdentityKey(descriptor)}`, "mount_failed", {
        renderer: rendererIdentityKey(descriptor),
      }, { cause: aggregateFailures([mountError, emissionFailure], "Renderer mount failed") });
    }
    if (request.signal.aborted) {
      throw await abortMountedBeforeReturn({
        descriptor,
        disposable,
        lifecycle,
        releaseAssets: hostSession.releaseAssets,
        rendererSignal,
        services: request.services,
      });
    }
    try {
      lifecycle({
        event: "renderer.ready",
        duration_ms: elapsed(mountStartedAt, monotonicNow(request.services)),
      });
    } catch (error) {
      const cleanupFailures = await cleanupMountedWithLifecycle({
        disposable,
        lifecycle,
        releaseAssets: hostSession.releaseAssets,
        rendererSignal,
        services: request.services,
      });
      throw new WebRendererError(`Web Renderer ready telemetry failed: ${rendererIdentityKey(descriptor)}`, "mount_failed", {
        renderer: rendererIdentityKey(descriptor),
      }, { cause: aggregateFailures([error, ...cleanupFailures], "Renderer ready and cleanup failed") });
    }
    if (request.signal.aborted) {
      throw await abortMountedBeforeReturn({
        descriptor,
        disposable,
        lifecycle,
        releaseAssets: hostSession.releaseAssets,
        rendererSignal,
        services: request.services,
      });
    }

    let disposePromise: Promise<void> | undefined;
    const pendingDisposeFailures: unknown[] = [];
    let resolveDisposed!: () => void;
    let rejectDisposed!: (error: unknown) => void;
    const disposed = new Promise<void>((resolve, reject) => {
      resolveDisposed = resolve;
      rejectDisposed = reject;
    });
    let abortHandled = false;
    const disposeWithFailures = (initialFailures: readonly unknown[] = []): Promise<void> => {
      pendingDisposeFailures.push(...initialFailures.filter(failure => failure !== undefined));
      if (disposePromise) return disposePromise;
      request.signal.removeEventListener("abort", onAbort);
      disposePromise = (async () => {
        const cleanupFailures = await cleanupMountedWithLifecycle({
          disposable,
          lifecycle,
          releaseAssets: hostSession.releaseAssets,
          rendererSignal,
          services: request.services,
        });
        const failures = [...pendingDisposeFailures, ...cleanupFailures];
        if (failures.length > 0) {
          throw new WebRendererError(`Web Renderer failed to dispose: ${rendererIdentityKey(descriptor)}`, "dispose_failed", {
            renderer: rendererIdentityKey(descriptor),
          }, { cause: aggregateFailures(failures, "Renderer disposal failed") });
        }
      })();
      disposePromise.then(resolveDisposed, rejectDisposed);
      return disposePromise;
    };
    const onAbort = () => {
      if (abortHandled) return;
      abortHandled = true;
      const emissionFailure = captureFailure(() => lifecycle({ event: "renderer.aborted", stage: "active" }));
      void disposeWithFailures(emissionFailure === undefined ? [] : [emissionFailure]);
    };
    const dispose = (): Promise<void> => disposeWithFailures();
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();

    return Object.freeze({ descriptor, disposed, dispose });
  }

  private resolveRegistration(descriptor: WebRendererDescriptor): StoredRegistration {
    if (descriptor.abi_version !== WEB_RENDERER_ABI_VERSION) {
      throw new WebRendererError(`Web Renderer ABI is unsupported: ${rendererIdentityKey(descriptor)}`, "abi_mismatch", {
        renderer_id: descriptor.id,
        renderer_version: descriptor.version,
        descriptor_abi: descriptor.abi_version,
        supported_abi: WEB_RENDERER_ABI_VERSION,
      });
    }
    const exact = this.registrations.get(rendererIdentityKey(descriptor));
    if (exact) return exact;
    const incompatible = [...this.registrations.values()].filter(registration =>
      registration.descriptor.id === descriptor.id && registration.descriptor.version === descriptor.version,
    );
    if (incompatible.length > 0) {
      throw new WebRendererError(`Web Renderer ABI mismatch: ${rendererIdentityKey(descriptor)}`, "abi_mismatch", {
        renderer_id: descriptor.id,
        renderer_version: descriptor.version,
        expected_abi: descriptor.abi_version,
        installed_abis: incompatible.map(item => item.descriptor.abi_version).sort((a, b) => a - b).join(","),
      });
    }
    throw new WebRendererError(`Web Renderer implementation is not installed: ${rendererIdentityKey(descriptor)}`, "missing_registration", {
      renderer: rendererIdentityKey(descriptor),
    });
  }

  private load(registration: StoredRegistration): Promise<unknown> {
    registration.loaded ??= Promise.resolve().then(() => registration.load());
    return registration.loaded;
  }
}

function createLifecycleEmitter(
  services: RendererHostServices,
  descriptor: WebRendererDescriptor,
  input: WebRendererInput,
): (detail: HostLifecycleDetail) => void {
  return (detail) => {
    services.emit(RendererLifecycleEventSchema.parse({
      contract_version: 1,
      occurred_at: (services.now?.() ?? new Date()).toISOString(),
      renderer: {
        id: descriptor.id,
        version: descriptor.version,
        abi_version: descriptor.abi_version,
      },
      view: input.view,
      surface: "web",
      mode: input.mode,
      ...detail,
    }));
  };
}

function parseFactory(value: unknown, descriptor: WebRendererDescriptor): WebRendererFactoryV1 {
  if (!value || typeof value !== "object" || typeof (value as { mount?: unknown }).mount !== "function") {
    throw new WebRendererError(`Web Renderer module does not implement ABI ${descriptor.abi_version}`, "load_failed", {
      renderer: rendererIdentityKey(descriptor),
    });
  }
  return value as WebRendererFactoryV1;
}

async function disposeMounted(disposable: WebRendererDisposableV1, releaseAssets: () => Promise<void>): Promise<void> {
  const failures: unknown[] = [];
  try {
    await disposable.dispose();
  } catch (error) {
    failures.push(error);
  }
  try {
    await releaseAssets();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) throw new AggregateError(failures, "Renderer disposal failed");
}

async function releaseAfterFailedMount(releaseAssets: () => Promise<void>, mountError: unknown): Promise<void> {
  try {
    await releaseAssets();
  } catch (releaseError) {
    throw new AggregateError([mountError, releaseError], "Renderer mount and asset release failed");
  }
}

type LifecycleEmitter = (detail: HostLifecycleDetail) => void;
type LinkedRendererSignal = ReturnType<typeof linkedAbortController>;

async function cleanupMountedWithLifecycle(input: {
  disposable: WebRendererDisposableV1;
  lifecycle: LifecycleEmitter;
  releaseAssets: () => Promise<void>;
  rendererSignal: LinkedRendererSignal;
  services: RendererHostServices;
}): Promise<unknown[]> {
  const failures: unknown[] = [];
  const disposeStartedAt = monotonicNow(input.services);
  const startedFailure = captureFailure(() => input.lifecycle({ event: "renderer.dispose.started" }));
  if (startedFailure !== undefined) failures.push(startedFailure);
  input.rendererSignal.controller.abort();
  let cleanupFailure: unknown;
  try {
    await disposeMounted(input.disposable, input.releaseAssets);
  } catch (error) {
    cleanupFailure = error;
    failures.push(error);
  } finally {
    input.rendererSignal.dispose();
  }
  const terminalFailure = captureFailure(() => input.lifecycle(cleanupFailure === undefined ? {
    event: "renderer.dispose.succeeded",
    duration_ms: elapsed(disposeStartedAt, monotonicNow(input.services)),
  } : {
    event: "renderer.dispose.failed",
    duration_ms: elapsed(disposeStartedAt, monotonicNow(input.services)),
    error_code: "dispose_failed",
  }));
  if (terminalFailure !== undefined) failures.push(terminalFailure);
  return failures;
}

async function abortMountedBeforeReturn(input: {
  descriptor: WebRendererDescriptor;
  disposable: WebRendererDisposableV1;
  lifecycle: LifecycleEmitter;
  releaseAssets: () => Promise<void>;
  rendererSignal: LinkedRendererSignal;
  services: RendererHostServices;
}): Promise<WebRendererError> {
  const failures: unknown[] = [];
  const emissionFailure = captureFailure(() => input.lifecycle({ event: "renderer.aborted", stage: "mount" }));
  if (emissionFailure !== undefined) failures.push(emissionFailure);
  failures.push(...await cleanupMountedWithLifecycle(input));
  return abortedError(
    input.descriptor,
    "mount",
    aggregateFailures(failures, "Renderer mount abort cleanup failed"),
  );
}

function scheduleLateMountDisposal(input: {
  descriptor: WebRendererDescriptor;
  lifecycle: LifecycleEmitter;
  mountPromise: Promise<WebRendererDisposableV1>;
  releaseAssets: () => Promise<void>;
  rendererSignal: LinkedRendererSignal;
  services: RendererHostServices;
}): void {
  const cleanup = input.mountPromise.then(async disposable => {
    if (!disposable || typeof disposable.dispose !== "function") {
      const invalidDisposable = new TypeError("Web Renderer mount must return a disposable");
      await releaseAfterFailedMount(input.releaseAssets, invalidDisposable);
      throw invalidDisposable;
    }
    const failures = await cleanupMountedWithLifecycle({ ...input, disposable });
    if (failures.length > 0) {
      throw new WebRendererError(`Late Web Renderer mount failed to dispose: ${rendererIdentityKey(input.descriptor)}`, "dispose_failed", {
        renderer: rendererIdentityKey(input.descriptor),
        aborted: true,
      }, { cause: aggregateFailures(failures, "Late Renderer disposal failed") });
    }
  }, async mountError => {
    await releaseAfterFailedMount(input.releaseAssets, mountError);
    throw new WebRendererError(`Late Web Renderer mount rejected after abort: ${rendererIdentityKey(input.descriptor)}`, "mount_failed", {
      renderer: rendererIdentityKey(input.descriptor),
      aborted: true,
    }, { cause: mountError });
  });
  void cleanup.catch(error => {
    input.services.reportBackgroundError(error instanceof Error
      ? error
      : new Error("Late Web Renderer cleanup failed", { cause: error }));
  });
}

function captureFailure(operation: () => void): unknown | undefined {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error ?? new Error("Renderer lifecycle observer threw without an error value");
  }
}

function aggregateFailures(failures: readonly unknown[], message: string): unknown | undefined {
  const present = failures.filter(failure => failure !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return new AggregateError(present, message);
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal, stage: "load" | "mount"): Promise<T> {
  if (signal.aborted) return Promise.reject(abortedError(undefined, stage));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortedError(undefined, stage));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortedError(descriptor?: WebRendererIdentity, stage?: string, cause?: unknown): WebRendererError {
  return new WebRendererError("Web Renderer operation was aborted", "aborted", {
    ...(descriptor ? { renderer: rendererIdentityKey(descriptor) } : {}),
    ...(stage ? { stage } : {}),
  }, cause === undefined ? undefined : { cause });
}

function isAborted(error: unknown): boolean {
  return error instanceof WebRendererError && error.code === "aborted";
}

function compareDescriptors(left: WebRendererDescriptor, right: WebRendererDescriptor): number {
  return right.priority - left.priority
    || left.id.localeCompare(right.id)
    || right.version - left.version
    || right.abi_version - left.abi_version;
}

function compareIdentities(left: WebRendererIdentity, right: WebRendererIdentity): number {
  return left.id.localeCompare(right.id)
    || left.version - right.version
    || left.abi_version - right.abi_version;
}

function monotonicNow(services: RendererHostServices): number {
  return (services.monotonicNow ?? (() => performance.now()))();
}

function elapsed(startedAt: number, endedAt: number): number {
  return Math.max(0, endedAt - startedAt);
}

function linkedAbortController(parent: AbortSignal): { controller: AbortController; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  return {
    controller,
    dispose() {
      parent.removeEventListener("abort", abort);
    },
  };
}
