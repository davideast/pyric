/**
 * Compact lint feedback strip below the Rules editor. Parse error gets
 * its own row at the top (with line/column when present); everything
 * else is a sorted warning list — error severity first, then warning,
 * then info.
 *
 * The strip is part of the editor flow — same `bg-content-bg`, same
 * monospace text scale — so it reads as part of the editor rather than
 * a floating overlay.
 */
import { useEffect, useState } from 'react';

import { useRulesLint } from '~/hooks/useRulesLint';
import { useWorkspaceStore } from '~/lib/store/workspace';
import type { LintWarning } from 'pyric/rules/internal';

const COLLAPSED_STORAGE_KEY = 'pyric.playground.rulesLintStrip.collapsed';

const SEVERITY_ORDER: Record<LintWarning['severity'], number> = {
  error: 0,
  warning: 1,
};

function severityTone(s: LintWarning['severity']): string {
  return s === 'error' ? 'text-[#f0a0a0]' : 'text-[#e6c79c]';
}

function locationLabel(w: LintWarning): string {
  const loc = w.location;
  if (!loc) return '';
  if (loc.functionName) return `in ${loc.functionName}`;
  if (loc.matchPath) return `at ${loc.matchPath}`;
  if (loc.ruleIndex != null) return `rule #${loc.ruleIndex}`;
  return '';
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function formatRulesLintSummary(
  hasParseError: boolean,
  warnings: readonly Pick<LintWarning, 'severity'>[],
): string {
  const lintErrors = warnings.filter((warning) => warning.severity === 'error').length;
  const errors = lintErrors + (hasParseError ? 1 : 0);
  const warningCount = warnings.filter((warning) => warning.severity === 'warning').length;
  const parts = [
    errors > 0 ? plural(errors, 'error') : null,
    warningCount > 0 ? plural(warningCount, 'warning') : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'rules ok';
}

function readInitialCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function usePersistedCollapsedState(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = useState(readInitialCollapsed);

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed ? 'true' : 'false');
    } catch {
      // Ignore storage failures; the disclosure still works for this render.
    }
  }, [collapsed]);

  return [collapsed, setCollapsed];
}

export function RulesLintStrip() {
  const { result, isLinting } = useRulesLint();
  const rules = useWorkspaceStore((s) => s.rules);
  const [collapsed, setCollapsed] = usePersistedCollapsedState();

  // Empty buffer — hide the strip entirely. The parser would
  // legitimately report "expected rules_version" on '' but there's
  // nothing actionable to show the user before they've typed.
  if (rules.trim().length === 0) return null;

  if (!result) {
    return (
      <div className="px-4 py-2 border-t border-[#2a2a35] text-[11px] text-slate-gray font-mono">
        linting…
      </div>
    );
  }

  const { parseError, warnings } = result;
  const hasParse = !!parseError;
  const sorted = [...warnings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

  if (!hasParse && sorted.length === 0) {
    return (
      <div className="px-4 py-2 border-t border-[#2a2a35] text-[11px] text-slate-gray font-mono flex items-center justify-between">
        <span className="text-[#a4d4a8]">rules ok</span>
        <span className={isLinting ? 'opacity-50' : 'opacity-0'}>linting…</span>
      </div>
    );
  }

  const summary = formatRulesLintSummary(hasParse, sorted);
  const summaryTone = hasParse || sorted.some((warning) => warning.severity === 'error')
    ? 'text-[#f0a0a0]'
    : 'text-[#e6c79c]';

  return (
    <section
      className={[
        'shrink-0 border-t border-[#2a2a35] bg-content-bg font-mono',
        collapsed ? '' : 'max-h-[35%] min-h-0 overflow-hidden flex flex-col',
        isLinting ? 'opacity-60' : '',
      ].join(' ')}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls="rules-lint-strip-body"
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left hover:bg-[#1e1e24]"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={[
              'material-symbols-outlined shrink-0 text-[14px] text-slate-gray transition-transform',
              collapsed ? '' : 'rotate-90',
            ].join(' ')}
            aria-hidden
          >
            chevron_right
          </span>
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-gray">
            rules lint
          </span>
          <span className={`truncate text-[12px] ${summaryTone}`}>{summary}</span>
        </span>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-gray">
          {isLinting ? 'linting...' : collapsed ? 'show' : 'hide'}
        </span>
      </button>
      {!collapsed ? (
        <div
          id="rules-lint-strip-body"
          className="min-h-0 space-y-1 overflow-y-auto px-4 pb-2 hide-scrollbar"
        >
          {hasParse ? (
            <p className="text-[12px] font-mono text-[#f0a0a0] whitespace-pre-wrap break-words">
              <span className="text-[10px] uppercase mr-2 opacity-70">parse</span>
              line {parseError!.line}:{parseError!.column} — expected {parseError!.expected}
              {parseError!.actual
                ? `, got ${JSON.stringify(parseError!.actual.slice(0, 40))}`
                : ''}
            </p>
          ) : null}
          {sorted.map((w, i) => (
            <p
              key={i}
              className={`text-[12px] font-mono whitespace-pre-wrap break-words ${severityTone(w.severity)}`}
            >
              <span className="text-[10px] uppercase mr-2 opacity-70">{w.severity}</span>
              {w.rule ? <span className="text-slate-gray mr-2">[{w.rule}]</span> : null}
              {(() => {
                const loc = locationLabel(w);
                return loc ? <span className="text-slate-gray mr-2">{loc}:</span> : null;
              })()}
              <span>{w.message}</span>
              {w.fix ? <span className="text-slate-gray"> · fix: {w.fix}</span> : null}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}
