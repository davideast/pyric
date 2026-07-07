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
import { useRulesLint } from '~/hooks/useRulesLint';
import { useWorkspaceStore } from '~/lib/store/workspace';
import type { LintWarning } from 'pyric/rules';

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

export function RulesLintStrip() {
  const { result, isLinting } = useRulesLint();
  const rules = useWorkspaceStore((s) => s.rules);

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

  return (
    <div
      className={[
        'px-4 py-2 border-t border-[#2a2a35] space-y-1 max-h-[35%] overflow-y-auto hide-scrollbar',
        isLinting ? 'opacity-60' : '',
      ].join(' ')}
    >
      {hasParse ? (
        <p className="text-[12px] font-mono text-[#f0a0a0] whitespace-pre-wrap break-words">
          <span className="text-[10px] uppercase mr-2 opacity-70">parse</span>
          line {parseError!.line}:{parseError!.column} — expected {parseError!.expected}
          {parseError!.actual ? `, got ${JSON.stringify(parseError!.actual.slice(0, 40))}` : ''}
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
  );
}
