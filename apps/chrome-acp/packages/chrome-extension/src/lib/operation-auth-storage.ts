const OPERATION_AUTH_TOKEN_KEY = "operationAuthToken";

export type OperationAuthStorageArea = {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  setAccessLevel?: (options: { accessLevel: "TRUSTED_CONTEXTS" }) => Promise<void>;
};

export class OperationAuthStorageIsolationError extends Error {
  readonly code = "operation_auth_storage_isolation_failed";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OperationAuthStorageIsolationError";
  }
}

const isolationByStorage = new WeakMap<object, Promise<void>>();

export function ensureTrustedOperationStorageAccess(
  storage: OperationAuthStorageArea = chrome.storage.local as OperationAuthStorageArea,
): Promise<void> {
  const existing = isolationByStorage.get(storage);
  if (existing) return existing;

  const isolation = establishTrustedAccess(storage);
  isolationByStorage.set(storage, isolation);
  return isolation;
}

export async function readOperationAuthToken(
  storage: OperationAuthStorageArea = chrome.storage.local as OperationAuthStorageArea,
): Promise<string> {
  await ensureTrustedOperationStorageAccess(storage);
  const stored = await storage.get(OPERATION_AUTH_TOKEN_KEY);
  return typeof stored[OPERATION_AUTH_TOKEN_KEY] === "string" ? stored[OPERATION_AUTH_TOKEN_KEY] : "";
}

export async function writeOperationAuthToken(
  token: string,
  storage: OperationAuthStorageArea = chrome.storage.local as OperationAuthStorageArea,
): Promise<void> {
  await ensureTrustedOperationStorageAccess(storage);
  await storage.set({ [OPERATION_AUTH_TOKEN_KEY]: token });
}

async function establishTrustedAccess(storage: OperationAuthStorageArea): Promise<void> {
  try {
    if (typeof storage.setAccessLevel !== "function") {
      throw new Error("chrome.storage.local.setAccessLevel is unavailable");
    }
    await storage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch (cause) {
    try {
      await storage.remove(OPERATION_AUTH_TOKEN_KEY);
    } catch (clearCause) {
      throw new OperationAuthStorageIsolationError(
        "Could not isolate or clear the resident daemon Operation token",
        { cause: new AggregateError([cause, clearCause]) },
      );
    }
    throw new OperationAuthStorageIsolationError(
      "Could not isolate resident daemon Operation token storage; the existing token was cleared",
      { cause },
    );
  }
}
