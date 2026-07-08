/**
 * Right-panel `Traffic` tab — every simulator op the user has seen
 * this session, with filter chips, a row list, click-to-drill-in,
 * and the existing batched denial Analyze panel at the bottom.
 *
 * This replaces the old `Denials`-only panel. Core insight: rules
 * are notoriously hard to debug because the gap between "I wrote a
 * rule" and "this op was evaluated against it" is where every bug
 * hides. Traffic surfaces that gap — every op the rule engine
 * touched, what clause matched, how long it took, who triggered
 * it.
 *
 * Defaults from the traffic-monitor probe (5 scenarios, 126k
 * events):
 *   - `origin: user` filter is on by default. Listener traffic
 *     dwarfs user traffic 99.6:0.4 in load tests; default-hide
 *     keeps the panel scannable.
 *   - 5000-event ring buffer. Worst-case heap after `shrink` is
 *     ~3 MB.
 *
 * Drill-in pattern mirrors the tool-call `ToolDetailView` — click a
 * row → replace the list with a detail view. "Back" returns.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useRuntimeStore,
  type DenialBlurb,
  type DenialsAnalysisSnapshot,
  type TrafficEntry,
} from '~/lib/store/runtime';
import { useNavStore } from '~/lib/store/nav';
import {
  runExplainDenial,
  runExplainDenialsBatch,
  stripSuggestionDuringStream,
} from '~/lib/llm/explain';
import { formatCostUsd } from '~/lib/llm/pricing';
import { formatDuration } from '~/lib/utils/format';
import { PROVIDERS } from '~/lib/llm/registry';
import { useLlmStore } from '~/lib/store/llm';
import { CodeBlock } from './CodeBlock';
import { CopyButton } from './CopyButton';
import { EmptyState } from './EmptyState';
import { Fold } from './Fold';
import { Markdown } from './Markdown';
import { PulsingDot } from './PulsingDot';
import { SuggestedPromptCard } from './SuggestedPromptCard';

interface Props {
  onSendPrompt?: (prompt: string) => void;
  sendBusy?: boolean;
  onAfterSend?: () => void;
}

type ResultFilter = 'all' | 'allow' | 'deny';
type OriginFilter = 'user' | 'all' | 'listener';

function formatTime(ms: number): string {
  // 24-hour, no AM/PM — mono terminal aesthetic, narrower column,
  // and the row stays single-line at the default width.
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function entryDurationMs(entry: TrafficEntry): number {
  return entry.evalMs ?? entry.durationMs ?? 0;
}

function resultTone(result: TrafficEntry['result']): {
  text: string;
  border: string;
  label: string;
} {
  if (result === 'deny') {
    return { text: 'text-[#f0a0a0]', border: 'border-[#f0a0a0]/40', label: 'deny' };
  }
  if (result === 'unsupported') {
    return { text: 'text-[#e6c79c]', border: 'border-[#e6c79c]/40', label: 'unsup' };
  }
  if (result === 'error') {
    return { text: 'text-[#f0a0a0]', border: 'border-[#f0a0a0]/40', label: 'error' };
  }
  if (result === 'not-applicable') {
    return { text: 'text-slate-gray', border: 'border-[#2a2a35]', label: 'n/a' };
  }
  return { text: 'text-[#a4d4a8]', border: 'border-[#a4d4a8]/40', label: 'allow' };
}

function buildEntryCopy(entry: TrafficEntry): string {
  return JSON.stringify(entry, null, 2);
}

export function TrafficTab({ onSendPrompt, sendBusy, onAfterSend }: Props) {
  const traffic = useRuntimeStore((s) => s.traffic);
  const trafficPaused = useRuntimeStore((s) => s.trafficPaused);
  const setTrafficPaused = useRuntimeStore((s) => s.setTrafficPaused);
  const clearTraffic = useRuntimeStore((s) => s.clearTraffic);
  const liveDenials = useRuntimeStore((s) => s.liveDenials);

  const [resultFilter, setResultFilter] = useState<ResultFilter>('all');
  const [originFilter, setOriginFilter] = useState<OriginFilter>('user');
  const [pathQuery, setPathQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Honor a pending denial-drill from the Suggestions panel.
  const pending = useNavStore((s) => s.pending);
  const clearPending = useNavStore((s) => s.clearPending);
  useEffect(() => {
    if (pending?.kind !== 'denial') return;
    setSelectedId(pending.entryId);
    clearPending();
  }, [pending, clearPending]);

  // Build a quick lookup from event id → DenialBlurb so each deny
  // row can cross-reference the parallel live-denial state without scanning.
  const denialById = useMemo(() => {
    const m = new Map<string, DenialBlurb>();
    for (const d of liveDenials) m.set(d.id, d);
    return m;
  }, [liveDenials]);

  const filtered = useMemo(() => {
    return traffic.filter((e) => {
      if (resultFilter !== 'all' && e.result !== resultFilter) return false;
      if (originFilter === 'user' && e.origin !== 'user' && e.origin !== 'batch' && e.origin !== 'transaction') {
        return false;
      }
      if (originFilter === 'listener' && e.origin !== 'listener') return false;
      if (pathQuery && !e.path.toLowerCase().includes(pathQuery.toLowerCase())) {
        return false;
      }
      return true;
    });
  }, [traffic, resultFilter, originFilter, pathQuery]);

  if (traffic.length === 0) {
    return (
      <EmptyState
        icon="network_check"
        title="No traffic yet"
        body="Run the app or have the agent call runOnce. Every simulator op — allows, denies, listener re-evals — lands here."
      />
    );
  }

  // Drill-in: when an entry is selected, the list is replaced with
  // the detail view. Same pattern as ToolDetailView.
  const selected = selectedId ? traffic.find((e) => e.id === selectedId) : null;
  if (selected) {
    return (
      <TrafficDetail
        entry={selected}
        denial={denialById.get(selected.id)}
        onBack={() => setSelectedId(null)}
        {...(onSendPrompt ? { onSendPrompt } : {})}
        {...(sendBusy !== undefined ? { sendBusy } : {})}
        {...(onAfterSend ? { onAfterSend } : {})}
      />
    );
  }

  // Most recent first. Top of the visible list is the freshest op.
  const ordered = [...filtered].reverse();
  const denyCount = traffic.filter((e) => e.result === 'deny').length;
  const listenerCount = traffic.filter((e) => e.origin === 'listener').length;
  const copyAll = JSON.stringify(filtered, null, 2);

  return (
<div className="flex-1 overflow-y-auto px-4 pt-3 pb-6 hide-scrollbar">
      {/* Single compact header row — counts on the left, actions on
       *  the right. Dot separators dropped; gap-spacing carries the
       *  rhythm. Only the denied count is tinted to keep the eye
       *  drawn to actionable info. */}
      <header className="flex items-center gap-4 mb-2.5 text-[10px] font-mono">
        <span className="flex items-center gap-3 min-w-0">
          <span className="text-slate-gray">
            <span className="text-soft-white tabular-nums">{traffic.length}</span>{' '}
            event{traffic.length === 1 ? '' : 's'}
          </span>
          {denyCount > 0 ? (
            <span className="text-[#f0a0a0]">
              <span className="tabular-nums">{denyCount}</span> denied
            </span>
          ) : null}
          {listenerCount > 0 ? (
            <span className="text-slate-gray/60">
              <span className="tabular-nums">{listenerCount}</span> listener
            </span>
          ) : null}
        </span>
        <span className="ml-auto flex items-center gap-3">
          <button
            type="button"
            onClick={() => setTrafficPaused(!trafficPaused)}
            title={
              trafficPaused
                ? 'Resume capturing new traffic'
                : 'Pause capture — buffer freezes, simulator keeps running'
            }
            className={[
              'inline-flex items-center gap-1 transition-colors',
              trafficPaused
                ? 'text-[#e6c79c] hover:text-soft-white'
                : 'text-slate-gray hover:text-soft-white',
            ].join(' ')}
          >
            <span className="material-symbols-outlined text-[14px]">
              {trafficPaused ? 'play_arrow' : 'pause'}
            </span>
            <span className="uppercase tracking-wider">
              {trafficPaused ? 'paused' : 'live'}
            </span>
          </button>
          <CopyButton
            value={copyAll}
            label="Copy all visible traffic"
            icon="copy_all"
            size={12}
          />
          <button
            type="button"
            onClick={clearTraffic}
            title="Clear traffic buffer"
            className="text-slate-gray/70 hover:text-soft-white transition-colors uppercase tracking-wider"
          >
            clear
          </button>
        </span>
      </header>

      {/* Filter row — origin segmented control, result segmented
       *  control, path search. Each segmented group is one tinted
       *  container so it reads as ONE widget rather than loose chips.
       *  At <sm widths the row stacks: segmented controls share line
       *  one, path search drops to line two full-width. Above sm the
       *  whole row sits inline with the path search right-aligned. */}
      <div className="mb-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <SegmentedControl
            options={[
              { value: 'user', label: 'user' },
              { value: 'all', label: 'all' },
              { value: 'listener', label: 'listener' },
            ]}
            value={originFilter}
            onChange={(v) => setOriginFilter(v as OriginFilter)}
          />
          <SegmentedControl
            options={[
              { value: 'all', label: 'all' },
              { value: 'deny', label: 'denied', tone: 'error' },
              { value: 'allow', label: 'allowed', tone: 'ok' },
            ]}
            value={resultFilter}
            onChange={(v) => setResultFilter(v as ResultFilter)}
          />
        </div>
        <div className="sm:ml-auto inline-flex items-center gap-1 bg-[#0f0f17] border border-[#2a2a35] rounded px-1.5 py-0.5 focus-within:border-[#3a3a48] transition-colors w-full sm:w-auto">
          <span className="material-symbols-outlined text-[12px] text-slate-gray/70">
            search
          </span>
          <input
            type="text"
            value={pathQuery}
            onChange={(e) => setPathQuery(e.target.value)}
            placeholder="path"
            className="bg-transparent text-[11px] font-mono text-soft-white placeholder:text-slate-gray/50 focus:outline-none flex-1 sm:flex-initial sm:w-[120px]"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="text-[11px] font-mono text-slate-gray italic px-3 py-4 text-center">
          no events match the current filters
        </p>
      ) : (
        <ul className="space-y-0.5">
          {ordered.map((e) => (
            <TrafficRow
              key={e.id}
              entry={e}
              denial={denialById.get(e.id)}
              onClick={() => setSelectedId(e.id)}
            />
          ))}
        </ul>
      )}

      <TrafficAnalyzePanel
        onSendPrompt={onSendPrompt}
        sendBusy={sendBusy}
        onAfterSend={onAfterSend}
      />
    </div>
  );
}

/**
 * Compact segmented control — one tinted container with internal
 * "pill" buttons. Reads as a single widget rather than three loose
 * chips, which lets the filter row stay scannable when several
 * dimensions live next to each other. Active option uses a subtle
 * lifted background; tone (`ok`/`error`) tints the active label
 * only, never the container, so the widget keeps a uniform footprint.
 */
function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; tone?: 'ok' | 'error' }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex items-center bg-[#0f0f17] border border-[#2a2a35] rounded p-0.5 gap-0.5">
      {options.map((opt) => {
        const active = opt.value === value;
        const activeTone =
          opt.tone === 'error'
            ? 'text-[#f0a0a0]'
            : opt.tone === 'ok'
              ? 'text-[#a4d4a8]'
              : 'text-soft-white';
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={[
              'px-2 py-[3px] rounded text-[10px] font-mono uppercase tracking-wider transition-colors',
              active
                ? `bg-[#2a2a35] ${activeTone}`
                : 'text-slate-gray/70 hover:text-soft-white',
            ].join(' ')}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function TrafficRow({
  entry,
  denial,
  onClick,
}: {
  entry: TrafficEntry;
  denial: DenialBlurb | undefined;
  onClick: () => void;
}) {
  const tone = resultTone(entry.result);
  const isListener = entry.origin === 'listener';
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={[
          'w-full flex items-center gap-2 px-2 py-1 rounded text-left',
          'text-[11px] font-mono hover:bg-[#2a2a35]/40 transition-colors',
          isListener ? 'opacity-60' : '',
        ].join(' ')}
      >
        <span className="text-slate-gray shrink-0 whitespace-nowrap tabular-nums">
          {formatTime(entry.at)}
        </span>
        <span className="material-symbols-outlined text-[12px] text-slate-gray/60 shrink-0">
          chevron_right
        </span>
        <span className="text-slate-gray uppercase shrink-0 w-[44px]">{entry.method}</span>
        <span className="text-soft-white truncate flex-1 min-w-0">{entry.path}</span>
        <span
          className={[
            'shrink-0 px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider',
            tone.text,
            tone.border,
          ].join(' ')}
        >
          {tone.label}
        </span>
        {denial ? (
          <span
            className={[
              'shrink-0 px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider',
              'text-[#e6c79c]',
              'border-[#e6c79c]/40',
            ].join(' ')}
            title={denial.message}
          >
            denied request
          </span>
        ) : null}
        <span className="shrink-0 text-slate-gray/70 w-[42px] text-right tabular-nums">
          {entryDurationMs(entry).toFixed(0)}ms
        </span>
      </button>
    </li>
  );
}

function TrafficDetail({
  entry,
  denial,
  onBack,
  onSendPrompt,
  sendBusy,
  onAfterSend,
}: {
  entry: TrafficEntry;
  denial: DenialBlurb | undefined;
  onBack: () => void;
  onSendPrompt?: (prompt: string) => void;
  sendBusy?: boolean;
  onAfterSend?: () => void;
}) {
  const tone = resultTone(entry.result);
  const fullCopy = buildEntryCopy(entry);
  const requestData = entry.request?.resourceData ?? entry.request?.data;
  const before = entry.resourceBefore;
  const after = entry.resourceAfter;
  const reasons = entry.reasons ?? [];

  return (
    <div className="flex-1 overflow-y-auto px-4 pt-3 pb-6 hide-scrollbar">
      <header className="flex items-center gap-3 mb-3">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-[12px] font-mono text-slate-gray hover:text-soft-white transition-colors"
        >
          <span className="material-symbols-outlined text-[14px]">arrow_back</span>
          Back
        </button>
        <span className="ml-auto">
          <CopyButton value={fullCopy} label="Copy traffic event" size={14} />
        </span>
      </header>

      <div className="mb-4">
        <div className="flex items-center gap-2 mb-1.5 flex-wrap">
          <span
            className={[
              'px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider font-mono',
              tone.text,
              tone.border,
            ].join(' ')}
          >
            {tone.label}
          </span>
          <span className="text-[10px] font-mono uppercase tracking-wider text-slate-gray">
            {entry.origin}
          </span>
          <span className="text-slate-gray/60 text-[10px]">·</span>
          <span className="text-[11px] font-mono text-slate-gray tabular-nums">
            {entryDurationMs(entry).toFixed(1)}ms
          </span>
          <span className="text-slate-gray/60 text-[10px]">·</span>
          <span className="text-[11px] font-mono text-slate-gray">{formatTime(entry.at)}</span>
        </div>
        <p className="text-[15px] font-mono text-soft-white break-words">
          <span className="uppercase mr-2">{entry.method}</span>
          {entry.path}
        </p>
        {'matchedRule' in entry && entry.matchedRule ? (
          <p className="text-[11px] font-mono text-slate-gray mt-1">
            matched rule #{entry.matchedRule.ruleIndex} · {entry.matchedRule.operations.join(', ')}
          </p>
        ) : null}
      </div>

      {denial ? (
        <DenialOverlay
          denial={denial}
          {...(onSendPrompt ? { onSendPrompt } : {})}
          {...(sendBusy !== undefined ? { sendBusy } : {})}
          {...(onAfterSend ? { onAfterSend } : {})}
        />
      ) : null}

      <Section label="AUTH" copy={JSON.stringify(entry.auth, null, 2)}>
        <CodeBlock code={JSON.stringify(entry.auth, null, 2)} language="JSON" />
      </Section>

      {requestData !== undefined ? (
        <Section
          label="REQUEST · resource.data"
          copy={JSON.stringify(requestData, null, 2)}
          note={entry.truncated ? 'large payload truncated for display' : undefined}
        >
          <CodeBlock code={JSON.stringify(requestData, null, 2)} language="JSON" />
        </Section>
      ) : null}

      {before !== undefined ? (
        <Section
          label="RESOURCE BEFORE"
          copy={JSON.stringify(before, null, 2)}
          note={before.exists ? undefined : 'doc does not exist'}
        >
          <CodeBlock
            code={JSON.stringify(before.exists ? before.data : null, null, 2)}
            language="JSON"
          />
        </Section>
      ) : null}

      {after !== undefined ? (
        <Section
          label="RESOURCE AFTER"
          copy={JSON.stringify(after, null, 2)}
          note={after.exists ? undefined : 'doc would not exist'}
        >
          <CodeBlock
            code={JSON.stringify(after.exists ? after.data : null, null, 2)}
            language="JSON"
          />
        </Section>
      ) : null}

      {reasons.length > 0 ? (
        <Section label="REASONS" copy={reasons.join('\n')}>
          <ul className="space-y-1 text-[11px] font-mono">
            {reasons.map((r, i) => (
              <li
                key={i}
                className={
                  r.includes('DENY') || r.includes('deny')
                    ? 'text-[#f0a0a0]'
                    : r.includes('ALLOW') || r.includes('allow')
                      ? 'text-[#a4d4a8]'
                      : 'text-slate-gray'
                }
              >
                {r}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {entry.triggeredBy ? (
        <Section
          label="TRIGGERED BY"
          copy={`${entry.triggeredBy.method} ${entry.triggeredBy.path}`}
        >
          <p className="text-[12px] font-mono text-soft-white">
            <span className="uppercase mr-2">{entry.triggeredBy.method}</span>
            {entry.triggeredBy.path}
          </p>
        </Section>
      ) : null}

      {entry.groupId ? (
        <Section label="GROUP" copy={entry.groupId}>
          <p className="text-[12px] font-mono text-slate-gray">
            {entry.origin}: <span className="text-soft-white">{entry.groupId}</span>
          </p>
        </Section>
      ) : null}
    </div>
  );
}

function DenialOverlay({
  denial,
  onSendPrompt,
  sendBusy,
  onAfterSend,
}: {
  denial: DenialBlurb;
  onSendPrompt?: (prompt: string) => void;
  sendBusy?: boolean;
  onAfterSend?: () => void;
}) {
  return (
    <div className="mb-4 grid gap-2">
      <div className="px-3 py-2 border border-[#2a2a35] rounded-md bg-[#1a1a22]/60 flex items-start gap-2">
        <span
          className={[
            'shrink-0 px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider font-mono',
            'text-[#e6c79c]',
            'border-[#e6c79c]/40',
          ].join(' ')}
        >
          denied request
        </span>
        <p className="text-[11px] font-mono text-slate-gray/80 leading-relaxed">
          {denial.message}
        </p>
      </div>
      <DenialInspectSection
        denial={denial}
        {...(onSendPrompt ? { onSendPrompt } : {})}
        {...(sendBusy !== undefined ? { sendBusy } : {})}
        {...(onAfterSend ? { onAfterSend } : {})}
      />
    </div>
  );
}

/**
 * Per-denial Inspect surface — mirror of `AnalyzeSection` in
 * `ToolDetailView`. One click runs `runExplainDenial` against the
 * user's active provider, streams text + thinking, and on completion
 * persists the result onto `denial.analysis` via `patchDenial` so
 * subsequent re-mounts (tab switches, drill-out/in) show the cached
 * explanation without a re-spend.
 *
 * Suggestions emitted by the explainer render via the shared
 * `SuggestedPromptCard`; `sent` / `dismissed` flags persist on the
 * suggestion itself so the row state survives navigation.
 */
function DenialInspectSection({
  denial,
  onSendPrompt,
  sendBusy,
  onAfterSend,
}: {
  denial: DenialBlurb;
  onSendPrompt?: (prompt: string) => void;
  sendBusy?: boolean;
  onAfterSend?: () => void;
}) {
  const cached = denial.analysis;
  const [streaming, setStreaming] = useState(false);
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState('');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const patchDenial = useRuntimeStore((s) => s.patchDenial);
  const llmProvider = PROVIDERS[useLlmStore((s) => s.providerId)];

  const run = useCallback(async () => {
    if (streaming) return;
    setError(null);
    setText('');
    setThinking('');
    setStreaming(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const out = await runExplainDenial(
        denial,
        {
          onText: (chunk) => setText((prev) => prev + chunk),
          onThinking: (chunk) => setThinking((prev) => prev + chunk),
        },
        ctrl.signal,
      );
      patchDenial(denial.id, {
        analysis: {
          text: out.text,
          thinking: out.thinking,
          telemetry: {
            providerLabel:
              PROVIDERS[out.telemetry.providerId as 'gemini' | 'openrouter' | 'ollama'].label,
            modelLabel: out.telemetry.modelLabel,
            durationMs: out.telemetry.durationMs,
            tokensIn: out.telemetry.tokensIn,
            tokensOut: out.telemetry.tokensOut,
            costUsd: out.telemetry.costUsd,
            costEstimated: out.telemetry.costEstimated,
          },
          ...(out.suggestions.length > 0 ? { suggestions: out.suggestions } : {}),
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [denial, patchDenial, streaming]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const displayText = streaming
    ? stripSuggestionDuringStream(text)
    : cached?.text ?? '';
  const displayThinking = streaming ? thinking : cached?.thinking ?? '';
  const suggestions = cached?.suggestions ?? [];

  return (
    <div className="rounded-md border border-[#2a2a35] bg-[#0f0f17] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#2a2a35]">
        <span className="text-[10px] uppercase tracking-wider text-slate-gray font-bold">
          Inspect denial
        </span>
        {cached || streaming ? (
          <button
            type="button"
            onClick={streaming ? cancel : run}
            disabled={streaming && !abortRef.current}
            className="text-[10px] uppercase tracking-wider text-slate-gray hover:text-soft-white transition-colors"
          >
            {streaming ? 'Cancel' : 'Regenerate'}
          </button>
        ) : null}
      </div>

      {!cached && !streaming ? (
        <button
          type="button"
          onClick={run}
          className={[
            'w-full flex items-center justify-center gap-2',
            'px-4 py-2.5',
            'hover:bg-[#2a2a35]/40 transition-colors',
            'text-[12px] font-mono uppercase tracking-wider text-soft-white',
          ].join(' ')}
          title={`Call ${llmProvider.label} to explain this denial in context — uses your BYOK key`}
        >
          <span className="material-symbols-outlined text-[16px]">auto_awesome</span>
          <span>Inspect Denial</span>
        </button>
      ) : null}

      {(streaming || cached) ? (
        <div className="px-3 py-3 grid gap-2.5">
          {displayThinking ? (
            <Fold
              tone="thought"
              header={
                <span>
                  <span className="text-[10px] uppercase tracking-wider text-slate-gray mr-1.5">
                    thinking
                  </span>
                  <span className="text-slate-gray/80">
                    {displayThinking.length} char
                    {displayThinking.length === 1 ? '' : 's'}
                  </span>
                </span>
              }
            >
              <div className="text-[12px] font-mono text-slate-gray leading-relaxed break-words">
                <Markdown source={displayThinking} streaming={streaming} />
              </div>
            </Fold>
          ) : null}

          <div className="text-[13px] text-soft-white leading-relaxed break-words">
            <Markdown source={displayText} streaming={streaming} />
            {streaming ? <PulsingDot /> : null}
          </div>

          {!streaming && suggestions.length > 0 ? (
            <SuggestedPromptCard
              suggestions={suggestions}
              {...(onSendPrompt ? { onSend: onSendPrompt } : {})}
              {...(sendBusy !== undefined ? { sendBusy } : {})}
              {...(onAfterSend ? { onAfterSend } : {})}
              onMarkSent={(idx) => {
                if (!cached) return;
                const next = (cached.suggestions ?? []).map((s, i) =>
                  i === idx ? { ...s, sent: true } : s,
                );
                patchDenial(denial.id, {
                  analysis: { ...cached, suggestions: next },
                });
              }}
              onDismiss={(idx) => {
                if (!cached) return;
                const next = (cached.suggestions ?? []).map((s, i) =>
                  i === idx ? { ...s, dismissed: true } : s,
                );
                patchDenial(denial.id, {
                  analysis: { ...cached, suggestions: next },
                });
              }}
            />
          ) : null}

          {error ? (
            <p className="text-[12px] text-[#f0a0a0] font-mono">{error}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Section({
  label,
  copy,
  note,
  children,
}: {
  label: string;
  copy?: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-5 pt-4 border-t border-[#2a2a35]">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-[10px] uppercase tracking-wider text-slate-gray font-bold">
            {label}
          </span>
          {note ? (
            <span className="text-[10px] font-mono text-slate-gray/60 truncate">
              · {note}
            </span>
          ) : null}
        </div>
        {copy ? <CopyButton value={copy} label={`Copy ${label}`} size={12} /> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Reused-but-renamed batched Analyze panel. Operates on `liveDenials`
 * (same as the previous DenialsTab) — clicking Analyze runs the
 * model against the full denial set, stamps `analyzedAt` on each,
 * and caches the result on the store. Identical to the previous
 * `DenialsAnalyzePanel` body; moved here so TrafficTab self-contains.
 */
function TrafficAnalyzePanel({
  onSendPrompt,
  sendBusy,
  onAfterSend,
}: {
  onSendPrompt?: (prompt: string) => void;
  sendBusy?: boolean;
  onAfterSend?: () => void;
}) {
  const denials = useRuntimeStore((s) => s.liveDenials);
  const cached = useRuntimeStore((s) => s.denialsAnalysis);
  const setDenialsAnalysis = useRuntimeStore((s) => s.setDenialsAnalysis);
  const patchDenial = useRuntimeStore((s) => s.patchDenial);
  const llmProvider = PROVIDERS[useLlmStore((s) => s.providerId)];

  const [streaming, setStreaming] = useState(false);
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState('');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const cachedIds = cached?.denialIds ?? [];
  const currentIds = denials.map((d) => d.id);
  const cachedIdSet = new Set(cachedIds);
  const stale =
    cached !== null &&
    (cachedIds.length !== currentIds.length || currentIds.some((id) => !cachedIdSet.has(id)));
  const newCount = stale ? currentIds.filter((id) => !cachedIdSet.has(id)).length : 0;

  const run = useCallback(() => {
    if (streaming || denials.length === 0) return;
    setStreaming(true);
    setError(null);
    setText('');
    setThinking('');
    const at = Date.now();
    for (const d of denials) {
      patchDenial(d.id, {
        ...(d.acknowledged ? {} : { acknowledged: true }),
        analyzedAt: at,
      });
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    void runExplainDenialsBatch(
      denials,
      {
        onText: (chunk) => setText((t) => t + chunk),
        onThinking: (chunk) => setThinking((t) => t + chunk),
      },
      ctrl.signal,
    )
      .then((out) => {
        const snap: DenialsAnalysisSnapshot = {
          text: out.text,
          thinking: out.thinking,
          telemetry: {
            providerLabel: llmProvider.label,
            modelLabel: out.telemetry.modelLabel,
            durationMs: out.telemetry.durationMs,
            tokensIn: out.telemetry.tokensIn,
            tokensOut: out.telemetry.tokensOut,
            costUsd: out.telemetry.costUsd,
            costEstimated: out.telemetry.costEstimated,
          },
          suggestions: out.suggestions,
          denialIds: denials.map((d) => d.id),
          generatedAt: Date.now(),
        };
        setDenialsAnalysis(snap);
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (abortRef.current === ctrl) abortRef.current = null;
        setStreaming(false);
      });
  }, [denials, patchDenial, setDenialsAnalysis, llmProvider.label, streaming]);

  useEffect(() => () => abortRef.current?.abort(), []);

  if (denials.length === 0) return null;

  const displayText = streaming ? stripSuggestionDuringStream(text) : cached?.text ?? '';
  const displayThinking = streaming ? thinking : cached?.thinking ?? '';
  const telemetry = cached?.telemetry;
  const suggestions = cached?.suggestions ?? [];

  return (
    <section className="mt-6 pt-5 border-t border-[#2a2a35]">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] uppercase tracking-wider text-slate-gray font-bold">
          denial analysis · {denials.length}
        </span>
        {cached && !streaming && !stale ? (
          <button
            type="button"
            onClick={run}
            className="text-[10px] font-mono uppercase tracking-wider text-slate-gray hover:text-soft-white transition-colors"
            title="Re-run with current rules + app source"
          >
            regenerate
          </button>
        ) : null}
      </div>

      {cached && !streaming && stale ? (
        <button
          type="button"
          onClick={run}
          className={[
            'w-full flex items-center justify-center gap-2 mb-3',
            'px-4 py-2.5 rounded-md',
            'bg-[#3a2a2a] hover:bg-[#4a3535] transition-colors',
            'text-[12px] font-mono uppercase tracking-wider text-[#f0a0a0]',
          ].join(' ')}
          title={`Re-analyze including ${newCount} new denial${newCount === 1 ? '' : 's'}`}
        >
          <span className="material-symbols-outlined text-[16px]">refresh</span>
          <span>
            Re-analyze · +{newCount} new denial{newCount === 1 ? '' : 's'}
          </span>
        </button>
      ) : null}

      {!cached && !streaming ? (
        <button
          type="button"
          onClick={run}
          className={[
            'w-full flex items-center justify-center gap-2',
            'px-4 py-2.5 rounded-md',
            'bg-[#2a2a35] hover:bg-[#3a3a48] transition-colors',
            'text-[12px] font-mono uppercase tracking-wider text-soft-white',
          ].join(' ')}
          title={`Call ${llmProvider.label} to explain ${denials.length} denial${denials.length === 1 ? '' : 's'} in context`}
        >
          <span className="material-symbols-outlined text-[16px]">auto_awesome</span>
          <span>
            Analyze &amp; Explain {denials.length === 1 ? '1 denial' : `${denials.length} denials`}
          </span>
        </button>
      ) : null}

      {streaming || displayText || displayThinking ? (
        <div className="space-y-3">
          {streaming || displayThinking ? (
            <Fold
              tone="thought"
              defaultOpen={streaming}
              header={
                <span className="inline-flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-slate-gray">
                    thinking
                  </span>
                  <span className="text-slate-gray/80">
                    {displayThinking.length} char{displayThinking.length === 1 ? '' : 's'}
                  </span>
                  {streaming ? <PulsingDot /> : null}
                </span>
              }
              headerAction={
                displayThinking ? (
                  <CopyButton value={displayThinking} label="Copy thinking" size={12} />
                ) : null
              }
            >
              <div className="text-[12px] font-mono text-slate-gray leading-relaxed break-words min-h-[1em]">
                <Markdown source={displayThinking.trimEnd()} streaming={streaming} />
              </div>
            </Fold>
          ) : null}

          {displayText ? (
            <div className="text-[13px] text-soft-white leading-relaxed break-words">
              <Markdown source={displayText} streaming={streaming} />
              {streaming ? <PulsingDot /> : null}
            </div>
          ) : null}

          {!streaming && suggestions.length > 0 ? (
            <SuggestedPromptCard
              suggestions={suggestions}
              onSend={onSendPrompt}
              sendBusy={sendBusy}
              onAfterSend={onAfterSend}
              onMarkSent={(idx) => {
                const snap = useRuntimeStore.getState().denialsAnalysis;
                if (!snap) return;
                const next = snap.suggestions.map((s, i) =>
                  i === idx ? { ...s, sent: true } : s,
                );
                setDenialsAnalysis({ ...snap, suggestions: next });
              }}
              onDismiss={(idx) => {
                const snap = useRuntimeStore.getState().denialsAnalysis;
                if (!snap) return;
                const next = snap.suggestions.map((s, i) =>
                  i === idx ? { ...s, dismissed: true } : s,
                );
                setDenialsAnalysis({ ...snap, suggestions: next });
              }}
            />
          ) : null}

          {telemetry && !streaming ? (
            <div className="flex items-baseline justify-between gap-3 pt-2 border-t border-[#2a2a35]/60">
              <p className="text-[10px] font-mono uppercase tracking-wider text-slate-gray/70 truncate">
                {telemetry.providerLabel} {telemetry.modelLabel} ·{' '}
                {formatDuration(telemetry.durationMs)} ·{' '}
                {(telemetry.tokensIn + telemetry.tokensOut).toLocaleString()} tok
                {telemetry.costUsd !== null
                  ? ` · ${telemetry.costEstimated ? '≈' : ''}${formatCostUsd(telemetry.costUsd)}`
                  : ''}
              </p>
              <CopyButton value={cached?.text ?? ''} label="Copy analysis" size={12} />
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? <p className="mt-3 text-[12px] font-mono text-[#f0a0a0]">{error}</p> : null}
    </section>
  );
}
