/**
 * Drill-in view for a single tool call. Tool-aware — each known tool
 * gets a layout that surfaces the *one* thing the user came here to
 * read, not a grid of stats they already saw in the timeline row.
 *
 * Shared shape across tools:
 *
 *   [Back ←]                                       [Copy ⧉]
 *   toolName ●                                          time
 *   short subtitle (status + stats summary line)
 *
 *   [PRIMARY PAYLOAD — one thing, prominent]
 *
 *   [footer note — only when relevant]
 *
 * Per tool:
 *
 *   writeRules / writeCode / writeApp  — primary is the `source`
 *     rendered as a code block in the matching language. Subtitle
 *     already says "830 chars · replaced" so the prior OUTCOME
 *     section was duplicate noise; dropped.
 *
 *   runOnce                            — primary is the run's
 *     `entries` (logs, denials, errors) — the thing the user's code
 *     actually produced. Stats live in the subtitle. Deploy state
 *     is a small footer note, unless the deploy *failed*, in which
 *     case run output never happened and the deploy errors take
 *     center stage instead.
 *
 *   unknown tools                      — generic args + result,
 *     each in its own section. (Until a tool lands here, this is
 *     dead code in practice.)
 */
import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { ToolCall } from '~/lib/store/chat';
import { useChatStore } from '~/lib/store/chat';
import type { LogEntry } from '~/lib/sandbox/runner';
import { toolDisplay } from '~/lib/tools/display';
import { behaviorForCall, estimateTokens } from '~/lib/tools/behavior';
import { buildCanonicalBundle, serializeBundle } from '~/lib/tools/canonical-bundle';
import { runExplain, stripSuggestionDuringStream } from '~/lib/llm/explain';
import { formatCostUsd } from '~/lib/llm/pricing';
import { formatDuration } from '~/lib/utils/format';
import { PROVIDERS } from '~/lib/llm/registry';
import { useLlmStore } from '~/lib/store/llm';
import { CodeBlock } from './CodeBlock';
import { CopyButton } from './CopyButton';
import { DenialWalkthrough } from './teach/DenialWalkthrough';
import { DiffView } from './teach/DiffView';
import { parseRunWorkspaceTestsResult, TestReportView } from './teach/TestReportView';
import { languageForPath } from './teach/unified-diff';
import { TurnAttribution } from './teach/TurnAttribution';
import { FieldView } from './FieldView';
import { Fold } from './Fold';
import { Markdown } from './Markdown';
import { SuggestedPromptCard } from './SuggestedPromptCard';
import { PulsingDot } from './PulsingDot';
import { TerminalView } from './TerminalView';

interface Props {
  call: ToolCall;
  /** Owning assistant message id — needed so the Explain result can
   *  be patched back onto the right tool call in the chat store. */
  messageId: string;
  time: string;
  /** Wall-clock of the user prompt that triggered the owning turn.
   *  Used to compute `+N.Ns after prompt` in the drill-in header. */
  promptCreatedAt?: number;
  onBack: () => void;
  /** Submit a prompt to the agent loop — used by the `Send to agent`
   *  button on the AnalyzeSection's suggested-prompt card. */
  onSendPrompt?: (prompt: string) => void;
  /** True while a turn is in flight — locks every Send button. */
  sendBusy?: boolean;
  /** Called after a Send click; parent typically closes the drill-in
   *  and/or switches tabs. */
  onAfterSend?: () => void;
}

function safeParse<T = unknown>(s: string | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/* ── Layout primitives ─────────────────────────────────────────── */

/**
 * Data-journalist header for the drill-in. Hierarchy is:
 *
 *   ✎ WRITE APP                                       22:41 ●
 *   Replaces the entire TSX module the preview mounts.
 *   writeApp · Replaced the App TSX source · ≈1,224 tok
 *
 * H1 is the humanized data label (16px mono uppercase — smaller
 * than the prior 20px which was overpowering the column).
 * Description (from the tool registry) provides one-line context
 * about what the tool *does* in general.
 * Stats line carries the raw `toolName` identifier (mono caps, for
 * dev/agent audit), the behavior phrasing (`Replaced…` instead of
 * a parenthesized adjective), and a token estimate of the payload.
 */
function Header({
  call,
  time,
  promptCreatedAt,
  copyValue,
  onBack,
}: {
  call: ToolCall;
  time: string;
  promptCreatedAt?: number;
  copyValue: string;
  onBack: () => void;
}) {
  const display = toolDisplay(call.name);

  // Parse args + result once for the behavior phrase and the token
  // estimate. Identical to the parse the body of the drill-in does
  // — caching here would be a micro-optimization not worth it.
  const result = (() => {
    try {
      return call.resultJson ? JSON.parse(call.resultJson) : null;
    } catch {
      return null;
    }
  })();
  const behavior = behaviorForCall({ name: call.name, args: null, result });
  // Estimate tokens off the source field when present (write tools);
  // otherwise off the args+result JSON length. Rough; flagged `≈`.
  const sourceText =
    (result as { source?: string } | null)?.source ??
    (() => {
      try {
        const args = JSON.parse(call.argsJson || '{}') as { source?: string };
        return args.source;
      } catch {
        return undefined;
      }
    })();
  const tokenEstimate = estimateTokens(sourceText) ?? estimateTokens(call.argsJson);

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-slate-gray hover:text-soft-white transition-colors text-[12px] w-fit"
        >
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          <span>Back</span>
        </button>
        <CopyButton value={copyValue} label="Copy tool call" size={16} />
      </div>

      <div className="flex items-baseline justify-between gap-4 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="material-symbols-outlined text-[18px] text-slate-gray shrink-0">
            {display.icon}
          </span>
          <h1 className="text-[16px] font-mono uppercase tracking-wider text-soft-white leading-none truncate">
            {display.humanLabel}
          </h1>
          {/* Quiet success / loud failure. A successful call doesn't
           *  need an indicator — the behavior phrase below already
           *  carries the positive signal ("Replaced the App TSX
           *  source") and the prior green dot read as still-active
           *  because it shared shape + color with the PulsingDot.
           *  Failures get a visible chip; nothing else does. */}
          {call.ok === false ? (
            <span
              className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[#f0a0a0] font-mono shrink-0"
              aria-label="Failed"
            >
              <span className="material-symbols-outlined text-[12px]">close</span>
              <span>failed</span>
            </span>
          ) : null}
        </div>
        <time className="text-[11px] font-mono text-slate-gray shrink-0 leading-none">
          {time}
        </time>
      </div>

      <p className="text-[13px] text-slate-gray leading-relaxed mb-2">
        {display.description}
      </p>

      <p className="text-[11px] font-mono text-slate-gray mb-6 truncate">
        <span className="opacity-60">{call.name}</span>
        <span className="opacity-40 mx-1.5">·</span>
        <span>{behavior}</span>
        {tokenEstimate !== null ? (
          <>
            <span className="opacity-40 mx-1.5">·</span>
            <span>≈{tokenEstimate.toLocaleString()} tok</span>
          </>
        ) : null}
        {/* Time-into-turn: how long after the user's prompt did the
         *  model emit this call? Diagnostic for pacing — calls
         *  bunched at `+0s` vs. spread across the turn read very
         *  differently. */}
        {call.emittedAt != null && promptCreatedAt != null ? (
          <>
            <span className="opacity-40 mx-1.5">·</span>
            <span>+{formatDuration(call.emittedAt - promptCreatedAt)} after prompt</span>
          </>
        ) : null}
      </p>
    </>
  );
}

/**
 * Section heading row used to title `ARGS`, `RESULT`, and any other
 * section in the drill-in. Hairline divider above, label + optional
 * meta + optional right-aligned action.
 */
function SectionHeading({
  label,
  meta,
}: {
  label: string;
  meta?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 mb-2 mt-8 pt-5 border-t border-[#2a2a35]">
      <span className="text-[10px] uppercase tracking-wider text-slate-gray font-bold">
        {label}
      </span>
      {meta ? (
        <span className="text-[10px] font-mono text-slate-gray/70">{meta}</span>
      ) : null}
    </div>
  );
}

/**
 * Sectioned content block with a label + meta chip + inline copy.
 * Same hairline divider as `SectionHeading`; this variant carries
 * the copy chip and its own body slot.
 */
function SectionWithMeta({
  label,
  meta,
  copyValue,
  children,
}: {
  label: string;
  meta?: string;
  copyValue?: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-8 pt-5 border-t border-[#2a2a35]">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="text-[10px] uppercase tracking-wider text-slate-gray font-bold">
            {label}
          </span>
          {meta ? (
            <span className="text-[10px] font-mono text-slate-gray/70 truncate">{meta}</span>
          ) : null}
        </div>
        {copyValue ? <CopyButton value={copyValue} label={`Copy ${label.toLowerCase()}`} size={12} /> : null}
      </div>
      {children}
    </section>
  );
}

function FooterNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-10 pt-4 border-t border-[#2a2a35] text-[12px] text-slate-gray leading-relaxed">
      {children}
    </div>
  );
}

/* ── Tool-specific renderers ──────────────────────────────────── */

interface WriteArgs {
  source?: string;
}
interface WriteData {
  source?: string;
  replaced?: boolean;
}

function WriteSurfaceView({
  args,
  result,
  language,
}: {
  args: WriteArgs | null;
  result: WriteData | null;
  language: string;
}) {
  const source = args?.source ?? result?.source ?? '';
  // The source code IS the primary view. Args / Result still render
  // below it (always-show contract) so the user can inspect exactly
  // what the agent emitted, even if it duplicates the source —
  // that duplication is itself useful information about what
  // travels through the tool layer.
  return <CodeBlock code={source || '(no source)'} language={language} />;
}

/* ── write_file / delete_file (file-tool era) ──────────────────── */

interface WriteFileArgs {
  path?: string;
  content?: string;
}
interface WriteFileResult {
  path?: string;
  replaced?: boolean;
}
interface DeleteFileResult {
  deleted?: boolean;
  reason?: 'PINNED' | 'NOT_FOUND';
}

/**
 * Primary payload for a `write_file` drill-in. Three states, most
 * teaching first:
 *
 *   prior known + replaced   → unified before/after diff (the change
 *                              IS the story).
 *   fresh file               → full source labeled NEW FILE — an
 *                              all-green diff would just be the source
 *                              with noisier chrome.
 *   prior unknown            → full source fallback + a quiet note
 *                              (restored sessions can't reconstruct
 *                              what the file held before).
 */
function WriteFileView({
  args,
  result,
  priorContent,
}: {
  args: WriteFileArgs | null;
  result: WriteFileResult | null;
  priorContent?: string;
}) {
  const path = args?.path ?? result?.path ?? '';
  const content = args?.content ?? '';
  const language = path ? languageForPath(path) : 'text';
  const isFreshFile = result?.replaced === false || priorContent === '';

  if (isFreshFile) {
    return (
      <>
        <p className="text-[11px] font-mono uppercase tracking-wider text-[#a4d4a8] mb-2">
          new file
        </p>
        <CodeBlock code={content || '(empty file)'} language={language} />
      </>
    );
  }

  if (priorContent !== undefined) {
    return <DiffView before={priorContent} after={content} path={path} />;
  }

  return (
    <>
      <p className="text-[12px] text-slate-gray italic mb-2">
        The previous content of this file wasn't captured (restored
        session) — showing the full new content.
      </p>
      <CodeBlock code={content || '(empty file)'} language={language} />
    </>
  );
}

/**
 * `delete_file` drill-in. When the deleted content was captured, the
 * diff view renders it as an all-removed diff — the user sees exactly
 * what disappeared. Refusals (pinned path, missing file) explain
 * themselves instead of rendering an empty pane.
 */
function DeleteFileView({
  args,
  result,
  priorContent,
}: {
  args: WriteFileArgs | null;
  result: DeleteFileResult | null;
  priorContent?: string;
}) {
  const path = args?.path ?? '';
  if (result && result.deleted === false) {
    return (
      <p className="text-[13px] text-slate-gray leading-relaxed">
        {result.reason === 'PINNED'
          ? `Refused — ${path} is pinned (rules deployment targets it), so the agent can't delete it.`
          : `Nothing to delete — ${path} doesn't exist.`}
      </p>
    );
  }
  if (priorContent !== undefined && priorContent !== '') {
    return <DiffView before={priorContent} after="" path={path} />;
  }
  return (
    <p className="text-[12px] text-slate-gray italic">
      File deleted. Its content at deletion wasn't captured
      {priorContent === '' ? ' (it was empty)' : ''}.
    </p>
  );
}

interface RunOnceData {
  deployOk?: boolean;
  deployMessages?: { severity: 'info' | 'warn' | 'error'; text: string }[];
  run?: {
    ok: boolean;
    durationMs: number;
    docsTouched: number;
    errors: number;
    entries: LogEntry[];
  };
}

// `entryTone` / `EntryRow` removed — `TerminalView` handles row
// rendering now with the unified terminal aesthetic.

function RunOnceView({ data }: { data: RunOnceData | null }) {
  if (!data) {
    return <p className="text-[12px] text-slate-gray italic">No data captured.</p>;
  }

  const deployMessages = data.deployMessages ?? [];
  const run = data.run;

  // If the deploy failed, the run never happened. Lead with the
  // deploy errors so the user sees WHY there's no output.
  if (!data.deployOk) {
    return (
      <>
        <p className="text-[13px] text-[#f0a0a0] font-medium mb-3">Deploy failed</p>
        {deployMessages.length === 0 ? (
          <p className="text-[12px] text-slate-gray italic">
            No deploy diagnostics were captured.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {deployMessages.map((m, i) => (
              <li
                key={i}
                className={[
                  'text-[12px] font-mono whitespace-pre-wrap break-words leading-relaxed',
                  m.severity === 'error'
                    ? 'text-[#f0a0a0]'
                    : m.severity === 'warn'
                      ? 'text-[#e6c79c]'
                      : 'text-slate-gray',
                ].join(' ')}
              >
                <span className="text-[10px] uppercase tracking-wider mr-2 opacity-70">
                  {m.severity}
                </span>
                {m.text}
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }

  // Happy / partial path: lead with the run's output (the actual
  // thing the user's code produced), then footer the deploy state.
  // Terminal-style renderer keeps the vocabulary consistent with the
  // OutputTab — same widget, same severity columns, pure-black bg.
  const entries = run?.entries ?? [];
  const deployWarns = deployMessages.filter((m) => m.severity !== 'info');
  const stdoutMeta = run
    ? [
        formatDuration(run.durationMs),
        `${run.docsTouched} doc${run.docsTouched === 1 ? '' : 's'}`,
        ...(run.errors > 0
          ? [`${run.errors} error${run.errors === 1 ? '' : 's'}`]
          : []),
      ].join(' · ')
    : undefined;

  return (
    <>
      <TerminalView entries={entries} title="sandbox stdout" meta={stdoutMeta} />

      <FooterNote>
        {deployWarns.length === 0
          ? 'Deploy: rules accepted, no warnings.'
          : `Deploy: ${deployWarns.length} warning${deployWarns.length === 1 ? '' : 's'}.`}
        {deployWarns.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {deployWarns.map((m, i) => (
              <li
                key={i}
                className={[
                  'text-[11px] font-mono whitespace-pre-wrap break-words',
                  m.severity === 'error' ? 'text-[#f0a0a0]' : 'text-[#e6c79c]',
                ].join(' ')}
              >
                <span className="uppercase mr-2 opacity-70">{m.severity}</span>
                {m.text}
              </li>
            ))}
          </ul>
        ) : null}
      </FooterNote>
    </>
  );
}

/**
 * Unknown tools — no specialized primary view. The always-shown
 * Args + Result sections below handle the data, so the primary
 * area sits empty (returns null) and the drill-in reads
 * header → ARGS → RESULT.
 */
function GenericView() {
  return null;
}

/* ── Entry point ───────────────────────────────────────────────── */

/* ── Analyze & Explain ─────────────────────────────────────────── */

function AnalyzeSection({
  call,
  messageId,
  onSendPrompt,
  sendBusy,
  onAfterSend,
}: {
  call: ToolCall;
  messageId: string;
  onSendPrompt?: (prompt: string) => void;
  sendBusy?: boolean;
  onAfterSend?: () => void;
}) {
  // Persisted explanation (cached on the call after first run) — if
  // present, render it directly. The user can click "Regenerate" to
  // start a fresh stream.
  const cached = call.analysis;
  const [streaming, setStreaming] = useState(false);
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState('');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const patchToolCall = useChatStore((s) => s.patchToolCall);
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
      const out = await runExplain(
        call,
        {
          onText: (chunk) => setText((prev) => prev + chunk),
          onThinking: (chunk) => setThinking((prev) => prev + chunk),
        },
        ctrl.signal,
      );
      patchToolCall(messageId, call.id, {
        analysis: {
          text: out.text,
          thinking: out.thinking || undefined,
          providerLabel: PROVIDERS[out.telemetry.providerId as 'gemini' | 'openrouter' | 'ollama'].label,
          modelLabel: out.telemetry.modelLabel,
          durationMs: out.telemetry.durationMs,
          tokensIn: out.telemetry.tokensIn,
          tokensOut: out.telemetry.tokensOut,
          costUsd: out.telemetry.costUsd,
          costEstimated: out.telemetry.costEstimated,
          generatedAt: Date.now(),
          ...(out.suggestions.length > 0 ? { suggestions: out.suggestions } : {}),
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [call, messageId, patchToolCall, streaming]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  // What to show: cached > live-streaming > empty + button. During
  // streaming we hide the trailing `pyric-suggestion` fence so the
  // user doesn't watch the JSON spec appear at the end.
  const displayText = streaming
    ? stripSuggestionDuringStream(text)
    : cached?.text ?? '';
  const displayThinking = streaming ? thinking : cached?.thinking ?? '';
  const telemetry = cached;
  const suggestions = cached?.suggestions ?? [];

  return (
    <>
      <div className="mt-8 pt-5 border-t border-[#2a2a35]">
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <span className="text-[10px] uppercase tracking-wider text-slate-gray font-bold">
            Analysis
          </span>
          <div className="flex items-center gap-2">
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
        </div>

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
            title={`Call ${llmProvider.label} to analyze this tool call in context — uses your BYOK key`}
          >
            <span className="material-symbols-outlined text-[16px]">auto_awesome</span>
            <span>Analyze &amp; Explain</span>
          </button>
        ) : null}

        {/* Render the streaming surface immediately when the user
         *  hits the button, even before the first thinking/text chunk
         *  arrives. The pulsing dot in the THINKING fold is the
         *  traditional "thoughts loading" cue — without this gate the
         *  button disappeared and 1-5s of dead time passed before the
         *  Fold materialized. */}
        {streaming || displayText || displayThinking ? (
          <div className="space-y-3">
            {/* THINKING fold renders whenever we're streaming OR have
             *  captured thinking content, so the loading state is
             *  visible from t=0. `0 chars · ●` reads as "starting"
             *  rather than "broken." */}
            {streaming || displayThinking ? (
              <Fold
                tone="thought"
                defaultOpen={streaming}
                header={
                  // `inline-flex` + `gap-2` keeps the label, char-count
                  // chip, and live-streaming dot evenly spaced.
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
                {/* Same surface whether content has arrived or not — the
                 *  streaming UI is consistent from t=0. PulsingDot in
                 *  the header carries the loading cue. Thinking renders
                 *  through `<Markdown>` so model-authored lists / code
                 *  samples in reasoning come out structured, not as
                 *  literal `* item` lines. */}
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
                  // Persist `sent: true` on the cached analysis so the
                  // state survives drill-in close + reopen.
                  if (!cached) return;
                  const next = (cached.suggestions ?? []).map((s, i) =>
                    i === idx ? { ...s, sent: true } : s,
                  );
                  patchToolCall(messageId, call.id, {
                    analysis: { ...cached, suggestions: next },
                  });
                }}
                onDismiss={(idx) => {
                  if (!cached) return;
                  const next = (cached.suggestions ?? []).map((s, i) =>
                    i === idx ? { ...s, dismissed: true } : s,
                  );
                  patchToolCall(messageId, call.id, {
                    analysis: { ...cached, suggestions: next },
                  });
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
                <CopyButton value={telemetry.text} label="Copy analysis" size={12} />
              </div>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p className="mt-3 text-[12px] font-mono text-[#f0a0a0]">{error}</p>
        ) : null}
      </div>
    </>
  );
}

export function ToolDetailView({
  call,
  messageId,
  time,
  promptCreatedAt,
  onBack,
  onSendPrompt,
  sendBusy,
  onAfterSend,
}: Props) {
  const args = safeParse(call.argsJson);
  const result = safeParse(call.resultJson);

  // `run_workspace_tests` gets the teach renderer only when the
  // result parses into a plausible report (or the tool's `{reason}`
  // refusal). Empty / unparseable results fall through to the
  // generic Args + Result panel.
  const testReport =
    call.name === 'run_workspace_tests' ? parseRunWorkspaceTestsResult(call.resultJson) : null;

  // Pull the owning message so the canonical bundle can carry
  // turn-level provenance (model id, sequence index, time_into_turn).
  // Same data shape an MCP `tools/get_call_context` handler would
  // emit — see `lib/tools/canonical-bundle.ts`.
  const owningMessage = useChatStore((s) => s.messages.find((m) => m.id === messageId));
  const copyValue = owningMessage
    ? serializeBundle(buildCanonicalBundle(call, owningMessage))
    : JSON.stringify(
        { name: call.name, summary: call.summary, ok: call.ok, args, result },
        null,
        2,
      );

  return (
    <div className="flex-1 px-4 pt-4 pb-6 overflow-y-auto custom-scrollbar">
      <Header
        call={call}
        time={time}
        promptCreatedAt={promptCreatedAt}
        copyValue={copyValue}
        onBack={onBack}
      />

      {/* Reasoning that led to THIS call — snapshot of the message's
       *  thinking buffer captured at the moment the model emitted
       *  the call. Same `<Fold>` vocabulary the assistant block uses
       *  for whole-turn thinking; one source of truth, consistent UI.
       *
       *  When Gemini's `thoughtSignature` is attached, the fold's
       *  header chip reads "signed" — the reasoning span is
       *  reproducible (the same signature can be replayed). Useful
       *  for power-users debugging non-determinism. */}
      {call.thinkingUpToHere && call.thinkingUpToHere.length > 0 ? (
        <div className="mb-6">
          <Fold
            tone="thought"
            header={
              <span>
                <span className="text-[10px] uppercase tracking-wider text-slate-gray mr-1.5">
                  reasoning that led here
                </span>
                <span className="text-slate-gray/80">
                  {call.thinkingUpToHere.length} char{call.thinkingUpToHere.length === 1 ? '' : 's'}
                </span>
                {call.signature ? (
                  <span
                    className="ml-2 text-[9px] uppercase tracking-wider text-[#a4d4a8]/80"
                    title="Reproducible — provider signature attached"
                  >
                    signed
                  </span>
                ) : null}
              </span>
            }
            headerAction={
              <CopyButton value={call.thinkingUpToHere} label="Copy reasoning" size={12} />
            }
          >
            <div className="text-[12px] font-mono text-slate-gray leading-relaxed break-words">
              <Markdown source={call.thinkingUpToHere.trimEnd()} />
            </div>
          </Fold>
        </div>
      ) : null}

      {call.name === 'write_file' ? (
        <WriteFileView
          args={args as WriteFileArgs | null}
          result={result as WriteFileResult | null}
          {...(call.priorContent !== undefined ? { priorContent: call.priorContent } : {})}
        />
      ) : call.name === 'delete_file' ? (
        <DeleteFileView
          args={args as WriteFileArgs | null}
          result={result as DeleteFileResult | null}
          {...(call.priorContent !== undefined ? { priorContent: call.priorContent } : {})}
        />
      ) : testReport ? (
        <TestReportView
          parsed={testReport}
          onSendPrompt={onSendPrompt}
          sendBusy={sendBusy}
          onAfterSend={onAfterSend}
        />
      ) : call.name === 'inspect_denial' ? (
        <DenialWalkthrough
          call={call}
          messageId={messageId}
          onSendPrompt={onSendPrompt}
          sendBusy={sendBusy}
          onAfterSend={onAfterSend}
        />
      ) : call.name === 'writeRules' ? (
        <WriteSurfaceView
          args={args as WriteArgs | null}
          result={result as WriteData | null}
          language="firestore rules"
        />
      ) : call.name === 'writeCode' ? (
        <WriteSurfaceView
          args={args as WriteArgs | null}
          result={result as WriteData | null}
          language="javascript"
        />
      ) : call.name === 'writeApp' ? (
        <WriteSurfaceView
          args={args as WriteArgs | null}
          result={result as WriteData | null}
          language="tsx"
        />
      ) : call.name === 'runOnce' ? (
        <RunOnceView data={result as RunOnceData | null} />
      ) : (
        <GenericView />
      )}

      {/* Always-shown raw I/O sections — what the agent emitted and
       *  what the tool returned. Smart field rendering: multi-line
       *  strings (like a TSX source) unfold as pre blocks instead
       *  of JSON-escaped one-liners; scalars stay inline; nested
       *  objects recurse indented. Copy button still emits canonical
       *  JSON so the wire format is preserved for paste-elsewhere. */}
      <SectionWithMeta
        label="Args"
        meta={
          (() => {
            const t = estimateTokens(call.argsJson);
            return t !== null ? `≈${t.toLocaleString()} tok` : `${call.argsJson.length} chars`;
          })()
        }
        copyValue={call.argsJson}
      >
        <FieldView data={args ?? {}} />
      </SectionWithMeta>

      <SectionWithMeta
        label="Result"
        meta={
          call.resultJson
            ? (() => {
                const t = estimateTokens(call.resultJson);
                return t !== null ? `≈${t.toLocaleString()} tok` : `${call.resultJson.length} chars`;
              })()
            : 'pending'
        }
        copyValue={call.resultJson}
      >
        {call.resultJson ? (
          <FieldView data={result ?? {}} />
        ) : (
          <p className="text-[12px] text-slate-gray italic">
            Awaiting result — the tool hasn't returned yet.
          </p>
        )}
      </SectionWithMeta>

      {owningMessage ? (
        <TurnAttribution message={owningMessage} currentCallId={call.id} />
      ) : null}

      <AnalyzeSection
        call={call}
        messageId={messageId}
        onSendPrompt={onSendPrompt}
        sendBusy={sendBusy}
        onAfterSend={onAfterSend}
      />
    </div>
  );
}
