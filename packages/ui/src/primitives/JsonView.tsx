import { useState } from 'react';

export interface JsonViewProps {
  /** Any JSON-serializable value. */
  value: unknown;
  /**
   * Depth at and below which object/array nodes start collapsed.
   * `0` collapses the root, `1` collapses everything under the root,
   * `Infinity` (default) leaves everything expanded.
   */
  defaultCollapsedDepth?: number;
  /** Forwarded to the root container. */
  className?: string;
}

type JsonKind =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null';

function kindOf(value: unknown): JsonKind {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'object') return 'object';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  return 'string';
}

/**
 * Headless collapsible JSON tree. One structural step above a
 * `<pre>` dump: object/array nodes are independently expandable, but
 * there's no editing and no syntax-color theme — just `data-pyric-*`
 * hooks for the consumer to style.
 *
 * Styling hooks:
 * - `[data-pyric-ui="json-view"]` — root
 * - `[data-pyric-json-node]` — every node, with `data-pyric-json-type`
 * - `[data-pyric-json-toggle]` — the expand/collapse button (containers only)
 * - `[data-pyric-json-node][data-pyric-collapsed]` — a collapsed container
 * - `[data-pyric-json-key]` — the key/index label
 * - `[data-pyric-json-value]` — a primitive value
 * - `[data-pyric-json-summary]` — the `{…}` / `[…]` placeholder when collapsed
 */
export function JsonView({
  value,
  defaultCollapsedDepth = Infinity,
  className,
}: JsonViewProps) {
  return (
    <div data-pyric-ui="json-view" className={className}>
      <JsonNode
        value={value}
        depth={0}
        defaultCollapsedDepth={defaultCollapsedDepth}
      />
    </div>
  );
}

interface JsonNodeProps {
  value: unknown;
  /** Object key or array index label — absent on the root. */
  nodeKey?: string;
  depth: number;
  defaultCollapsedDepth: number;
}

function JsonNode({
  value,
  nodeKey,
  depth,
  defaultCollapsedDepth,
}: JsonNodeProps) {
  const kind = kindOf(value);
  const isContainer = kind === 'object' || kind === 'array';
  const [collapsed, setCollapsed] = useState(
    isContainer && depth >= defaultCollapsedDepth,
  );

  if (!isContainer) {
    return (
      <div data-pyric-json-node="" data-pyric-json-type={kind}>
        {nodeKey !== undefined ? (
          <span data-pyric-json-key="">{nodeKey}</span>
        ) : null}
        <span data-pyric-json-value="">{formatPrimitive(value, kind)}</span>
      </div>
    );
  }

  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  const open = kind === 'array' ? '[' : '{';
  const close = kind === 'array' ? ']' : '}';

  return (
    <div
      data-pyric-json-node=""
      data-pyric-json-type={kind}
      data-pyric-collapsed={collapsed ? '' : undefined}
    >
      <button
        type="button"
        data-pyric-json-toggle=""
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
      >
        {nodeKey !== undefined ? (
          <span data-pyric-json-key="">{nodeKey}</span>
        ) : null}
        {collapsed ? (
          <span data-pyric-json-summary="">
            {open}
            {entries.length}
            {close}
          </span>
        ) : (
          <span data-pyric-json-bracket="">{open}</span>
        )}
      </button>
      {collapsed ? null : (
        <>
          <div data-pyric-json-children="">
            {entries.map(([k, v]) => (
              <JsonNode
                key={k}
                value={v}
                nodeKey={k}
                depth={depth + 1}
                defaultCollapsedDepth={defaultCollapsedDepth}
              />
            ))}
          </div>
          <span data-pyric-json-bracket="">{close}</span>
        </>
      )}
    </div>
  );
}

function formatPrimitive(value: unknown, kind: JsonKind): string {
  if (kind === 'null') return 'null';
  if (kind === 'string') return JSON.stringify(value);
  return String(value);
}
