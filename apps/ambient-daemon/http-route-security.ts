export type AmbientHttpRouteAccess = "public" | "authenticated";

export const AMBIENT_HTTP_ROUTE_SECURITY_MATRIX = Object.freeze([
  { id: "health", methods: ["GET"], path: "/health", access: "public" },
  { id: "doctor", methods: ["GET"], path: "/metaflow/v1/doctor", access: "public" },
  { id: "browser_capture", methods: ["POST"], path: "/capture/v1/browser-events", access: "authenticated" },
  { id: "browser_signal", methods: ["POST"], path: "/automation/v1/browser-signals", access: "authenticated" },
  { id: "browser_deliveries", methods: ["GET"], path: "/automation/v1/browser-deliveries", access: "authenticated" },
  { id: "browser_interaction", methods: ["POST"], path: "/automation/v1/browser-interactions", access: "authenticated" },
  { id: "macos_signal", methods: ["POST"], path: "/automation/v1/macos/voice-signals", access: "authenticated" },
  { id: "macos_deliveries", methods: ["GET"], path: "/automation/v1/macos/deliveries", access: "authenticated" },
  { id: "macos_interaction", methods: ["POST"], path: "/automation/v1/macos/interactions", access: "authenticated" },
  { id: "macos_browser_context_poll", methods: ["GET"], path: "/automation/v1/macos/browser-context-requests", access: "authenticated" },
  { id: "macos_browser_context_response", methods: ["POST"], path: "/automation/v1/macos/browser-context-responses", access: "authenticated" },
  { id: "inbox_deliveries", methods: ["GET"], path: "/automation/v1/inbox/deliveries", access: "authenticated" },
  { id: "inbox_interaction", methods: ["POST"], path: "/automation/v1/inbox/interactions", access: "authenticated" },
  { id: "exact_view", methods: ["GET"], path: "/context/v1/views/:view_id", access: "authenticated" },
  { id: "operation", methods: ["POST"], path: "/metaflow/v1/operations/:operation", access: "authenticated" },
  { id: "direct_assist", methods: ["POST"], path: "/ambient/v1/assist", access: "authenticated" },
  { id: "mcp", methods: ["GET", "POST", "DELETE"], path: "/mcp", access: "authenticated" },
] as const);

const exactPaths = new Map<string, AmbientHttpRouteAccess>(
  AMBIENT_HTTP_ROUTE_SECURITY_MATRIX
    .filter(route => !route.path.includes(":"))
    .map(route => [route.path, route.access]),
);

export function ambientRouteAccess(path: string): AmbientHttpRouteAccess | undefined {
  const exact = exactPaths.get(path);
  if (exact) return exact;
  if (/^\/context\/v1\/views\/[^/]+$/u.test(path)) return "authenticated";
  if (/^\/metaflow\/v1\/operations\/[^/]+$/u.test(path)) return "authenticated";
  return undefined;
}
