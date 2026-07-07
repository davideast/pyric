/**
 * Per-tool behavior phrasing. The agent-facing summary on each call
 * (`writeApp · 877 chars (replaced)`) is structured but not
 * conversational — fine for the model to quote, wrong for the drill-in
 * where the user reads it as a sentence. This file maps a call's
 * inputs/result into a verb-phrase that describes what the call
 * actually did.
 *
 *   writeRules + replaced=true  → "Replaced the rules source"
 *   writeRules + replaced=false → "Wrote initial rules source"
 *   runOnce + entries=…         → "Ran sandbox · 17ms · 1 doc touched"
 *
 * Pure function — takes parsed args/result, returns a string. Used
 * by the drill-in header and the activity row's subtitle line.
 */
import type { LogEntry } from '~/lib/sandbox/runner';
import { formatDuration } from '~/lib/utils/format';

interface ParsedCall {
  name: string;
  args: unknown;
  result: unknown;
}

interface WriteResult {
  replaced?: boolean;
  source?: string;
  diff?: { added: number; removed: number };
}

interface RunOnceResult {
  deployOk?: boolean;
  run?: {
    ok: boolean;
    durationMs: number;
    docsTouched: number;
    writes?: number;
    deletes?: number;
    denials?: number;
    errors: number;
    entries: LogEntry[];
  };
}

function pluralize(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : plural ?? `${singular}s`}`;
}

export function behaviorForCall({ name, result }: ParsedCall): string {
  if (name === 'writeRules') {
    const r = result as WriteResult | null;
    return r?.replaced ? 'Replaced the rules source' : 'Wrote initial rules source';
  }
  if (name === 'writeCode') {
    const r = result as WriteResult | null;
    return r?.replaced
      ? 'Replaced the sandbox script'
      : 'Wrote initial sandbox script';
  }
  if (name === 'writeApp') {
    const r = result as WriteResult | null;
    return r?.replaced ? 'Replaced the App TSX source' : 'Wrote initial App TSX source';
  }
  if (name === 'runOnce') {
    const r = result as RunOnceResult | null;
    if (!r?.deployOk) return 'Tried to run, deploy rejected';
    if (!r.run) return 'Deployed rules, code did not run';
    const run = r.run;
    const parts = [
      `Ran sandbox · ${formatDuration(run.durationMs)}`,
      pluralize(run.docsTouched, 'doc touched'),
    ];
    if (run.errors > 0) parts.push(pluralize(run.errors, 'error'));
    return parts.join(' · ');
  }
  return `Called ${name}`;
}

/**
 * Compact stats line for the activity-row's right column. Per the
 * `PROPOSAL-tool-call-metadata.md` doc, we drop `chars (replaced)`
 * in favor of:
 *
 *   write tools: `Δ +N / −M` when there was a prior body,
 *                otherwise `N lines` for the initial write.
 *   runOnce:     `Nms · X writes · Y reads · Z denials` where any
 *                zero category is omitted.
 *   unknown:     fall back to the call's raw `summary`.
 */
export function rowStatForCall(
  parsed: ParsedCall,
  fallback?: string,
): string {
  const { name, result } = parsed;

  if (name === 'writeRules' || name === 'writeCode' || name === 'writeApp') {
    const r = result as WriteResult | null;
    const diff = r?.diff;
    if (diff && r?.replaced) {
      return `Δ +${diff.added.toLocaleString()} / −${diff.removed.toLocaleString()}`;
    }
    // Initial write: render line count of the new source.
    if (typeof r?.source === 'string') {
      const lines = r.source.split('\n').length;
      return `${lines.toLocaleString()} ${lines === 1 ? 'line' : 'lines'}`;
    }
  }

  if (name === 'runOnce') {
    const r = result as RunOnceResult | null;
    if (!r?.deployOk) return 'deploy rejected';
    if (!r.run) return 'no run';
    const run = r.run;
    const parts: string[] = [formatDuration(run.durationMs)];
    // Prefer the runner's structured breakdown when present.
    // Falls back to the old `docsTouched` total for snapshots that
    // didn't carry the breakdown fields (replay path / cached
    // results from older runs).
    const writes = run.writes ?? run.docsTouched;
    if (writes > 0) parts.push(`${writes} write${writes === 1 ? '' : 's'}`);
    if (run.deletes && run.deletes > 0) {
      parts.push(`${run.deletes} delete${run.deletes === 1 ? '' : 's'}`);
    }
    // Denials and errors are different signals: denial = rule
    // rejected the op, error = code threw. Show denials separately
    // when present so the reader can scan denial-vs-error.
    const denials = run.denials ?? run.entries.filter((e) => e.level === 'denial').length;
    if (denials > 0) {
      parts.push(`${denials} denial${denials === 1 ? '' : 's'}`);
    }
    if (run.errors > 0) {
      parts.push(`${run.errors} error${run.errors === 1 ? '' : 's'}`);
    }
    return parts.join(' · ');
  }

  // Unknown / undecorated tool — fall back to whatever summary the
  // call already carries.
  return fallback ?? '';
}

/**
 * Rough token estimate for a source string. Tokens are the cost
 * surface; chars are objective but meaningless. ~4 chars/token is
 * close enough for English + code on every model we ship.
 *
 * Returns `null` for empty input so the caller can omit the chip.
 */
export function estimateTokens(s: string | undefined | null): number | null {
  if (!s) return null;
  if (s.length === 0) return 0;
  return Math.max(1, Math.round(s.length / 4));
}
