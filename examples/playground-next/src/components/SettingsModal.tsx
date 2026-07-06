/**
 * Settings modal — playground-level UX knobs. Triggered by the gear
 * icon in the TopBar (between key and save). All toggles persist
 * via `useSettingsStore` (localStorage-backed).
 *
 * Knobs:
 *   - "Auto-fold all but the most recent turn" — when on, each new
 *     turn auto-collapses the prior ones. Same as pressing `[` after
 *     every send. Can also be triggered manually via "Collapse older
 *     now" without enabling the persistent behavior.
 *   - "Enable pyric diagnostics" — master switch for the pyric
 *     diagnostic layer: inline rules lint, denials, and pitfalls
 *     primer in the agent's system prompt; the `ctx.lint` tool
 *     context helper; and any registered diagnostic tools (e.g.
 *     lintRules, simulateRules, discoverPaths once they land). Core
 *     write/run tools (writeRules / writeCode / writeApp / runOnce)
 *     stay registered either way so the agent can always function.
 *     Toggle off to A/B-compare agent behavior without playground-
 *     supplied diagnostics. Toggling appends a `role: 'system'`
 *     message to the chat so the export records when the switch
 *     flipped.
 *
 * Hotkeys section names the `[` shortcut so users can discover it
 * from inside the modal without reading docs.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { clearPAT, getStoredPAT, storePAT } from '~/lib/git/github-auth';
import { useChatStore } from '~/lib/store/chat';
import {
  defaultMaxTurnsForLane,
  isDiagnosticToolEnabled,
  DRAFT_REPAIRS_MAX,
  DRAFT_REPAIRS_MIN,
  MAX_TURNS_DEFAULT_HOSTED,
  MAX_TURNS_MAX,
  MAX_TURNS_MIN,
  OPENROUTER_PRICE_MAX,
  REFLEXION_RETRIES_MAX,
  REFLEXION_RETRIES_MIN,
  useSettingsStore,
  type OpenrouterSort,
} from '~/lib/store/settings';
import { DIAGNOSTIC_TOOL_MANIFEST } from '~/lib/tools/diagnostics';
import {
  clearAllLogs,
  exportLogs,
  summarize,
} from '~/lib/llm/inference/diagnostics';
import { useLlmStore } from '~/lib/store/llm';
import { Modal } from './Modal';

interface Props {
  open: boolean;
  onClose: () => void;
}

function logSessionEvent(text: string): void {
  useChatStore.getState().appendMessage({
    id: `event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'system',
    text,
    createdAt: Date.now(),
  });
}

export function SettingsModal({ open, onClose }: Props) {
  const autoFoldOlder = useSettingsStore((s) => s.autoFoldOlder);
  const setAutoFoldOlder = useSettingsStore((s) => s.setAutoFoldOlder);
  const pyricDiagnosticsEnabled = useSettingsStore((s) => s.pyricDiagnosticsEnabled);
  const setPyricDiagnosticsEnabled = useSettingsStore((s) => s.setPyricDiagnosticsEnabled);
  const diagnosticToolsEnabled = useSettingsStore((s) => s.diagnosticToolsEnabled);
  const setDiagnosticToolEnabled = useSettingsStore((s) => s.setDiagnosticToolEnabled);
  const resumableServerMode = useSettingsStore((s) => s.resumableServerMode);
  const setResumableServerMode = useSettingsStore((s) => s.setResumableServerMode);
  const maxTurns = useSettingsStore((s) => s.maxTurns);
  const setMaxTurns = useSettingsStore((s) => s.setMaxTurns);
  const parallelDispatch = useSettingsStore((s) => s.parallelDispatch);
  const setParallelDispatch = useSettingsStore((s) => s.setParallelDispatch);
  const reflexionEnabled = useSettingsStore((s) => s.reflexionEnabled);
  const setReflexionEnabled = useSettingsStore((s) => s.setReflexionEnabled);
  const reflexionMaxRetries = useSettingsStore((s) => s.reflexionMaxRetries);
  const setReflexionMaxRetries = useSettingsStore((s) => s.setReflexionMaxRetries);
  const strategyMode = useSettingsStore((s) => s.strategyMode);
  const setStrategyMode = useSettingsStore((s) => s.setStrategyMode);
  // Strategy/provider note — the Claude (local CLI) lane runs tools
  // through the dev server's MCP bridge (claude -p owns the tool loop).
  const activeProviderId = useLlmStore((s) => s.providerId);
  const draftMaxRepairs = useSettingsStore((s) => s.draftMaxRepairs);
  const setDraftMaxRepairs = useSettingsStore((s) => s.setDraftMaxRepairs);
  const openrouterSort = useSettingsStore((s) => s.openrouterSort);
  const setOpenrouterSort = useSettingsStore((s) => s.setOpenrouterSort);
  const openrouterMaxPromptPrice = useSettingsStore((s) => s.openrouterMaxPromptPrice);
  const setOpenrouterMaxPromptPrice = useSettingsStore((s) => s.setOpenrouterMaxPromptPrice);
  const openrouterMaxCompletionPrice = useSettingsStore((s) => s.openrouterMaxCompletionPrice);
  const setOpenrouterMaxCompletionPrice = useSettingsStore(
    (s) => s.setOpenrouterMaxCompletionPrice,
  );
  const bumpCollapse = useSettingsStore((s) => s.bumpCollapse);

  // Diagnostics panel state. The whole point is to read the activity
  // log on a device with no DevTools (mobile) — generate the JSON,
  // copy it, paste it back when reporting an issue.
  const [diagOutput, setDiagOutput] = useState('');
  const [diagStatus, setDiagStatus] = useState('');

  const handleTogglePyricDiagnostics = () => {
    const next = !pyricDiagnosticsEnabled;
    setPyricDiagnosticsEnabled(next);
    logSessionEvent(
      next
        ? 'Pyric diagnostics enabled — inline rules lint, denials, and pitfalls primer in system prompt; ctx.lint live'
        : 'Pyric diagnostics disabled — agent sees only workspace state and runOnce results (no inline lint/denials/pitfalls)',
    );
  };

  const handleToggleDiagnosticTool = (key: string, label: string) => {
    const wasEnabled = isDiagnosticToolEnabled({ diagnosticToolsEnabled }, key);
    setDiagnosticToolEnabled(key, !wasEnabled);
    logSessionEvent(
      !wasEnabled
        ? `Diagnostic tool enabled — ${label} (${key})`
        : `Diagnostic tool disabled — ${label} (${key})`,
    );
  };

  const handleShowSummary = async () => {
    setDiagStatus('generating summary…');
    try {
      const s = await summarize();
      setDiagOutput(JSON.stringify(s, null, 2));
      setDiagStatus(
        `summary — ${s.requests.length} request(s), ${s.anomalies.length} anomal${
          s.anomalies.length === 1 ? 'y' : 'ies'
        }`,
      );
    } catch (e) {
      setDiagStatus(`summary failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleShowFullLogs = async () => {
    setDiagStatus('exporting full logs…');
    try {
      const p = await exportLogs();
      setDiagOutput(JSON.stringify(p, null, 2));
      setDiagStatus(`full logs — ${p.counts.page} page event(s)`);
    } catch (e) {
      setDiagStatus(`export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleCopyDiag = async () => {
    if (!diagOutput) {
      setDiagStatus('nothing to copy — generate a summary first');
      return;
    }
    try {
      // A button click IS a user gesture, so clipboard.writeText is
      // allowed here (unlike a console invocation).
      await navigator.clipboard.writeText(diagOutput);
      setDiagStatus('copied to clipboard');
    } catch {
      setDiagStatus('copy blocked — tap the box, select all, copy manually');
    }
  };

  const handleClearDiag = async () => {
    setDiagStatus('clearing…');
    await clearAllLogs();
    setDiagOutput('');
    setDiagStatus('logs cleared');
  };

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Settings">
      <h2 className="text-soft-white text-[15px] font-semibold mb-1">Settings</h2>
      <p className="text-slate-gray text-[12px] mb-5">
        Stored in this browser only.
      </p>

      <section className="space-y-4">
        <div className="space-y-1.5">
          <ToggleRow
            checked={autoFoldOlder}
            onChange={() => setAutoFoldOlder(!autoFoldOlder)}
            title="Auto-fold all but the most recent turn"
            body="When a new turn arrives, prior turns collapse to a single header strip. Click any to expand again."
          />
          <div className="pl-7">
            <button
              type="button"
              onClick={() => {
                bumpCollapse();
                onClose();
              }}
              className="text-[11px] font-mono uppercase tracking-wider text-slate-gray hover:text-soft-white transition-colors"
              title="Collapse all turns except the most recent right now"
            >
              collapse older now
            </button>
          </div>
        </div>

        <div className="space-y-1.5 pt-2">
          <ToggleRow
            checked={pyricDiagnosticsEnabled}
            onChange={handleTogglePyricDiagnostics}
            title="Enable pyric diagnostics"
            body="Inline rules lint, recent denials, and rules-pitfalls primer in the agent's system prompt, plus diagnostic tools under tools/diagnostics/. Core write/run tools stay registered either way. Turn off to A/B-compare agent behavior without playground-supplied diagnostics. Toggling is logged as a session event in the exported JSON."
          />
          <div
            className={[
              'pl-7 pt-1.5 space-y-1.5 transition-opacity',
              pyricDiagnosticsEnabled ? 'opacity-100' : 'opacity-40 pointer-events-none',
            ].join(' ')}
            aria-disabled={!pyricDiagnosticsEnabled}
          >
            <p className="text-[10px] uppercase tracking-wider text-slate-gray font-bold">
              diagnostic tools
            </p>
            {DIAGNOSTIC_TOOL_MANIFEST.map((entry) => (
              <SubToggleRow
                key={entry.key}
                checked={isDiagnosticToolEnabled({ diagnosticToolsEnabled }, entry.key)}
                onChange={() => handleToggleDiagnosticTool(entry.key, entry.label)}
                title={entry.label}
                body={entry.description}
              />
            ))}
          </div>
        </div>

        <div className="space-y-1.5 pt-2">
          <ToggleRow
            checked={resumableServerMode}
            onChange={() => setResumableServerMode(!resumableServerMode)}
            title="Resumable server stream"
            body="Routes inference through the server, which holds the provider connection and buffers it into a durable job store. The client reconnects with an offset after a backgrounding drop and the server replays from exactly there — live streaming that survives tab backgrounding, plus recovery of an interrupted reply after a reload. On by default for cloud providers (Gemini/OpenRouter); local providers and the Claude lane always run page-direct, which is also the automatic fallback when the server route is unavailable."
          />
        </div>

        <div className="space-y-1.5 pt-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-soft-white text-[13px]">Agent max turns per prompt</p>
              <p className="text-slate-gray text-[11px] mt-0.5">
                Cap on the react-loop's tool-call iterations before the agent gives up.
                Raise when complex prompts hit "exceeded maxTurns without settling"; lower
                to fail-fast on runaway loops. Allowed range: {MAX_TURNS_MIN}–{MAX_TURNS_MAX}.
                Takes effect on the next submit.
              </p>
              <p className="text-slate-gray text-[11px] mt-0.5">
                default {MAX_TURNS_DEFAULT_HOSTED} for hosted models
                {maxTurns === undefined
                  ? ` — effective now: ${defaultMaxTurnsForLane(activeProviderId)}`
                  : ` — your setting (${maxTurns}) overrides it`}
              </p>
            </div>
            <input
              type="number"
              min={MAX_TURNS_MIN}
              max={MAX_TURNS_MAX}
              step={1}
              value={maxTurns ?? defaultMaxTurnsForLane(activeProviderId)}
              onChange={(e) => {
                const parsed = parseInt(e.target.value, 10);
                if (!Number.isFinite(parsed)) return;
                setMaxTurns(parsed);
              }}
              className="w-16 px-2 py-1 rounded bg-[#0f0f17] border border-[#2a2a35] text-soft-white text-[13px] font-mono text-right focus:outline-none focus:border-[#3a3a48]"
              aria-label="Agent max turns per prompt"
            />
          </div>
        </div>

        <div className="space-y-1.5 pt-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-soft-white text-[13px]">Agent strategy</p>
              <p className="text-slate-gray text-[11px] mt-0.5">
                <span className="text-soft-white">Auto</span> (default) routes per prompt:
                build/modify requests that touch data or security run Draft → Validate, with a
                one-shot fallback to ReAct when repairs run out; questions, debugging, and pure-UI
                work run ReAct. <span className="text-soft-white">ReAct</span> and{' '}
                <span className="text-soft-white">Draft → Validate</span> pin a strategy — pins
                always win over the router. Takes effect on the next submit.
              </p>
            </div>
            {/* The Claude (local CLI) lane is DELEGATED: `claude -p` runs
             *  its own agent loop server-side, so the playground's
             *  react/DV strategies never drive a turn there — the picker
             *  is disabled rather than silently ignored. */}
            <div
              className={
                'flex rounded border border-[#2a2a35] overflow-hidden shrink-0 text-[12px]' +
                (activeProviderId === 'claude' ? ' opacity-40 pointer-events-none' : '')
              }
              aria-disabled={activeProviderId === 'claude'}
            >
              {(['auto', 'react', 'draft-validate'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  disabled={activeProviderId === 'claude'}
                  onClick={() => setStrategyMode(mode)}
                  className={
                    'px-2.5 py-1 ' +
                    (strategyMode === mode
                      ? 'bg-[#2a2a35] text-soft-white'
                      : 'bg-[#0f0f17] text-slate-gray hover:text-soft-white')
                  }
                >
                  {mode === 'auto' ? 'Auto' : mode === 'react' ? 'ReAct' : 'Draft → Validate'}
                </button>
              ))}
            </div>
          </div>
          {activeProviderId === 'claude' ? (
            <div className="rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2">
              <p className="text-[11px] text-sky-200/90 leading-snug">
                Claude (local CLI) turns are <span className="text-sky-100">delegated</span>:{' '}
                <code className="font-mono">claude -p</code> is its own agent and runs the whole
                tool loop server-side against the dev server&apos;s MCP bridge (files, workspace
                tests, rules simulation/stdlib/lint, jailed bash). The strategy picker above does
                not apply on this lane — one delegated call per prompt, no playground-side ReAct
                or Draft → Validate. Tool calls don&apos;t stream into the transcript; file
                changes sync into the workspace when the turn finishes.
              </p>
            </div>
          ) : null}
          {strategyMode !== 'react' ? (
            <div className="flex items-center justify-between gap-3 pl-3 pt-1">
              <div className="flex-1 min-w-0">
                <p className="text-soft-white text-[13px]">Max repairs</p>
                <p className="text-slate-gray text-[11px] mt-0.5">
                  Re-draft attempts after a failed validation. 0 = validate once and show the
                  verdict, never retry. Range: {DRAFT_REPAIRS_MIN}–{DRAFT_REPAIRS_MAX}.
                </p>
              </div>
              <input
                type="number"
                min={DRAFT_REPAIRS_MIN}
                max={DRAFT_REPAIRS_MAX}
                step={1}
                value={draftMaxRepairs}
                onChange={(e) => {
                  const parsed = parseInt(e.target.value, 10);
                  if (!Number.isFinite(parsed)) return;
                  setDraftMaxRepairs(parsed);
                }}
                className="w-16 px-2 py-1 rounded bg-[#0f0f17] border border-[#2a2a35] text-soft-white text-[13px] font-mono text-right focus:outline-none focus:border-[#3a3a48]"
                aria-label="Draft-validate max repairs"
              />
            </div>
          ) : null}
        </div>

        {strategyMode !== 'draft-validate' ? (
          <>
        <div className="space-y-1.5 pt-2">
          <ToggleRow
            checked={parallelDispatch}
            onChange={() => setParallelDispatch(!parallelDispatch)}
            title="Parallel tool dispatch"
            body="Runs parallel-safe tool calls (reads and rule simulations) in a turn concurrently instead of one at a time; mutations still run sequentially after. Traces are byte-identical to a serial run — only wall-clock changes. A latency lever for rules work that fires many simulate calls per turn. Off by default. Takes effect on the next submit."
          />
        </div>

        <div className="space-y-1.5 pt-2">
          <ToggleRow
            checked={reflexionEnabled}
            onChange={() => setReflexionEnabled(!reflexionEnabled)}
            title="Reflexion (self-critique + retry)"
            body="After the agent produces a final answer, a second LLM call critiques it against the prior tool results. On a failed critique the loop retries with the feedback injected. Improves correctness for rules edits, but adds a critique call (and up to the retries below) per answer — slower. The critique decision shows under each reply. Off by default. Takes effect on the next submit."
          />
          {reflexionEnabled ? (
            <div className="flex items-center justify-between gap-3 pl-3 pt-1">
              <div className="flex-1 min-w-0">
                <p className="text-soft-white text-[13px]">Reflexion max retries</p>
                <p className="text-slate-gray text-[11px] mt-0.5">
                  How many times a failed critique can trigger a retry. 0 = critique
                  still runs and is shown, but never retries. Range:{' '}
                  {REFLEXION_RETRIES_MIN}–{REFLEXION_RETRIES_MAX}.
                </p>
              </div>
              <input
                type="number"
                min={REFLEXION_RETRIES_MIN}
                max={REFLEXION_RETRIES_MAX}
                step={1}
                value={reflexionMaxRetries}
                onChange={(e) => {
                  const parsed = parseInt(e.target.value, 10);
                  if (!Number.isFinite(parsed)) return;
                  setReflexionMaxRetries(parsed);
                }}
                className="w-16 px-2 py-1 rounded bg-[#0f0f17] border border-[#2a2a35] text-soft-white text-[13px] font-mono text-right focus:outline-none focus:border-[#3a3a48]"
                aria-label="Reflexion max retries"
              />
            </div>
          ) : null}
        </div>
          </>
        ) : null}

        <div className="space-y-1.5 pt-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-soft-white text-[13px]">OpenRouter routing</p>
              <p className="text-slate-gray text-[11px] mt-0.5">
                How OpenRouter picks among a model's providers. Fastest (throughput) is the
                default; OpenRouter's own default optimizes price and can land on congested
                providers. Takes effect on the next submit.
              </p>
            </div>
            <select
              value={openrouterSort}
              onChange={(e) => setOpenrouterSort(e.target.value as OpenrouterSort)}
              className="px-2 py-1 rounded bg-[#0f0f17] border border-[#2a2a35] text-soft-white text-[12px] font-mono shrink-0 focus:outline-none focus:border-[#3a3a48]"
              aria-label="OpenRouter routing sort"
            >
              <option value="throughput">Fastest (throughput)</option>
              <option value="price">Cheapest (price)</option>
              <option value="latency">Lowest latency</option>
              <option value="default">OpenRouter default</option>
            </select>
          </div>
          <div className="flex items-center justify-between gap-3 pl-3 pt-1">
            <p className="flex-1 min-w-0 text-soft-white text-[13px]">Max input $/M tok</p>
            <PriceInput
              value={openrouterMaxPromptPrice}
              onChange={setOpenrouterMaxPromptPrice}
              ariaLabel="Max input price, USD per million tokens"
            />
          </div>
          <div className="flex items-center justify-between gap-3 pl-3 pt-1">
            <p className="flex-1 min-w-0 text-soft-white text-[13px]">Max output $/M tok</p>
            <PriceInput
              value={openrouterMaxCompletionPrice}
              onChange={setOpenrouterMaxCompletionPrice}
              ariaLabel="Max output price, USD per million tokens"
            />
          </div>
          <p className="text-slate-gray text-[11px] pl-3">
            Price ceilings exclude providers above the cap; routing picks the best remaining.
          </p>
        </div>
      </section>

      <GitHubSection open={open} />

      <section className="mt-6 pt-4 border-t border-[#2a2a35]">
        <p className="text-[10px] uppercase tracking-wider text-slate-gray font-bold mb-2">
          hotkeys
        </p>
        <ul className="space-y-1 text-[12px] text-slate-gray">
          <li className="flex items-center gap-3">
            <kbd className="px-1.5 py-0.5 rounded border border-[#2a2a35] bg-[#0f0f17] text-soft-white font-mono text-[11px]">
              [
            </kbd>
            <span>Collapse all turns except the most recent</span>
          </li>
        </ul>
      </section>

      <section className="mt-6 pt-4 border-t border-[#2a2a35]">
        <p className="text-[10px] uppercase tracking-wider text-slate-gray font-bold mb-2">
          diagnostics
        </p>
        <p className="text-[11px] text-slate-gray leading-snug mb-3">
          Page activity log. Generate a summary, copy it, and paste it
          back when reporting an issue — no DevTools needed. "Full logs"
          is the raw firehose; start with "Summary". "Clear" wipes it for
          a fresh test run.
        </p>
        <div className="flex flex-wrap gap-2 mb-2">
          <DiagButton onClick={handleShowSummary}>summary</DiagButton>
          <DiagButton onClick={handleShowFullLogs}>full logs</DiagButton>
          <DiagButton onClick={handleCopyDiag}>copy</DiagButton>
          <DiagButton onClick={handleClearDiag}>clear</DiagButton>
        </div>
        {diagStatus ? (
          <p className="text-[11px] font-mono text-slate-gray mb-2">{diagStatus}</p>
        ) : null}
        {diagOutput ? (
          <textarea
            readOnly
            value={diagOutput}
            onFocus={(e) => e.currentTarget.select()}
            spellCheck={false}
            className="w-full h-48 rounded border border-[#2a2a35] bg-[#0f0f17] text-soft-white font-mono text-[10px] leading-snug p-2 resize-y"
          />
        ) : null}
      </section>
    </Modal>
  );
}

/**
 * GitHub Personal Access Token field. Drives git clone / push through
 * `isomorphic-git`'s `onAuth` callback. The token is stored in a
 * dedicated IndexedDB DB (`pyric:github-creds`) — never sent to the
 * server, never echoed to the chat log. We render a masked preview
 * of the stored value so users can tell whether a token is configured
 * without exposing the secret to a casual screen view.
 */
function GitHubSection({ open }: { open: boolean }) {
  const [draft, setDraft] = useState('');
  const [stored, setStored] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getStoredPAT().then((value) => {
      if (!cancelled) setStored(value);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleSave = async () => {
    const value = draft.trim();
    if (!value) {
      setStatus('paste a token first');
      return;
    }
    try {
      await storePAT(value);
      setStored(value);
      setDraft('');
      setStatus('saved');
    } catch (e) {
      setStatus(`save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleClear = async () => {
    try {
      await clearPAT();
      setStored(null);
      setStatus('cleared');
    } catch (e) {
      setStatus(`clear failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const maskedStored =
    stored && stored.length > 4 ? `••••${stored.slice(-4)}` : stored ? '••••' : '';

  return (
    <section className="mt-6 pt-4 border-t border-[#2a2a35]">
      <p className="text-[10px] uppercase tracking-wider text-slate-gray font-bold mb-2">
        github
      </p>
      <p className="text-[11px] text-slate-gray leading-snug mb-3">
        Personal access token used for git clone + push. Stored only in this browser
        (IndexedDB). Create one at{' '}
        <span className="font-mono">github.com/settings/tokens</span> with{' '}
        <span className="font-mono">repo</span> scope for private repos and repo
        creation (Contents + Pull requests for fine-grained tokens).
      </p>
      <div className="flex flex-wrap gap-2 mb-2">
        <input
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={stored ? `current: ${maskedStored}` : 'ghp_… or github_pat_…'}
          spellCheck={false}
          autoComplete="off"
          className="flex-1 min-w-[200px] px-2 py-1 rounded bg-[#0f0f17] border border-[#2a2a35] text-soft-white text-[12px] font-mono focus:outline-none focus:border-[#3a3a48]"
        />
        <DiagButton onClick={handleSave}>save</DiagButton>
        {stored ? <DiagButton onClick={handleClear}>clear</DiagButton> : null}
      </div>
      {status ? <p className="text-[11px] font-mono text-slate-gray">{status}</p> : null}
    </section>
  );
}

/**
 * Optional price-ceiling input ($/M tokens). Empty = no limit — clears
 * the setting to `undefined` rather than coercing to 0 (a 0 ceiling
 * would exclude every provider). The store clamps to (0,
 * OPENROUTER_PRICE_MAX] on write, same read/write-clamp convention as
 * maxTurns.
 */
function PriceInput({
  value,
  onChange,
  ariaLabel,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  ariaLabel: string;
}) {
  return (
    <input
      type="number"
      min={0}
      max={OPENROUTER_PRICE_MAX}
      step="any"
      value={value ?? ''}
      placeholder="no limit"
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === '') {
          onChange(undefined);
          return;
        }
        const parsed = parseFloat(raw);
        if (!Number.isFinite(parsed)) return;
        onChange(parsed);
      }}
      className="w-24 px-2 py-1 rounded bg-[#0f0f17] border border-[#2a2a35] text-soft-white text-[13px] font-mono text-right placeholder:text-slate-gray/60 focus:outline-none focus:border-[#3a3a48]"
      aria-label={ariaLabel}
    />
  );
}

/**
 * Compact action button for the diagnostics panel. Same monospace /
 * uppercase treatment as the "collapse older now" affordance so the
 * panel reads as a tools strip, not primary UI.
 */
function DiagButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-2.5 py-1 rounded border border-[#2a2a35] bg-[#0f0f17] text-[11px] font-mono uppercase tracking-wider text-slate-gray hover:text-soft-white hover:border-soft-white transition-colors"
    >
      {children}
    </button>
  );
}

/**
 * Whole-row <button> toggle. Used for every checkbox-style knob in
 * the settings modal — see comments in the original auto-fold port
 * for why a button beats a wrapped <label><input/></label>: Android
 * Chrome doesn't toggle the input when the label has a block-level
 * child, and our custom checkbox visual (soft-white accent on the
 * native input was invisible when checked) needs to be drawn
 * ourselves anyway.
 */
function ToggleRow({
  checked,
  onChange,
  title,
  body,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      role="switch"
      aria-checked={checked}
      className="w-full flex items-start gap-3 text-left group py-1 -my-1"
    >
      <span
        className={[
          'mt-0.5 inline-flex shrink-0 w-[18px] h-[18px] items-center justify-center rounded-sm border transition-colors',
          checked
            ? 'bg-primary border-primary'
            : 'bg-transparent border-slate-gray group-hover:border-soft-white',
        ].join(' ')}
        aria-hidden="true"
      >
        {checked ? (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-[14px] h-[14px] text-content-bg"
          >
            <polyline points="3 8.5 6.5 12 13 4.5" />
          </svg>
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-soft-white font-medium">{title}</span>
        <span className="block text-[11px] text-slate-gray leading-snug">{body}</span>
      </span>
    </button>
  );
}

/**
 * Smaller-weight variant of ToggleRow, used for nested per-tool flags
 * under a parent master switch. 14px checkbox, smaller title, no
 * vertical padding — reads as a child row, not a peer toggle.
 */
function SubToggleRow({
  checked,
  onChange,
  title,
  body,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      role="switch"
      aria-checked={checked}
      className="w-full flex items-start gap-2.5 text-left group"
    >
      <span
        className={[
          'mt-0.5 inline-flex shrink-0 w-[14px] h-[14px] items-center justify-center rounded-sm border transition-colors',
          checked
            ? 'bg-primary border-primary'
            : 'bg-transparent border-slate-gray group-hover:border-soft-white',
        ].join(' ')}
        aria-hidden="true"
      >
        {checked ? (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-[11px] h-[11px] text-content-bg"
          >
            <polyline points="3 8.5 6.5 12 13 4.5" />
          </svg>
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] text-soft-white">{title}</span>
        <span className="block text-[10.5px] text-slate-gray leading-snug">{body}</span>
      </span>
    </button>
  );
}
