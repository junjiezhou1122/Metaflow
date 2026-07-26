import { createElement, useMemo, useState, type ReactNode } from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import type { JsonValue } from "@info/view/schema";
import type { WebRendererInput } from "../contracts.js";
import { createReactRendererFactory } from "./react-factory.js";

const MAX_TABLE_ROWS = 1_000;
type TableRow = Record<string, JsonValue>;

export type DeclaredTableColumn = {
  id: string;
  title: string;
  value_type: "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";
};

export function renderTableView(input: WebRendererInput): ReactNode {
  const table = parseSchemaDrivenTable(input);
  return createElement(TableView, table);
}

export const tableRendererFactory = createReactRendererFactory(input => renderTableView(input));

export function parseSchemaDrivenTable(input: WebRendererInput): {
  columns: DeclaredTableColumn[];
  rows: TableRow[];
} {
  if (input.envelope.schema.mode !== "strict") {
    throw new TypeError("The table renderer requires a strict View Schema");
  }
  if (input.representation.form !== "inline") {
    throw new TypeError("The table renderer requires an inline Representation");
  }
  const jsonSchema = asRecord(input.envelope.schema.json_schema, "View Schema");
  const tableSchema = resolveArraySchema(jsonSchema);
  const itemSchema = asRecord(tableSchema.items, "table item Schema");
  if (itemSchema.type !== "object") throw new TypeError("Table item Schema must declare type object");
  const properties = asRecord(itemSchema.properties, "table item properties");
  const columns = Object.entries(properties).map(([id, value]) => {
    const property = asRecord(value, `table column ${id}`);
    const valueType = property.type;
    if (!isColumnType(valueType)) throw new TypeError(`Table column ${id} has an unsupported declared type`);
    return { id, title: typeof property.title === "string" ? property.title : id, value_type: valueType };
  });
  if (columns.length === 0) throw new TypeError("Table Schema must declare at least one column");
  const representation = input.representation.value;
  const rawRows = Array.isArray(representation)
    ? representation
    : asRecord(representation, "table Representation").rows;
  if (!Array.isArray(rawRows)) throw new TypeError("Table Representation must be an array or contain a rows array");
  if (rawRows.length > MAX_TABLE_ROWS) {
    throw new RangeError(`Table row count exceeds the bounded ${MAX_TABLE_ROWS}-row renderer`);
  }
  const rows = rawRows.map((row, index) => asRecord(row, `table row ${index}`) as TableRow);
  return { columns, rows };
}

function TableView(props: { columns: DeclaredTableColumn[]; rows: TableRow[] }): ReactNode {
  const [sorting, setSorting] = useState<SortingState>([]);
  const columnHelper = createColumnHelper<TableRow>();
  const columns = useMemo(() => props.columns.map(column => columnHelper.accessor(row => row[column.id], {
    id: column.id,
    header: column.title,
    cell: context => formatCell(context.getValue()),
    sortingFn: "alphanumeric",
  })), [columnHelper, props.columns]);
  const table = useReactTable({
    columns,
    data: props.rows,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: { sorting },
  });
  return createElement("div", {
    className: "metaflow-renderer metaflow-renderer-table",
    "data-renderer": "renderer.web.table@1@1",
  }, createElement("table", null,
    createElement("thead", null, table.getHeaderGroups().map(headerGroup =>
      createElement("tr", { key: headerGroup.id }, headerGroup.headers.map(header =>
        createElement("th", { key: header.id, scope: "col" }, header.isPlaceholder ? null :
          createElement("button", {
            type: "button",
            onClick: header.column.getToggleSortingHandler(),
            "aria-label": `Sort by ${String(header.column.columnDef.header)}`,
          }, flexRender(header.column.columnDef.header, header.getContext()), sortingIndicator(header.column.getIsSorted()))),
      )),
    )),
    createElement("tbody", null, table.getRowModel().rows.map(row =>
      createElement("tr", { key: row.id }, row.getVisibleCells().map(cell =>
        createElement("td", { key: cell.id }, flexRender(cell.column.columnDef.cell, cell.getContext())),
      )),
    )),
  ));
}

function resolveArraySchema(schema: Record<string, JsonValue>): Record<string, JsonValue> {
  if (schema.type === "array") return schema;
  const properties = asRecord(schema.properties, "View Schema properties");
  const rows = asRecord(properties.rows, "View Schema rows property");
  if (rows.type !== "array") throw new TypeError("View Schema must declare an array or a rows array property");
  return rows;
}

function asRecord(value: JsonValue | undefined, label: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function isColumnType(value: JsonValue | undefined): value is DeclaredTableColumn["value_type"] {
  return value === "string" || value === "number" || value === "integer" || value === "boolean"
    || value === "object" || value === "array" || value === "null";
}

function formatCell(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function sortingIndicator(value: false | "asc" | "desc"): string {
  return value === "asc" ? " ascending" : value === "desc" ? " descending" : "";
}
