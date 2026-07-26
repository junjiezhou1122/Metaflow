export const LAYOUT_PROTOCOL_VERSION = 1 as const;

export type LayoutNode = { key: string; x: number; y: number; size: number };
export type LayoutEdge = { key: string; source: string; target: string };
export type LayoutPosition = { key: string; x: number; y: number };

export type LayoutRequest = {
  protocol_version: typeof LAYOUT_PROTOCOL_VERSION;
  generation: number;
  request_id: string;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
};

export type LayoutResponse =
  | {
      protocol_version: typeof LAYOUT_PROTOCOL_VERSION;
      generation: number;
      request_id: string;
      ok: true;
      positions: LayoutPosition[];
    }
  | {
      protocol_version: typeof LAYOUT_PROTOCOL_VERSION;
      generation: number;
      request_id: string;
      ok: false;
      message: string;
    };

export class LayoutProtocolError extends Error {
  constructor(message: string, readonly code: "invalid_envelope" | "invalid_positions") {
    super(message);
    this.name = "LayoutProtocolError";
  }
}

export type ValidatedLayoutResponse =
  | { status: "stale" }
  | { status: "failed"; message: string }
  | { status: "ready"; positions: LayoutPosition[] };

export function validateLayoutResponse(
  input: unknown,
  expected: { generation: number; request_id: string; node_keys: ReadonlySet<string> },
): ValidatedLayoutResponse {
  if (!isRecord(input)) throw new LayoutProtocolError("Layout worker returned a non-object response", "invalid_envelope");
  if (typeof input.generation !== "number" || !Number.isSafeInteger(input.generation) || typeof input.request_id !== "string") {
    throw new LayoutProtocolError("Layout worker response omitted its generation or request identity", "invalid_envelope");
  }
  if (input.generation !== expected.generation || input.request_id !== expected.request_id) return { status: "stale" };
  if (input.protocol_version !== LAYOUT_PROTOCOL_VERSION || typeof input.ok !== "boolean") {
    throw new LayoutProtocolError("Layout worker response used an incompatible protocol envelope", "invalid_envelope");
  }
  if (!input.ok) {
    assertExactKeys(input, ["protocol_version", "generation", "request_id", "ok", "message"]);
    if (typeof input.message !== "string" || input.message.trim().length === 0 || input.message.length > 2_000) {
      throw new LayoutProtocolError("Layout worker failure omitted a bounded message", "invalid_envelope");
    }
    return { status: "failed", message: input.message };
  }
  assertExactKeys(input, ["protocol_version", "generation", "request_id", "ok", "positions"]);
  if (!Array.isArray(input.positions) || input.positions.length !== expected.node_keys.size) {
    throw new LayoutProtocolError("Layout worker did not return exactly one position for every node", "invalid_positions");
  }
  const seen = new Set<string>();
  const positions: LayoutPosition[] = [];
  for (const value of input.positions) {
    if (!isRecord(value)) throw new LayoutProtocolError("Layout worker returned a non-object position", "invalid_positions");
    assertExactKeys(value, ["key", "x", "y"], "invalid_positions");
    if (typeof value.key !== "string" || !expected.node_keys.has(value.key)) {
      throw new LayoutProtocolError("Layout worker returned a position for an unexpected node", "invalid_positions");
    }
    if (seen.has(value.key)) throw new LayoutProtocolError("Layout worker returned a duplicate node position", "invalid_positions");
    if (typeof value.x !== "number" || !Number.isFinite(value.x) || typeof value.y !== "number" || !Number.isFinite(value.y)) {
      throw new LayoutProtocolError("Layout worker returned a non-finite node position", "invalid_positions");
    }
    seen.add(value.key);
    positions.push({ key: value.key, x: value.x, y: value.y });
  }
  if ([...expected.node_keys].some(key => !seen.has(key))) {
    throw new LayoutProtocolError("Layout worker omitted an expected node position", "invalid_positions");
  }
  return { status: "ready", positions };
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], code: LayoutProtocolError["code"] = "invalid_envelope"): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new LayoutProtocolError("Layout worker response contained undeclared fields", code);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
