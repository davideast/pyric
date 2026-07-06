/**
 * Teach renderer for a `run_workspace_tests` drill-in — the W1 test
 * runner's report as a readable verdict instead of a JSON dump.
 *
 *   HEADER        — N/M passed across K files, green/red accent.
 *   PER FILE      — pass count chip; file-level errors (parse /
 *                   rules-deploy failures) called out distinctly —
 *                   those cases never ran.
 *   PER FAILURE   — method+path, compact identity (`anon` for null),
 *                   expected vs got. `got: ERROR` rows are visually
 *                   distinct (amber) and carry the teaching note that
 *                   ERROR means the TEST or SEED is wrong, not the
 *                   rules. `source: 'floor'` rows are badged — a
 *                   host-authored invariant failed, so the rules are
 *                   genuinely wrong.
 *
 * Every failure row carries a deterministic "Send to agent" hand-off
 * (same mechanism as the denial walkthrough: `onSendPrompt` +
 * `onAfterSend`, locked by `sendBusy`) composing a bounded fix prompt.
 * For authored (non-floor) cases the prompt explicitly allows "the
 * test expectation is wrong" as a legal outcome.
 *
 * Fully deterministic — no model call, no store access. Parsing is
 * defensive: `parseRunWorkspaceTestsResult` returns null on absent /
 * malformed JSON and the drill-in falls back to the generic panel.
 */
import type { CaseFailure, FileReport, TestRunReport } from '~/lib/workspace-tests/runner';
import { CopyButton } from '../CopyButton';

/* ── Pure model ────────────────────────────────────────────────── */

export type ParsedTestResult =
  | { kind: 'report'; report: TestRunReport }
  | { kind: 'refusal'; reason: string };

/** Parse the tool's resultJson defensively. Returns null (→ generic
 *  panel fallback) unless the payload is a structurally-plausible
 *  TestRunReport or the tool's `{ reason }` refusal. */
export function parseRunWorkspaceTestsResult(
  resultJson: string | undefined,
): ParsedTestResult | null {
  if (!resultJson) return null;
  let v: unknown;
  try {
    v = JSON.parse(resultJson);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as { files?: unknown; total?: unknown; passed?: unknown; reason?: unknown };
  if (typeof o.reason === 'string') return { kind: 'refusal', reason: o.reason };
  if (Array.isArray(o.files) && typeof o.total === 'number' && typeof o.passed === 'number') {
    return { kind: 'report', report: v as TestRunReport };
  }
  return null;
}

/** Compact identity line: `anon` for unauthenticated, uid + claims
 *  otherwise. Claims render as inline JSON — short by construction
 *  (test authors keep tokens small). */
export function formatIdentity(as: CaseFailure['as']): string {
  if (!as) return 'anon';
  const claims = as.token && Object.keys(as.token).length > 0 ? ` ${JSON.stringify(as.token)}` : '';
  return `${as.uid}${claims}`;
}

/**
 * Deterministic, well-shaped fix prompt for one failing case. Three
 * regimes, in priority order:
 *
 *   got ERROR      → the TEST or SEED is wrong by definition (the op
 *                    failed before rules could settle it) — forbid
 *                    rules edits for this failure.
 *   source: floor  → host-authored invariant; the expectation is
 *                    fixed, the rules are wrong — forbid test edits.
 *   authored       → bounded diagnose-first instruction where "the
 *                    test expectation is wrong" is a legal outcome.
 */
export function buildTestFixPrompt(file: string, f: CaseFailure): string {
  const lines: string[] = [];
  lines.push(`A workspace test case failed in /workspace/tests/${file}. Investigate and fix the root cause.`);
  lines.push('');
  lines.push('Failing case:');
  if (f.name) lines.push(`- name: ${f.name}`);
  lines.push(`- operation: ${f.method} ${f.path}`);
  lines.push(
    `- identity: ${
      f.as
        ? `uid "${f.as.uid}"${
            f.as.token && Object.keys(f.as.token).length > 0
              ? ` with claims ${JSON.stringify(f.as.token)}`
              : ''
          }`
        : 'unauthenticated (anon)'
    }`,
  );
  lines.push(`- expected: ${f.expect}`);
  lines.push(`- got: ${f.got}`);
  if (f.detail) lines.push(`- detail: ${f.detail}`);
  lines.push('');
  if (f.got === 'ERROR') {
    lines.push(
      '`got: ERROR` means the operation failed for a non-rules reason (see detail) — the TEST or its SEED is wrong, not the rules. Fix the test file: seed the document this case depends on, or correct the case\'s path/data/identity. Do NOT edit /workspace/firestore.rules for this failure.',
    );
  } else if (f.source === 'floor') {
    lines.push(
      'This case is a host-authored floor invariant — its expectation is correct by definition, so the rules are genuinely wrong. Make the MINIMAL edit to /workspace/firestore.rules that satisfies this case without opening unrelated access. Do NOT change the test.',
    );
  } else {
    lines.push(
      `Read /workspace/firestore.rules and /workspace/tests/${file}, then decide which is wrong:`,
    );
    lines.push(
      '(a) the rules — make the MINIMAL edit to /workspace/firestore.rules so this case passes without opening unrelated access;',
    );
    lines.push(
      "(b) the test expectation — this case is authored (not a host invariant); if the current rule behavior is actually correct, fix the test's `expect`, seed, or identity instead.",
    );
    lines.push('State which case you picked and why before editing.');
  }
  lines.push('');
  lines.push('Then re-run run_workspace_tests and confirm the whole suite is green.');
  return lines.join('\n');
}

/* ── Rendering ─────────────────────────────────────────────────── */

interface Props {
  parsed: ParsedTestResult;
  /** Submit a prompt to the agent loop — same hand-off the denial
   *  walkthrough uses. Absent → Send buttons render disabled. */
  onSendPrompt?: (prompt: string) => void;
  /** True while a turn is in flight — locks every Send button. */
  sendBusy?: boolean;
  /** Called after a Send click; parent typically closes the drill-in. */
  onAfterSend?: () => void;
}

const GREEN = '#a4d4a8';
const RED = '#f0a0a0';
const AMBER = '#e6c79c';

function RefusalNote({ reason }: { reason: string }) {
  return (
    <p className="text-[13px] text-slate-gray leading-relaxed">
      {reason === 'no ruleset'
        ? 'Nothing ran — there is no /workspace/firestore.rules to test against. Author rules first.'
        : reason === 'no test files'
          ? 'Nothing ran — no /workspace/tests/*.test.json files exist yet. Author a test suite first.'
          : `Nothing ran — ${reason}.`}
    </p>
  );
}

function FloorBadge() {
  return (
    <span
      className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-mono uppercase tracking-wider bg-[#f0a0a0]/15 text-[#f0a0a0]"
      title="Host-authored floor invariant — the expectation is fixed; this failure means the rules are genuinely wrong."
    >
      floor
    </span>
  );
}

function FailureRow({
  file,
  failure,
  onSendPrompt,
  sendBusy,
  onAfterSend,
}: {
  file: string;
  failure: CaseFailure;
  onSendPrompt?: (prompt: string) => void;
  sendBusy?: boolean;
  onAfterSend?: () => void;
}) {
  const isError = failure.got === 'ERROR';
  const accent = isError ? AMBER : RED;
  const prompt = buildTestFixPrompt(file, failure);

  return (
    <li
      className="rounded-md border border-[#2a2a35] px-3 py-2.5"
      style={{ borderLeftColor: accent, borderLeftWidth: 2 }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] font-mono text-soft-white min-w-0 break-words">
          <span className="uppercase tracking-wider">{failure.method}</span>{' '}
          <span className="text-soft-white/90">{failure.path}</span>
        </span>
        <span className="flex items-center gap-1.5 shrink-0">
          {failure.source === 'floor' ? <FloorBadge /> : null}
        </span>
      </div>

      {failure.name ? (
        <p className="mt-0.5 text-[11px] text-slate-gray leading-relaxed">{failure.name}</p>
      ) : null}

      <p className="mt-1.5 text-[11px] font-mono text-slate-gray break-words">
        <span className="opacity-70">as</span>{' '}
        <span className="text-soft-white/90">{formatIdentity(failure.as)}</span>
        <span className="opacity-40 mx-1.5">·</span>
        <span className="opacity-70">expected</span>{' '}
        <span className="text-soft-white/90">{failure.expect}</span>
        <span className="opacity-40 mx-1.5">·</span>
        <span className="opacity-70">got</span>{' '}
        <span style={{ color: accent }}>{failure.got}</span>
      </p>

      {failure.detail ? (
        <p
          className="mt-1.5 text-[11px] font-mono whitespace-pre-wrap break-words leading-relaxed"
          style={{ color: accent }}
        >
          {failure.detail}
        </p>
      ) : null}

      {isError ? (
        <p className="mt-1.5 text-[11px] text-slate-gray leading-relaxed">
          <span className="font-mono" style={{ color: AMBER }}>
            ERROR
          </span>{' '}
          means the operation failed for a non-rules reason — the test or its seed is wrong
          (e.g. an update against a doc that was never seeded), not the rules.
        </p>
      ) : null}

      {/* Deterministic hand-off — same mechanism as the denial
       *  walkthrough's Send to agent. */}
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          disabled={!onSendPrompt || !!sendBusy}
          onClick={() => {
            onSendPrompt?.(prompt);
            onAfterSend?.();
          }}
          className={[
            'flex items-center gap-1.5 px-2.5 py-1 rounded-md',
            'bg-[#2a2a35] hover:bg-[#3a3a48] transition-colors',
            'text-[10px] font-mono uppercase tracking-wider text-soft-white',
            'disabled:opacity-50 disabled:cursor-not-allowed',
          ].join(' ')}
          title="Submit a well-shaped fix prompt (failing case facts + bounded instruction) to the agent"
        >
          <span className="material-symbols-outlined text-[13px]">send</span>
          <span>Send to agent</span>
        </button>
        <CopyButton value={prompt} label="Copy fix prompt" size={13} />
      </div>
    </li>
  );
}

function FileSection({
  file,
  onSendPrompt,
  sendBusy,
  onAfterSend,
}: {
  file: FileReport;
  onSendPrompt?: (prompt: string) => void;
  sendBusy?: boolean;
  onAfterSend?: () => void;
}) {
  const clean = !file.error && file.failures.length === 0;
  return (
    <section className="mt-5">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <span className="text-[12px] font-mono text-soft-white truncate">{file.file}</span>
        <span
          className="text-[11px] font-mono tabular-nums shrink-0"
          style={{ color: file.error ? RED : clean ? GREEN : RED }}
        >
          {file.error ? 'did not run' : `${file.passed}/${file.total} passed`}
        </span>
      </div>

      {file.error ? (
        /* File-level failure (unparseable test file, rules deploy
         *  error) — distinct from case failures: nothing in this
         *  file ran at all. */
        <div className="rounded-md border border-[#f0a0a0]/40 bg-[#f0a0a0]/[0.06] px-3 py-2.5">
          <p className="text-[10px] uppercase tracking-wider font-bold mb-1" style={{ color: RED }}>
            file error
          </p>
          <p className="text-[11px] font-mono whitespace-pre-wrap break-words leading-relaxed text-soft-white/90">
            {file.error}
          </p>
          <p className="mt-1.5 text-[11px] text-slate-gray leading-relaxed">
            No cases in this file ran — fix the test file (or the ruleset it deploys) first.
          </p>
        </div>
      ) : clean ? (
        <p className="text-[11px] text-slate-gray italic">All cases passed.</p>
      ) : (
        <ul className="space-y-2">
          {file.failures.map((f, i) => (
            <FailureRow
              key={i}
              file={file.file}
              failure={f}
              onSendPrompt={onSendPrompt}
              sendBusy={sendBusy}
              onAfterSend={onAfterSend}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function TestReportView({ parsed, onSendPrompt, sendBusy, onAfterSend }: Props) {
  if (parsed.kind === 'refusal') return <RefusalNote reason={parsed.reason} />;
  const report = parsed.report;
  const ok = report.ok;
  const accent = ok ? GREEN : RED;
  const fileCount = report.files.length;

  return (
    <div data-teach="test-report">
      {/* Verdict header — the one number the user came here for. */}
      <div
        className={[
          'rounded-md border px-4 py-3',
          ok ? 'border-[#a4d4a8]/40 bg-[#a4d4a8]/[0.06]' : 'border-[#f0a0a0]/40 bg-[#f0a0a0]/[0.06]',
        ].join(' ')}
      >
        <p className="text-[14px] font-mono leading-none">
          <span style={{ color: accent }}>
            {report.passed}/{report.total} passed
          </span>
          <span className="text-slate-gray text-[12px]">
            {' '}
            across {fileCount} file{fileCount === 1 ? '' : 's'}
          </span>
        </p>
        {!ok ? (
          <p className="mt-1.5 text-[11px] text-slate-gray leading-relaxed">
            {report.failed > 0
              ? `${report.failed} failing case${report.failed === 1 ? '' : 's'}`
              : 'a test file failed to run'}
            {' — each failure below carries a ready-made fix prompt.'}
          </p>
        ) : null}
      </div>

      {report.files.map((f) => (
        <FileSection
          key={f.file}
          file={f}
          onSendPrompt={onSendPrompt}
          sendBusy={sendBusy}
          onAfterSend={onAfterSend}
        />
      ))}
    </div>
  );
}
