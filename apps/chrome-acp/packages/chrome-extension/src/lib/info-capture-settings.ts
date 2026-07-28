import { z } from "zod";
import { DEFAULT_BROWSER_CAPTURE_DAEMON_PORT } from "@info/browser-capture-adapter/wire";

export const DEFAULT_INFO_CAPTURE_ENDPOINT = `http://localhost:${DEFAULT_BROWSER_CAPTURE_DAEMON_PORT}`;

export type InfoCaptureSettings = {
  endpoint: string;
  operationAuthToken: string;
  captureStream: boolean;
  heartbeatSeconds: number;
  snapshotOnVisit: boolean;
  allowExternalLlm: boolean;
  snapshotTextLimit: number;
  excludedDomains: string[];
};

export const DEFAULT_INFO_CAPTURE_SETTINGS: InfoCaptureSettings = {
  endpoint: DEFAULT_INFO_CAPTURE_ENDPOINT,
  operationAuthToken: "",
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

const HttpEndpointSchema = z.string().url().refine(value => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Browser Capture endpoint must use HTTP or HTTPS");

const ExcludedDomainSchema = z.string().trim().toLowerCase().max(253).refine(value => {
  if (!value) return false;
  return value.split(".").every(label => (
    label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ));
}, "Excluded domain must be a hostname");

const PersistedInfoCaptureSettingsSchema = z.object({
  endpoint: HttpEndpointSchema.optional(),
  operationAuthToken: z.string().optional(),
  captureStream: z.boolean().optional(),
  heartbeatSeconds: z.number().int().positive().max(86_400).optional(),
  snapshotOnVisit: z.boolean().optional(),
  allowExternalLlm: z.boolean().optional(),
  snapshotTextLimit: z.number().int().positive().max(1_000_000).optional(),
  excludedDomains: z.array(ExcludedDomainSchema).max(10_000).optional(),
}).strict();

const InfoCaptureSettingsSchema = PersistedInfoCaptureSettingsSchema.required();

const RETIRED_INFO_CAPTURE_ENDPOINTS = new Set([
  "http://localhost:3111",
  "http://localhost:3111/context/ingest",
  "http://localhost:3111/context/v1/observations",
]);

export function resolveInfoCaptureSettings(existing: unknown): InfoCaptureSettings {
  const persisted = PersistedInfoCaptureSettingsSchema.parse(existing);
  const endpoint = persisted.endpoint && RETIRED_INFO_CAPTURE_ENDPOINTS.has(persisted.endpoint)
    ? DEFAULT_INFO_CAPTURE_ENDPOINT
    : persisted.endpoint;
  return InfoCaptureSettingsSchema.parse({
    ...DEFAULT_INFO_CAPTURE_SETTINGS,
    ...persisted,
    ...(endpoint !== undefined ? { endpoint } : {}),
    excludedDomains: persisted.excludedDomains
      ? [...persisted.excludedDomains]
      : [...DEFAULT_INFO_CAPTURE_SETTINGS.excludedDomains],
  });
}

export function resolveInfoCaptureSettingsUpdate(
  current: unknown,
  update: unknown,
): InfoCaptureSettings {
  const settings = resolveInfoCaptureSettings(current);
  const patch = PersistedInfoCaptureSettingsSchema.parse(update);
  return resolveInfoCaptureSettings({ ...settings, ...patch });
}
