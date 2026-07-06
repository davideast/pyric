/**
 * Collapsible unified-diff panel for the write-tool drill-ins. Same
 * bordered `<details>` chrome as `CodeBlock` so the two read as one
 * design language — header row carries `DIFF · +N / −M`, the body is
 * the row stream from `buildUnifiedDiff` with del/add tinting and a
 * dual line-number gutter.
 *
 * Teaching intent: the agent's summary already says "+12 / −4"; this
 * view shows WHICH twelve and WHICH four, so the user learns what the
 * agent actually changed instead of trusting a count.
 *
 * Degradation:
 *   - inputs too large to diff responsively → full-source CodeBlock
 *     with a one-line note (never jank the pane).
 *   - before === after → quiet "no changes" note.
 */
import { useMemo } from 'react';
import { CodeBlock } from '../CodeBlock';
import { CopyButton } from '../CopyButton';
import {
  buildUnifiedDiff,
  languageForPath,
  serializeUnifiedDiff,
  type DiffRow,
} from './unified-diff';

interface Props {
  before: string;
  after: string;
  /** Workspace path — drives the header label + fallback language. */
  path?: string;
  /** Default expansion. Diffs are the primary payload of a write
   *  drill-in, so default open (unlike CodeBlock's auto-fold). */
  defaultOpen?: boolean;
}

function rowTone(kind: DiffRow['kind']): string {
  switch (kind) {
    case 'add':
      return 'bg-[#a4d4a8]/[0.07] text-[#a4d4a8]';
    case 'del':
      return 'bg-[#f0a0a0]/[0.07] text-[#f0a0a0]';
    default:
      return 'text-slate-gray';
  }
}

export function DiffView({ before, after, path, defaultOpen = true }: Props) {
  const diff = useMemo(() => buildUnifiedDiff(before, after), [before, after]);

  if (diff.unchanged) {
    return (
      <p className="text-[12px] text-slate-gray italic">
        No changes — the new content is identical to the previous file.
      </p>
    );
  }

  if (diff.tooLarge) {
    return (
      <>
        <p className="text-[12px] text-slate-gray italic mb-2">
          File too large to diff — showing the full new content instead.
        </p>
        <CodeBlock code={after} language={path ? languageForPath(path) : 'text'} />
      </>
    );
  }

  const copyValue = serializeUnifiedDiff(diff);

  return (
    <details
      open={defaultOpen}
      data-teach="diff-view"
      className="group rounded-md border border-[#2a2a35] bg-[#0f0f17] overflow-hidden"
    >
      <summary
        className={[
          'flex items-center justify-between px-3 py-1.5 group-open:border-b group-open:border-[#2a2a35]',
          'cursor-pointer select-none hover:bg-[#2a2a35]/30 transition-colors',
          'list-none [&::-webkit-details-marker]:hidden',
        ].join(' ')}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="material-symbols-outlined text-[14px] text-slate-gray transition-transform group-open:rotate-90">
            chevron_right
          </span>
          <span className="text-[10px] uppercase tracking-wider text-slate-gray font-mono shrink-0">
            diff
          </span>
          <span className="text-[10px] font-mono shrink-0">
            <span className="text-[#a4d4a8]">+{diff.added.toLocaleString()}</span>
            <span className="text-slate-gray/60 mx-1">/</span>
            <span className="text-[#f0a0a0]">−{diff.removed.toLocaleString()}</span>
          </span>
          {path ? (
            <span className="text-[10px] font-mono text-slate-gray/60 truncate min-w-0">
              · {path}
            </span>
          ) : null}
        </div>
        <CopyButton value={copyValue} label="Copy diff" size={12} />
      </summary>

      <div className="overflow-x-auto custom-scrollbar">
        <table className="w-full border-collapse text-[12px] font-mono leading-relaxed">
          <tbody>
            {diff.parts.map((part, pi) => {
              if (part.kind === 'skip') {
                return (
                  <tr key={`skip-${pi}`}>
                    <td
                      colSpan={4}
                      className="px-3 py-1 text-[10px] font-mono text-slate-gray/60 bg-[#1a1a22]/60 border-y border-[#2a2a35]/40 select-none"
                    >
                      ⋯ {part.count.toLocaleString()} unchanged lines
                    </td>
                  </tr>
                );
              }
              return part.rows.map((row, ri) => (
                <tr key={`r-${pi}-${ri}`} className={rowTone(row.kind)}>
                  <td className="px-2 text-right text-[10px] text-slate-gray/50 select-none w-8 align-top tabular-nums">
                    {row.oldLine ?? ''}
                  </td>
                  <td className="px-2 text-right text-[10px] text-slate-gray/50 select-none w-8 align-top tabular-nums">
                    {row.newLine ?? ''}
                  </td>
                  <td className="pl-1 pr-2 select-none w-4 align-top">
                    {row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''}
                  </td>
                  <td className="pr-3 whitespace-pre align-top">{row.text || ' '}</td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}
