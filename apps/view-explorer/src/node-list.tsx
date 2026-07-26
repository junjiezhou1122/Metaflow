import { useMemo, useRef, useState } from "react";
import { refKey, type ViewGraphProjectionNode } from "./contracts.js";

const ROW_HEIGHT = 48;
const OVERSCAN = 5;

export function VirtualNodeList(props: {
  nodes: ViewGraphProjectionNode[];
  selectedKey?: string;
  onSelect(key: string): void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(240);
  const ordered = useMemo(() => [...props.nodes].sort((left, right) => left.name.localeCompare(right.name) || refKey(left.ref).localeCompare(refKey(right.ref))), [props.nodes]);
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const visible = ordered.slice(first, first + visibleCount);

  function move(key: string, delta: number): void {
    const index = ordered.findIndex(node => refKey(node.ref) === key);
    const next = ordered[Math.max(0, Math.min(ordered.length - 1, index + delta))];
    if (!next) return;
    props.onSelect(refKey(next.ref));
    viewportRef.current?.querySelector<HTMLElement>(`[data-node-index="${Math.max(0, Math.min(ordered.length - 1, index + delta))}"]`)?.focus();
  }

  return (
    <div
      ref={viewportRef}
      className="node-list-viewport"
      role="listbox"
      aria-label="Views in projection"
      aria-rowcount={ordered.length}
      tabIndex={0}
      onScroll={event => {
        setScrollTop(event.currentTarget.scrollTop);
        setViewportHeight(event.currentTarget.clientHeight);
      }}
      data-testid="node-list"
    >
      <div className="node-list-spacer" style={{ height: ordered.length * ROW_HEIGHT }}>
        {visible.map((node, visibleIndex) => {
          const index = first + visibleIndex;
          const key = refKey(node.ref);
          return (
            <button
              key={key}
              type="button"
              role="option"
              aria-selected={props.selectedKey === key}
              aria-setsize={ordered.length}
              aria-posinset={index + 1}
              data-node-key={key}
              data-node-index={index}
              className="node-list-row"
              style={{ transform: `translateY(${index * ROW_HEIGHT}px)`, height: ROW_HEIGHT }}
              onClick={() => props.onSelect(key)}
              onKeyDown={event => {
                if (event.key === "ArrowDown") { event.preventDefault(); move(key, 1); }
                if (event.key === "ArrowUp") { event.preventDefault(); move(key, -1); }
              }}
            >
              <span className={`role-dot role-${node.role}`} aria-hidden="true" />
              <span className="node-list-copy"><strong title={node.name}>{node.name}</strong><small title={key}>{key}</small></span>
              <span className="node-depth">d{node.depth}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
