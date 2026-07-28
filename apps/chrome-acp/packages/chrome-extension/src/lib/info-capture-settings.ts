export const DEFAULT_INFO_CAPTURE_ENDPOINT = "http://localhost:3112";

export type InfoCaptureSettings = {
  endpoint: string;
  captureStream: boolean;
  heartbeatSeconds: number;
  snapshotOnVisit: boolean;
  allowExternalLlm: boolean;
  snapshotTextLimit: number;
  excludedDomains: string[];
};

export const DEFAULT_INFO_CAPTURE_SETTINGS: InfoCaptureSettings = {
  endpoint: DEFAULT_INFO_CAPTURE_ENDPOINT,
  captureStream: true,
  heartbeatSeconds: 15,
  snapshotOnVisit: true,
  allowExternalLlm: true,
  snapshotTextLimit: 120000,
  excludedDomains: [
    "gmail.com",
    "mail.google.com",
    "icloud.com",
    "1password.com",
    "bitwarden.com",
    "paypal.com",
    "stripe.com",
  ],
};

const RETIRED_INFO_CAPTURE_ENDPOINTS = new Set([
  "http://localhost:3111",
  "http://localhost:3111/context/ingest",
  "http://localhost:3111/context/v1/observations",
]);

export function resolveInfoCaptureSettings(existing: Partial<InfoCaptureSettings>): InfoCaptureSettings {
  const endpoint = typeof existing.endpoint === "string" && RETIRED_INFO_CAPTURE_ENDPOINTS.has(existing.endpoint)
    ? DEFAULT_INFO_CAPTURE_ENDPOINT
    : existing.endpoint;
  return {
    ...DEFAULT_INFO_CAPTURE_SETTINGS,
    ...existing,
    ...(endpoint !== undefined ? { endpoint } : {}),
    excludedDomains: existing.excludedDomains
      ? [...existing.excludedDomains]
      : [...DEFAULT_INFO_CAPTURE_SETTINGS.excludedDomains],
  };
}
