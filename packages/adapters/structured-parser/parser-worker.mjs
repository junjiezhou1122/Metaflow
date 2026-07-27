import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) throw new Error("Structured Parser Worker requires a parent port");

try {
  const fragments = parse(workerData);
  parentPort.postMessage({ status: "succeeded", fragments });
} catch (error) {
  if (error instanceof ParserWorkerFailure) {
    parentPort.postMessage({ status: "failed", code: error.code, message: error.message, details: error.details });
  } else {
    throw error;
  }
}

function parse(input) {
  if (!input || typeof input !== "object" || !input.limits || !input.representation) {
    throw new TypeError("Structured Parser Worker requires frozen input");
  }
  const fragments = [];
  if (input.parser_id === "parser.json") parseJson(input.representation.value, fragments, input.limits);
  else if (input.parser_id === "parser.table") parseTable(input.representation.value, fragments, input.limits);
  else if (input.parser_id === "parser.graph") parseGraph(input.representation.value, fragments, input.limits);
  else if (input.parser_id === "parser.external-reference") parseExternalReference(input.representation, fragments, input.limits);
  else throw new ParserWorkerFailure("parser_contract_mismatch", "Structured Parser Worker received an unknown Parser", { parser_id: String(input.parser_id) });
  return fragments;
}

function parseJson(value, fragments, limits) {
  for (const leaf of scalarLeaves(value, "/representation/value")) {
    append(fragments, {
      kind: "field",
      location: { kind: "json_pointer", path: leaf.path },
      content: { kind: "text", text: leaf.text },
      metadata: { value_type: leaf.valueType },
    }, limits);
  }
}

function parseTable(value, fragments, limits) {
  if (!isRecord(value) || !Array.isArray(value.columns) || !Array.isArray(value.rows)) {
    throw malformed("Table Representation requires columns and rows arrays");
  }
  const columns = value.columns.map((column, index) => {
    if (!isRecord(column) || typeof column.id !== "string" || column.id.length === 0) {
      throw malformed(`Table column ${index} requires an id`);
    }
    return { id: column.id, label: typeof column.label === "string" && column.label.length > 0 ? column.label : column.id };
  });
  if (new Set(columns.map(column => column.id)).size !== columns.length) {
    throw malformed("Table column ids must be unique");
  }
  if (columns.length > limits.max_fragments || value.rows.length > limits.max_fragments
    || columns.length * value.rows.length > limits.max_fragments) {
    throw fragmentLimit(limits.max_fragments);
  }
  value.rows.forEach((row, rowIndex) => {
    if (!isRecord(row) || !Array.isArray(row.cells) || row.cells.length !== columns.length) {
      throw malformed(`Table row ${rowIndex} must contain exactly ${columns.length} cells`);
    }
    const rowId = typeof row.id === "string" && row.id.length > 0 ? row.id : undefined;
    row.cells.forEach((cell, columnIndex) => {
      const text = searchableValue(cell);
      if (!text) return;
      const column = columns[columnIndex];
      append(fragments, {
        kind: "table_cell",
        location: {
          kind: "table_cell",
          path: `/representation/value/rows/${rowIndex}/cells/${columnIndex}`,
          row: rowIndex,
          column: columnIndex,
          ...(rowId ? { row_id: rowId } : {}),
          column_id: column.id,
        },
        content: { kind: "text", text: `${column.label}: ${text}` },
        metadata: { value_type: valueType(cell) },
      }, limits);
    });
  });
}

function parseGraph(value, fragments, limits) {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw malformed("Graph Representation requires nodes and edges arrays");
  }
  if (value.nodes.length + value.edges.length > limits.max_fragments) {
    throw fragmentLimit(limits.max_fragments);
  }
  const nodeIds = new Set();
  value.nodes.forEach((node, index) => {
    if (!isRecord(node) || typeof node.id !== "string" || node.id.length === 0 || nodeIds.has(node.id)) {
      throw new ParserWorkerFailure("parser_graph_invalid", `Graph node ${index} has a missing or duplicate id`, { node_index: index });
    }
    nodeIds.add(node.id);
  });
  const edgeIds = new Set();
  value.edges.forEach((edge, index) => {
    if (!isRecord(edge) || typeof edge.id !== "string" || edge.id.length === 0 || edgeIds.has(edge.id)
      || typeof edge.source !== "string" || typeof edge.target !== "string"
      || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new ParserWorkerFailure("parser_graph_invalid", `Graph edge ${index} is invalid`, { edge_index: index });
    }
    edgeIds.add(edge.id);
  });

  value.nodes.forEach((node, index) => {
    const base = `/representation/value/nodes/${index}`;
    const label = typeof node.label === "string" && node.label.trim() ? node.label.trim() : node.id;
    append(fragments, {
      kind: "graph_node",
      location: { kind: "graph_element", path: `${base}/${node.label ? "label" : "id"}`, element_kind: "node", element_id: node.id },
      content: { kind: "text", text: label },
      metadata: {},
    }, limits);
    if (isRecord(node.properties)) {
      for (const leaf of scalarLeaves(node.properties, `${base}/properties`)) {
        append(fragments, {
          kind: "graph_node",
          location: {
            kind: "graph_element",
            path: leaf.path,
            element_kind: "node",
            element_id: node.id,
            property: leaf.path.slice(`${base}/properties`.length) || "/",
          },
          content: { kind: "text", text: leaf.text },
          metadata: { value_type: leaf.valueType },
        }, limits);
      }
    }
  });
  value.edges.forEach((edge, index) => {
    const base = `/representation/value/edges/${index}`;
    const label = typeof edge.label === "string" && edge.label.trim() ? edge.label.trim() : `${edge.source} -> ${edge.target}`;
    append(fragments, {
      kind: "graph_edge",
      location: { kind: "graph_element", path: `${base}/${edge.label ? "label" : "id"}`, element_kind: "edge", element_id: edge.id },
      content: { kind: "text", text: label },
      metadata: { source: edge.source, target: edge.target },
    }, limits);
    if (isRecord(edge.properties)) {
      for (const leaf of scalarLeaves(edge.properties, `${base}/properties`)) {
        append(fragments, {
          kind: "graph_edge",
          location: {
            kind: "graph_element",
            path: leaf.path,
            element_kind: "edge",
            element_id: edge.id,
            property: leaf.path.slice(`${base}/properties`.length) || "/",
          },
          content: { kind: "text", text: leaf.text },
          metadata: { value_type: leaf.valueType },
        }, limits);
      }
    }
  });
}

function parseExternalReference(representation, fragments, limits) {
  if (typeof representation.uri !== "string" || representation.uri.length === 0) {
    throw malformed("External-reference Representation requires a URI");
  }
  append(fragments, {
    kind: "reference",
    location: { kind: "external_reference", path: "/representation/uri" },
    content: { kind: "text", text: representation.uri },
    metadata: { media_type: representation.media_type ?? null },
  }, limits);
  if (isRecord(representation.metadata)) {
    for (const leaf of scalarLeaves(representation.metadata, "/representation/metadata")) {
      append(fragments, {
        kind: "metadata",
        location: { kind: "external_reference", path: leaf.path },
        content: { kind: "text", text: leaf.text },
        metadata: { value_type: leaf.valueType },
      }, limits);
    }
  }
}

function scalarLeaves(value, rootPath) {
  const leaves = [];
  const stack = [{ value, path: rootPath }];
  while (stack.length > 0) {
    const item = stack.pop();
    if (Array.isArray(item.value)) {
      for (let index = item.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: item.value[index], path: `${item.path}/${index}` });
      }
      continue;
    }
    if (isRecord(item.value)) {
      const keys = Object.keys(item.value).sort().reverse();
      for (const key of keys) stack.push({ value: item.value[key], path: `${item.path}/${escapePointerToken(key)}` });
      continue;
    }
    const text = searchableValue(item.value);
    if (text) leaves.push({ path: item.path, text, valueType: valueType(item.value) });
  }
  return leaves;
}

function append(fragments, fragment, limits) {
  if (fragments.length >= limits.max_fragments) throw fragmentLimit(limits.max_fragments);
  const bytes = Buffer.byteLength(fragment.content.text, "utf8");
  if (bytes > limits.max_fragment_bytes) {
    throw new ParserWorkerFailure(
      "parser_fragment_too_large",
      `Structured fragment exceeds ${limits.max_fragment_bytes} bytes`,
      { fragment_bytes: bytes, max_fragment_bytes: limits.max_fragment_bytes },
    );
  }
  fragments.push(fragment);
}

function searchableValue(value) {
  if (typeof value === "string") return value.trim() || undefined;
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) || isRecord(value)) return canonicalJson(value);
  return undefined;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw malformed("Structured value contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  throw malformed("Structured value is not JSON-compatible");
}

function escapePointerToken(value) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(message) {
  return new ParserWorkerFailure("parser_representation_malformed", message, {});
}

function fragmentLimit(maxFragments) {
  return new ParserWorkerFailure(
    "parser_fragment_limit_exceeded",
    `Structured Parser exceeds ${maxFragments} fragments`,
    { max_fragments: maxFragments },
  );
}

function ParserWorkerFailure(code, message, details) {
  this.code = code;
  this.message = message;
  this.details = details;
}
