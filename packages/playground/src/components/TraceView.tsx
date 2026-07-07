/**
 * Drill-in pane that renders the full LLM-request trace for one turn.
 *
 * The activity timeline shows what the model produced; this view
 * shows what the model SAW — the exact system prompt, messages
 * array, tool decls, and model identity for every ReAct iteration
 * within the turn. One iteration per card. Card body is folds:
 * SYSTEM / MESSAGES / TOOLS / MODEL (closed by default).
 *
 * Subscribes to the turn's summary and reads the full payload via
 * `getTurnTrace(turnId)` (payloads live outside React state — see
 * store/trace.ts). Phase 1 only renders `requests`; `responses`
 * slots are stubbed for Phase 2.
 *
 * Visual language matches `ToolDetailView` — same back button, same
 * card / fold idioms — so the drill-in feels like one of a family,
 * not a one-off.
 */
import { useState } from 'react';
import { CopyButton } from './CopyButton';
import { getTurnTrace, useTraceStore } from '~/lib/store/trace';
import type {
  LlmRequestTrace,
  ModelMessage,
  ToolDeclarationView,
} from '@inbrowser/agent';

interface Props {
  turnId: string;
  onBack: () => void;
}

export function TraceView({ turnId, onBack }: Props) {
  // Subscribe to the light summary (bumps on every append) and read the
  // full payload from the module-level store — full traces stay out of
  // React state (see store/trace.ts memory architecture).
  useTraceStore((s) => s.summaries[turnId]);
  const trace = getTurnTrace(turnId);

  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar">
      <div className="px-4 py-6 grid gap-4 max-w-full">
        <div className="flex items-center justify-between mb-2">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1 text-slate-gray hover:text-soft-white transition-colors text-[12px] w-fit"
          >
            <span className="material-symbols-outlined text-[16px]">arrow_back</span>
            <span>Back</span>
          </button>
          {trace ? (
            <CopyButton
              value={JSON.stringify(
                {
                  turnId: trace.turnId,
                  hostCtx: trace.hostCtx,
                  requests: trace.requests,
                  responses: trace.responses,
                },
                null,
                2,
              )}
              label="Export full turn as JSON"
              text="Export"
              icon="download"
              size={14}
            />
          ) : null}
        </div>

        <header className="grid gap-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="material-symbols-outlined text-[18px] text-slate-gray shrink-0">
              search_insights
            </span>
            <h1 className="text-[16px] font-mono uppercase tracking-wider text-soft-white leading-none truncate">
              trace
            </h1>
            {trace ? (
              <span className="text-[10px] font-mono text-slate-gray ml-auto">
                {trace.requests.length} req
                {trace.requests.length === 1 ? '' : 's'}
              </span>
            ) : null}
          </div>
          <p className="text-[11px] font-mono text-slate-gray/80 truncate">
            <span className="opacity-60">turn</span>
            <span className="opacity-40 mx-1.5">·</span>
            {turnId}
          </p>
          {trace ? (
            <p className="text-[11px] font-mono text-slate-gray/80 truncate">
              <span className="opacity-60">model</span>
              <span className="opacity-40 mx-1.5">·</span>
              {trace.hostCtx.providerLabel}: {trace.hostCtx.modelLabel}
              {trace.hostCtx.diagnosticsEnabled ? (
                <>
                  <span className="opacity-40 mx-1.5">·</span>
                  <span className="opacity-60">diagnostics on</span>
                </>
              ) : null}
            </p>
          ) : null}
        </header>

        {!trace ? (
          <p className="text-[12px] text-slate-gray italic">
            No trace data is stored for this turn. This can happen for
            legacy sessions created before trace persistence, incomplete
            turns, or payloads where trace detail was unavailable.
          </p>
        ) : trace.requests.length === 0 ? (
          <p className="text-[12px] text-slate-gray italic">
            Trace is empty — the agent loop did not dispatch an LLM
            request yet for this turn.
          </p>
        ) : (
          trace.requests.map((req, i) => (
            <RequestCard
              key={req.requestId}
              req={req}
              prev={i > 0 ? trace.requests[i - 1] : undefined}
              totalCount={trace.requests.length}
            />
          ))
        )}
      </div>
    </div>
  );
}

function RequestCard({
  req,
  prev,
  totalCount,
}: {
  req: LlmRequestTrace;
  prev?: LlmRequestTrace;
  totalCount: number;
}) {
  const charCount =
    req.systemPrompt.length +
    req.messages.reduce(
      (acc, m) =>
        acc +
        (m.text?.length ?? 0) +
        (m.resultJson?.length ?? 0) +
        (m.toolCalls?.reduce(
          (a, tc) => a + tc.name.length + JSON.stringify(tc.args).length,
          0,
        ) ?? 0),
      0,
    ) +
    req.tools.reduce(
      (acc, t) =>
        acc +
        t.name.length +
        t.description.length +
        (() => {
          try {
            return JSON.stringify(t.parameters).length;
          } catch {
            return 0;
          }
        })(),
      0,
    );

  const sysChanged = prev ? prev.systemPrompt !== req.systemPrompt : true;
  const messageDelta = prev ? req.messages.length - prev.messages.length : 0;
  const toolsChanged = prev
    ? JSON.stringify(prev.tools) !== JSON.stringify(req.tools)
    : true;

  const fullJson = (() => {
    try {
      return JSON.stringify(req, null, 2);
    } catch {
      return '';
    }
  })();

  return (
    <article className="rounded-lg border border-[#2a2a35] bg-content-bg overflow-hidden">
      <header className="px-3 py-2 border-b border-[#2a2a35] bg-[#1a1a22]/60 flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-mono uppercase tracking-wider text-soft-white font-bold shrink-0">
          req {req.iteration + 1} / {totalCount}
        </span>
        <span className="text-[10px] font-mono text-slate-gray shrink-0">
          {fmtTime(req.ts)}
        </span>
        <span className="text-[10px] font-mono text-slate-gray shrink-0">
          {fmtChars(charCount)}
        </span>
        <CopyButton
          value={fullJson}
          label="Copy this request as JSON"
          text="Copy"
          size={12}
          className="ml-auto"
        />
      </header>

      <div className="grid gap-2 p-2">
        <Fold
          label="SYSTEM"
          meta={`${fmtChars(req.systemPrompt.length)}${
            !sysChanged ? ' · unchanged' : ''
          }`}
          copyValue={req.systemPrompt}
        >
          <pre className="text-[11px] font-mono text-soft-white/90 whitespace-pre-wrap break-words leading-relaxed bg-[#0f0f17] border border-[#2a2a35]/60 rounded px-3 py-2 max-h-[40vh] overflow-y-auto custom-scrollbar">
            {req.systemPrompt}
          </pre>
        </Fold>

        <Fold
          label="MESSAGES"
          meta={`${req.messages.length} ${
            req.messages.length === 1 ? 'entry' : 'entries'
          }${messageDelta > 0 ? ` · +${messageDelta} since prev` : ''}`}
          copyValue={JSON.stringify(req.messages, null, 2)}
        >
          <ul className="grid gap-1.5">
            {req.messages.map((m, idx) => (
              <MessageRow key={idx} message={m} />
            ))}
          </ul>
        </Fold>

        <Fold
          label="TOOLS"
          meta={`${req.tools.length} ${
            req.tools.length === 1 ? 'decl' : 'decls'
          }${prev && !toolsChanged ? ' · unchanged' : ''}`}
          copyValue={JSON.stringify(req.tools, null, 2)}
        >
          <ul className="grid gap-1.5">
            {req.tools.map((t) => (
              <ToolRow key={t.name} tool={t} />
            ))}
          </ul>
        </Fold>

        <Fold
          label="MODEL"
          meta={`${req.llm.id}${
            req.llm.supportsTools ? ' · tools' : ' · no-tools'
          }`}
          copyValue={JSON.stringify(req.llm, null, 2)}
        >
          <pre className="text-[11px] font-mono text-soft-white/90 whitespace-pre-wrap break-words leading-relaxed bg-[#0f0f17] border border-[#2a2a35]/60 rounded px-3 py-2">
            {JSON.stringify(req.llm, null, 2)}
          </pre>
        </Fold>
      </div>
    </article>
  );
}

function Fold({
  label,
  meta,
  copyValue,
  children,
  initialOpen = false,
}: {
  label: string;
  meta?: string;
  copyValue?: string;
  children: React.ReactNode;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <section className="rounded-md border border-[#2a2a35]/60 bg-[#0f0f17] overflow-hidden">
      <header
        className={[
          'flex items-center gap-2 px-2.5 py-1.5',
          open ? 'border-b border-[#2a2a35]/40' : '',
        ].join(' ')}
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-2 min-w-0 flex-1 text-left hover:text-soft-white transition-colors group"
          title={open ? 'Collapse' : 'Expand'}
        >
          <span
            className="material-symbols-outlined text-[14px] text-slate-gray shrink-0 transition-transform group-hover:text-soft-white"
            style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
            aria-hidden
          >
            chevron_right
          </span>
          <span className="text-[10px] uppercase tracking-wider font-bold text-soft-white shrink-0">
            {label}
          </span>
          {meta ? (
            <span className="text-[10px] font-mono text-slate-gray/70 truncate min-w-0">
              {meta}
            </span>
          ) : null}
        </button>
        {copyValue !== undefined ? (
          <CopyButton value={copyValue} label={`Copy ${label}`} size={12} />
        ) : null}
      </header>
      {open ? <div className="p-2">{children}</div> : null}
    </section>
  );
}

function MessageRow({ message }: { message: ModelMessage }) {
  const [open, setOpen] = useState(false);
  const role = message.role.toUpperCase();
  const roleTone =
    message.role === 'system'
      ? 'text-[#a4d4a8] border-[#a4d4a8]/40'
      : message.role === 'user'
        ? 'text-soft-white border-soft-white/40'
        : message.role === 'assistant'
          ? 'text-[#e6c79c] border-[#e6c79c]/40'
          : 'text-slate-gray border-slate-gray/40';
  const preview = (() => {
    if (message.text) return firstLine(message.text);
    if (message.resultJson) return firstLine(message.resultJson);
    if (message.toolCalls && message.toolCalls.length > 0) {
      return message.toolCalls.map((c) => c.name).join(', ');
    }
    return '';
  })();
  const charCount =
    (message.text?.length ?? 0) +
    (message.resultJson?.length ?? 0) +
    (message.toolCalls?.reduce(
      (a, tc) => a + tc.name.length + JSON.stringify(tc.args).length,
      0,
    ) ?? 0);
  const copyValue = JSON.stringify(message, null, 2);

  return (
    <li className="rounded border border-[#2a2a35]/60 bg-content-bg overflow-hidden">
      <header
        className={[
          'flex items-center gap-2 px-2.5 py-1.5',
          open ? 'border-b border-[#2a2a35]/40' : '',
        ].join(' ')}
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-2 min-w-0 flex-1 text-left hover:text-soft-white transition-colors group"
        >
          <span
            className="material-symbols-outlined text-[12px] text-slate-gray shrink-0 transition-transform"
            style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
            aria-hidden
          >
            chevron_right
          </span>
          <span
            className={[
              'px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider font-mono shrink-0',
              roleTone,
            ].join(' ')}
          >
            {role}
          </span>
          <span className="text-[10px] font-mono text-slate-gray shrink-0">
            {fmtChars(charCount)}
          </span>
          {!open && preview ? (
            <span className="text-[11px] text-slate-gray/70 truncate min-w-0">
              {preview}
            </span>
          ) : null}
        </button>
        <CopyButton value={copyValue} label="Copy message" size={12} />
      </header>
      {open ? (
        <div className="p-2 grid gap-2">
          {message.text ? (
            <pre className="text-[11px] font-mono text-soft-white/90 whitespace-pre-wrap break-words leading-relaxed bg-[#0f0f17] border border-[#2a2a35]/60 rounded px-3 py-2 max-h-[40vh] overflow-y-auto custom-scrollbar">
              {message.text}
            </pre>
          ) : null}
          {message.toolCalls && message.toolCalls.length > 0 ? (
            <div className="grid gap-1">
              <span className="text-[9px] uppercase tracking-wider font-bold text-slate-gray">
                tool calls
              </span>
              {message.toolCalls.map((tc) => (
                <pre
                  key={tc.id}
                  className="text-[11px] font-mono text-soft-white/90 whitespace-pre-wrap break-words leading-relaxed bg-[#0f0f17] border border-[#2a2a35]/60 rounded px-3 py-2"
                >
                  {tc.name}(
                  {JSON.stringify(tc.args, null, 2)})
                </pre>
              ))}
            </div>
          ) : null}
          {message.resultJson ? (
            <div className="grid gap-1">
              <span className="text-[9px] uppercase tracking-wider font-bold text-slate-gray">
                tool result ({message.name ?? 'unknown'})
              </span>
              <pre className="text-[11px] font-mono text-soft-white/90 whitespace-pre-wrap break-words leading-relaxed bg-[#0f0f17] border border-[#2a2a35]/60 rounded px-3 py-2 max-h-[40vh] overflow-y-auto custom-scrollbar">
                {message.resultJson}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function ToolRow({ tool }: { tool: ToolDeclarationView }) {
  const [open, setOpen] = useState(false);
  const paramJson = (() => {
    try {
      return JSON.stringify(tool.parameters, null, 2);
    } catch {
      return String(tool.parameters);
    }
  })();
  return (
    <li className="rounded border border-[#2a2a35]/60 bg-content-bg overflow-hidden">
      <header
        className={[
          'flex items-center gap-2 px-2.5 py-1.5',
          open ? 'border-b border-[#2a2a35]/40' : '',
        ].join(' ')}
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-2 min-w-0 flex-1 text-left hover:text-soft-white transition-colors group"
        >
          <span
            className="material-symbols-outlined text-[12px] text-slate-gray shrink-0 transition-transform"
            style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
            aria-hidden
          >
            chevron_right
          </span>
          <span className="text-[11px] font-mono text-soft-white shrink-0">
            {tool.name}
          </span>
          {!open ? (
            <span className="text-[11px] text-slate-gray/70 truncate min-w-0">
              {tool.description}
            </span>
          ) : null}
        </button>
        <CopyButton
          value={JSON.stringify(tool, null, 2)}
          label="Copy tool decl"
          size={12}
        />
      </header>
      {open ? (
        <div className="p-2 grid gap-2">
          <p className="text-[12px] text-soft-white/90 leading-relaxed whitespace-pre-wrap break-words">
            {tool.description}
          </p>
          <pre className="text-[11px] font-mono text-soft-white/90 whitespace-pre-wrap break-words leading-relaxed bg-[#0f0f17] border border-[#2a2a35]/60 rounded px-3 py-2 max-h-[40vh] overflow-y-auto custom-scrollbar">
            {paramJson}
          </pre>
        </div>
      ) : null}
    </li>
  );
}

function fmtTime(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}

function fmtChars(n: number): string {
  if (n < 1000) return `${n} chars`;
  return `${(n / 1000).toFixed(1)}k chars`;
}

function firstLine(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return '';
  const nl = trimmed.indexOf('\n');
  return nl === -1 ? trimmed.slice(0, 200) : trimmed.slice(0, Math.min(nl, 200));
}
