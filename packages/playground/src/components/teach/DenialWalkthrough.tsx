/**
 * Guided walkthrough for an `inspect_denial` drill-in — the
 * teach-to-fish surface for permission denials. Two numbered
 * panels:
 *
 *   1 · WHY THIS REQUEST FAILED — auth + request facts.
 *   2 · THE FIX PATTERN         — explain.ts's denial prompt, on
 *                                 click (BYOK), cached on the call;
 *                                 plus a deterministic, well-shaped
 *                                 "Send to agent" fix prompt.
 *
 * Panel 1 is fully deterministic from the tool result. Only
 * panel 2 costs tokens, and only when the user asks.
 */
import { useCallback, useRef, useState } from 'react';
import type { ToolCall } from '~/lib/store/chat';
import { useChatStore } from '~/lib/store/chat';
import { useRuntimeStore } from '~/lib/store/runtime';
import { useLlmStore } from '~/lib/store/llm';
import { PROVIDERS } from '~/lib/llm/registry';
import { runExplainDenial, stripSuggestionDuringStream } from '~/lib/llm/explain';
import { formatCostUsd } from '~/lib/llm/pricing';
import { formatDuration } from '~/lib/utils/format';
import { CopyButton } from '../CopyButton';
import { Markdown } from '../Markdown';
import { PulsingDot } from '../PulsingDot';
import {
  buildFixPrompt,
  buildWhyRows,
  parseInspectDenialResult,
  toDenialBlurb,
  type InspectDenialData,
} from './denial-walkthrough';

interface Props {
  call: ToolCall;
  messageId: string;
  onSendPrompt?: (prompt: string) => void;
  sendBusy?: boolean;
  onAfterSend?: () => void;
}

function StepHeading({ n, label }: { n: number; label: string }) {
  return (
    <div className="flex items-baseline gap-2 mb-2">
      <span className="text-[11px] font-mono text-slate-gray/70 tabular-nums">{n} ·</span>
      <span className="text-[10px] uppercase tracking-wider text-slate-gray font-bold">
        {label}
      </span>
    </div>
  );
}

function FailureNote({ data }: { data: InspectDenialData }) {
  if (data.reason === 'no_denials') {
    return (
      <p className="text-[13px] text-slate-gray leading-relaxed">
        No denials in the runtime store — there was nothing to walk
        through. Trigger the denied operation in the preview first.
      </p>
    );
  }
  return (
    <div className="text-[13px] text-slate-gray leading-relaxed">
      <p>No denial matched the requested path.</p>
      {data.knownPaths && data.knownPaths.length > 0 ? (
        <p className="mt-2 text-[12px] font-mono">
          Paths with denials: {data.knownPaths.join(', ')}
        </p>
      ) : null}
    </div>
  );
}

export function DenialWalkthrough({
  call,
  messageId,
  onSendPrompt,
  sendBusy,
  onAfterSend,
}: Props) {
  const patchToolCall = useChatStore((s) => s.patchToolCall);
  const liveDenials = useRuntimeStore((s) => s.liveDenials);
  const llmProvider = PROVIDERS[useLlmStore((s) => s.providerId)];

  const cached = call.denialFix;
  const [streaming, setStreaming] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const data = parseInspectDenialResult(call.resultJson);

  const runFix = useCallback(async () => {
    if (streaming || !data) return;
    setError(null);
    setText('');
    setStreaming(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const blurb = toDenialBlurb(data, liveDenials);
      const out = await runExplainDenial(
        blurb,
        { onText: (chunk) => setText((prev) => prev + chunk) },
        ctrl.signal,
      );
      patchToolCall(messageId, call.id, {
        denialFix: {
          text: out.text,
          ...(out.thinking ? { thinking: out.thinking } : {}),
          providerLabel:
            PROVIDERS[out.telemetry.providerId as 'gemini' | 'openrouter' | 'ollama'].label,
          modelLabel: out.telemetry.modelLabel,
          durationMs: out.telemetry.durationMs,
          tokensIn: out.telemetry.tokensIn,
          tokensOut: out.telemetry.tokensOut,
          costUsd: out.telemetry.costUsd,
          costEstimated: out.telemetry.costEstimated,
          generatedAt: Date.now(),
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [streaming, data, liveDenials, patchToolCall, messageId, call.id]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  if (call.resultJson === undefined) {
    return (
      <p className="text-[12px] text-slate-gray italic">
        Awaiting result — the denial inspection hasn't returned yet.
      </p>
    );
  }
  if (!data) return null;
  if (data.reason) return <FailureNote data={data} />;

  const denial = data.denial ?? {};
  const whyRows = buildWhyRows(denial);
  const fixPrompt = buildFixPrompt(data);
  const displayText = streaming ? stripSuggestionDuringStream(text) : cached?.text ?? '';

  return (
    <div data-teach="denial-walkthrough" className="flex flex-col gap-6">
      {/* 1 · why this request failed */}
      <section>
        <StepHeading n={1} label="Why this request failed" />
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          {whyRows.map((r) => (
            <div key={r.label} className="contents">
              <dt className="text-[10px] uppercase tracking-wider text-slate-gray/70 pt-0.5">
                {r.label}
              </dt>
              <dd
                className="text-[12px] font-mono break-words leading-relaxed text-soft-white/90"
              >
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {/* 2 · the fix pattern */}
      <section>
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <StepHeading n={2} label="The fix pattern" />
          {cached || streaming ? (
            <button
              type="button"
              onClick={streaming ? cancel : runFix}
              className="text-[10px] uppercase tracking-wider text-slate-gray hover:text-soft-white transition-colors"
            >
              {streaming ? 'Cancel' : 'Regenerate'}
            </button>
          ) : null}
        </div>

        {!cached && !streaming ? (
          <button
            type="button"
            onClick={runFix}
            className={[
              'w-full flex items-center justify-center gap-2',
              'px-4 py-2.5 rounded-md',
              'bg-[#2a2a35] hover:bg-[#3a3a48] transition-colors',
              'text-[12px] font-mono uppercase tracking-wider text-soft-white',
            ].join(' ')}
            title={`Ask ${llmProvider.label} to walk through the likely fix — uses your BYOK key`}
          >
            <span className="material-symbols-outlined text-[16px]">auto_awesome</span>
            <span>Explain the fix</span>
          </button>
        ) : null}

        {streaming || displayText ? (
          <div className="text-[13px] text-soft-white leading-relaxed break-words min-h-[1em]">
            <Markdown source={displayText} streaming={streaming} />
            {streaming ? <PulsingDot /> : null}
          </div>
        ) : null}

        {cached && !streaming ? (
          <p className="mt-2 text-[10px] font-mono uppercase tracking-wider text-slate-gray/70">
            {cached.providerLabel} {cached.modelLabel} · {formatDuration(cached.durationMs)} ·{' '}
            {(cached.tokensIn + cached.tokensOut).toLocaleString()} tok
            {cached.costUsd !== null
              ? ` · ${cached.costEstimated ? '≈' : ''}${formatCostUsd(cached.costUsd)}`
              : ''}
          </p>
        ) : null}

        {error ? <p className="mt-3 text-[12px] font-mono text-[#f0a0a0]">{error}</p> : null}

        {/* Deterministic hand-off — no model call needed to act. */}
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            disabled={!onSendPrompt || !!sendBusy}
            onClick={() => {
              onSendPrompt?.(fixPrompt);
              onAfterSend?.();
            }}
            className={[
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md',
              'bg-[#2a2a35] hover:bg-[#3a3a48] transition-colors',
              'text-[11px] font-mono uppercase tracking-wider text-soft-white',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            ].join(' ')}
            title="Submit a well-shaped fix prompt (denial facts) to the agent"
          >
            <span className="material-symbols-outlined text-[14px]">send</span>
            <span>Send to agent</span>
          </button>
          <CopyButton value={fixPrompt} label="Copy fix prompt" size={14} />
        </div>
      </section>
    </div>
  );
}
