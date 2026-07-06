/**
 * Bordered-panel code block with an optional language/label header,
 * line-count chip, copy chip, and auto-fold for long blocks. Used as
 * the single source of truth for "rendered multi-line text inside the
 * drill-in" — the primary writeApp/writeRules source AND the nested
 * SOURCE strings inside Args/Result share this chrome so the surfaces
 * feel like one design language instead of two.
 *
 * Variants:
 *   - `language` set:    foldable, chevron + LABEL + line-count + copy.
 *   - `language` unset:  flat panel, no header — used for short
 *                        always-rendered code.
 *
 * The closed state still shows the full bordered panel — important for
 * visual parity with the open state. A bare chevron+label line (no
 * border) read as "metadata", not as "collapsed content."
 */
import { CopyButton } from './CopyButton';

const AUTOFOLD_LINES = 14;

interface Props {
  code: string;
  /** Header label (e.g. `TSX`, `SOURCE`). Omit for a flat, header-less
   *  code panel. */
  language?: string;
  /** What to put on the clipboard. Defaults to the rendered code. */
  copyValue?: string;
  /** Override the auto-fold behavior. Default: open if `<=
   *  AUTOFOLD_LINES`, collapsed otherwise. */
  defaultOpen?: boolean;
}

export function CodeBlock({ code, language, copyValue, defaultOpen }: Props) {
  const resolvedDefaultOpen =
    defaultOpen ?? code.split('\n').length <= AUTOFOLD_LINES;

  // Header-less variant — just a flat code panel.
  if (!language) {
    return (
      <div className="rounded-md border border-[#2a2a35] bg-[#0f0f17] overflow-hidden">
        <pre className="text-[12px] font-mono text-soft-white/90 leading-relaxed whitespace-pre overflow-x-auto px-3 py-2.5 custom-scrollbar">
          {code}
        </pre>
      </div>
    );
  }

  const lineCount = code.split('\n').length;
  return (
    <details
      open={resolvedDefaultOpen}
      className="group rounded-md border border-[#2a2a35] bg-[#0f0f17] overflow-hidden"
    >
      <summary
        className={[
          'flex items-center justify-between px-3 py-1.5 group-open:border-b group-open:border-[#2a2a35]',
          'cursor-pointer select-none hover:bg-[#2a2a35]/30 transition-colors',
          'list-none [&::-webkit-details-marker]:hidden',
        ].join(' ')}
      >
        <div className="flex items-center gap-1.5">
          <span className="material-symbols-outlined text-[14px] text-slate-gray transition-transform group-open:rotate-90">
            chevron_right
          </span>
          <span className="text-[10px] uppercase tracking-wider text-slate-gray font-mono">
            {language}
          </span>
          <span className="text-[10px] font-mono text-slate-gray/60">
            · {lineCount.toLocaleString()} {lineCount === 1 ? 'line' : 'lines'}
          </span>
        </div>
        <CopyButton value={copyValue ?? code} label="Copy" size={12} />
      </summary>
      <pre className="text-[12px] font-mono text-soft-white/90 leading-relaxed whitespace-pre overflow-x-auto px-3 py-2.5 custom-scrollbar">
        {code}
      </pre>
    </details>
  );
}
