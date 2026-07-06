/**
 * Terminal-style renderer for `runOnce` output. Used by the
 * `OutputTab` (right panel) and the runOnce drill-in's output
 * section so both surfaces read the same way.
 *
 * Vocabulary:
 *   - Pure black background, monospace, tight leading — reads as
 *     a real terminal capture, not a UI list.
 *   - Severity tag at the start of each line (`INFO`, `DENIAL`,
 *     `ERROR`), color-coded. No brackets — the column width and
 *     monospace font already create the columnar feel.
 *   - Optional user tag (from `log('1', 'foo')` style calls)
 *     surfaces as a bracketed prefix after the severity.
 *   - Payload (denial context, error stack, structured args)
 *     renders indented below in muted slate, mirroring how a real
 *     terminal indents multi-line log details.
 */
import type { LogEntry } from '~/lib/sandbox/runner';

function severityTone(level: LogEntry['level']): string {
  if (level === 'error') return 'text-[#f0a0a0]';
  if (level === 'denial') return 'text-[#e6c79c]';
  return 'text-soft-white/85'; // info
}

function severityWidth(): string {
  // `DENIAL` is the longest severity (6 chars), reserve column.
  return 'w-[60px] shrink-0';
}

export interface TerminalViewProps {
  entries: readonly LogEntry[];
  /** When provided, renders a small terminal-strip header. */
  title?: string;
  /** Optional bottom-right meta — e.g. "5ms · 1 doc". */
  meta?: string;
  /** Render with a top border-radius + border. Default true. */
  chrome?: boolean;
}

export function TerminalView({
  entries,
  title,
  meta,
  chrome = true,
}: TerminalViewProps) {
  return (
    <div
      className={[
        chrome ? 'rounded-md border border-[#2a2a35] overflow-hidden' : '',
        'bg-black',
      ].join(' ')}
    >
      {title || meta ? (
        <div className="flex items-center justify-between gap-3 px-3 py-1.5 border-b border-[#1a1a22] bg-[#0a0a0e]">
          {title ? (
            <span className="text-[10px] font-mono uppercase tracking-wider text-slate-gray/80">
              {title}
            </span>
          ) : (
            <span />
          )}
          {meta ? (
            <span className="text-[10px] font-mono text-slate-gray/70">{meta}</span>
          ) : null}
        </div>
      ) : null}

      {entries.length === 0 ? (
        <div className="px-3 py-4 font-mono text-[12px] text-slate-gray/60 italic">
          {/* match terminal idiom — empty stdout reads as silence */}
          (no output)
        </div>
      ) : (
        <ul className="font-mono text-[12px] leading-[1.55] py-2">
          {entries.map((e, i) => (
            <Row key={i} entry={e} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ entry }: { entry: LogEntry }) {
  const tone = severityTone(entry.level);
  return (
    <li className="px-3 py-0.5 whitespace-pre-wrap break-words">
      <div className="flex items-baseline gap-2">
        <span
          className={`${severityWidth()} uppercase tracking-wider text-[10px] ${tone}`}
        >
          {entry.level}
        </span>
        <span className="flex-1 min-w-0">
          {entry.tag ? (
            <span className="text-slate-gray/60 mr-2">[{entry.tag}]</span>
          ) : null}
          <span className={tone}>{entry.message}</span>
        </span>
      </div>
      {entry.payload ? (
        // Indented payload — pads to align under the message column,
        // not the severity column. Muted color matches real terminal
        // "secondary detail" indentation.
        <pre className="pl-[68px] pr-2 pb-1 text-slate-gray/80 whitespace-pre-wrap break-words leading-[1.55]">
          {entry.payload}
        </pre>
      ) : null}
    </li>
  );
}
