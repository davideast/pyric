/**
 * Field-aware renderer for the Args / Result sections in the tool
 * drill-in. The previous "dump as pretty JSON" treatment left
 * multi-line strings as one-liners with literal `\n` escape
 * sequences — readable as data, unreadable as content.
 *
 * Per-field rules:
 *   - Multi-line string value  → render via `<CodeBlock>` so the chrome
 *     matches the primary source block at the top of the drill-in.
 *     Same bordered panel, same chevron, same auto-fold threshold —
 *     "different treatments for the same element" was confusing.
 *   - Short string / scalar    → render inline, `key: value`.
 *   - Nested object / array    → recurse with indentation.
 *   - `null` / `undefined`     → muted inline.
 *
 * For the canonical wire payload (raw JSON), the Copy button on the
 * containing section still emits `JSON.stringify(...)`. The on-screen
 * view is for reading; the copy is for paste-elsewhere.
 */
import type { ReactNode } from 'react';
import { CodeBlock } from './CodeBlock';

interface Props {
  data: unknown;
  /** Indent depth, internal. Top-level callers pass 0 (the default). */
  depth?: number;
}

const MULTILINE_THRESHOLD = 48; // chars; long single-line strings still get the pre treatment

function isMultiline(value: string): boolean {
  return value.includes('\n') || value.length > MULTILINE_THRESHOLD;
}

function renderScalar(value: unknown): ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-slate-gray/60 italic">{String(value)}</span>;
  }
  if (typeof value === 'string') {
    return <span className="text-[#e0b489]">"{value}"</span>;
  }
  if (typeof value === 'number') {
    return <span className="text-[#b8d496]">{value.toLocaleString()}</span>;
  }
  if (typeof value === 'boolean') {
    return <span className="text-[#b8d496]">{String(value)}</span>;
  }
  return <span className="text-soft-white">{String(value)}</span>;
}

export function FieldView({ data, depth = 0 }: Props): React.ReactElement | null {
  // Primitives at the top level → just render as scalar.
  if (data === null || typeof data !== 'object') {
    return <div className="text-[12px] font-mono">{renderScalar(data)}</div>;
  }

  // Arrays — render `[N]` index labels like keys.
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return (
        <div className="text-[12px] font-mono text-slate-gray/60 italic">empty array</div>
      );
    }
    return (
      <div className="space-y-2">
        {data.map((item, i) => (
          <FieldRow key={i} label={`[${i}]`} value={item} depth={depth} />
        ))}
      </div>
    );
  }

  // Plain object.
  const entries = Object.entries(data as Record<string, unknown>);
  if (entries.length === 0) {
    return (
      <div className="text-[12px] font-mono text-slate-gray/60 italic">empty object</div>
    );
  }
  return (
    <div className="space-y-2">
      {entries.map(([key, value]) => (
        <FieldRow key={key} label={key} value={value} depth={depth} />
      ))}
    </div>
  );
}

/**
 * One field — `key: value` inline for scalars, or `key:` on top with
 * a pre-block underneath for multi-line strings, or recursed
 * `FieldView` (indented) for nested objects / arrays.
 */
function FieldRow({
  label,
  value,
  depth,
}: {
  label: string;
  value: unknown;
  depth: number;
}) {
  // Multi-line / long strings → delegate to `CodeBlock` so the chrome
  // matches the primary source block at the top of the drill-in. Auto-
  // fold is handled by `CodeBlock` itself.
  if (typeof value === 'string' && isMultiline(value)) {
    return <CodeBlock code={value} language={label} />;
  }

  // Nested object / array → key on top, FieldView underneath indented.
  if (value !== null && typeof value === 'object') {
    return (
      <div>
        <span className="text-[11px] font-mono text-slate-gray uppercase tracking-wider">
          {label}
        </span>
        <div className="mt-1.5 pl-4 border-l border-[#2a2a35]/60">
          <FieldView data={value} depth={depth + 1} />
        </div>
      </div>
    );
  }

  // Scalar → inline `KEY: value`.
  return (
    <div className="text-[12px] font-mono flex items-baseline gap-3">
      <span className="text-slate-gray uppercase tracking-wider shrink-0">{label}</span>
      <span className="min-w-0 truncate">{renderScalar(value)}</span>
    </div>
  );
}
