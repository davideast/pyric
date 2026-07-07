/**
 * Context tab — the merged Context + Requests surface
 * (plans/context-ui-redesign.md). Three layers, one question each:
 *
 *   1. NEXT REQUEST — what will the model see next? Transcript → sent
 *      receipt, context bar vs window, composition, next-request cost.
 *   2. SESSION LEDGER — what has this session cost? Spend, processed
 *      (cached/fresh), output, per-turn stacked bars on one scale.
 *   3. REQUESTS — what happened, exactly? Turn-grouped accordion;
 *      nothing below the turn level renders until expanded.
 *
 * Replaces ContextWindowPanel + RequestTimelinePanel and the separate
 * Requests sub-tab.
 */
import { useMemo, useState } from 'react';
import {
  formatContextPercent,
  formatContextTokens,
  formatExactTokens,
  type ContextWindowSessionRequest,
  type ContextWindowSnapshot,
} from '~/lib/agent/context-window';
import {
  COMPACTION_DEFAULT_HARD_CAP_TOKENS,
  COMPACTION_DEFAULT_RATIO,
  type CompactionMarker,
} from '~/lib/agent/context-management';
import { formatCostUsd } from '~/lib/llm/pricing';
import { useChatStore } from '~/lib/store/chat';

interface ContextTabProps {
  snapshot: ContextWindowSnapshot;
  onCompactNow: () => void;
  onOpenTool: (messageId: string, callId: string) => void;
}

const USAGE_COLORS = {
  fresh: '#8bb7ff',
  cached: '#a4d4a8',
  output: '#f0c36a',
  reasoning: '#c9a7ff',
};

/** Turn bars in the ledger: most-recent N, older turns roll up. */
const LEDGER_TURN_ROWS = 6;
/** Request rows rendered per opened turn before "show all". */
const REQUESTS_PER_TURN = 30;

export function ContextTab({ snapshot, onCompactNow, onOpenTool }: ContextTabProps) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar" data-context-tab="true">
      <div className="px-4 py-4 space-y-4 max-w-5xl">
        <NextRequestCard snapshot={snapshot} onCompactNow={onCompactNow} />
        <SessionLedgerCard snapshot={snapshot} />
        <RequestsCard snapshot={snapshot} onOpenTool={onOpenTool} />
      </div>
    </div>
  );
}

// ── shared bits ──────────────────────────────────────────────────────

function SectionHeader({
  title,
  help,
  right,
}: {
  title: string;
  help: string;
  right?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-slate-gray">
          {title}
        </span>
        <button
          type="button"
          aria-label={`What is ${title}?`}
          onClick={() => setOpen((v) => !v)}
          className={[
            'w-4 h-4 rounded-full border text-[9px] leading-none grid place-items-center transition-colors',
            open
              ? 'border-soft-white/60 text-soft-white'
              : 'border-[#2a2a35] text-slate-gray hover:text-soft-white hover:border-slate-gray',
          ].join(' ')}
        >
          ?
        </button>
        {right ? <div className="ml-auto flex items-center gap-2">{right}</div> : null}
      </div>
      {open ? (
        <p className="mt-2 border-l-2 border-[#2a2a35] pl-3 text-[12px] text-slate-gray leading-relaxed">
          {help}
        </p>
      ) : null}
    </div>
  );
}

/** Abbreviated token count whose tooltip carries the exact value. */
function Tokens({ value, className }: { value: number; className?: string }) {
  return (
    <span
      className={className}
      title={`${formatExactTokens(value)} tokens`}
    >
      {formatContextTokens(value)}
    </span>
  );
}

function StackedBar({
  segments,
  total,
  className,
  title,
}: {
  segments: Array<{ id: string; tokens: number; color: string }>;
  total: number;
  className?: string;
  title?: string;
}) {
  const denom = Math.max(1, total);
  return (
    <div
      className={['flex overflow-hidden rounded bg-[#1d1d27]', className ?? 'h-2'].join(' ')}
      title={title}
    >
      {segments
        .filter((s) => s.tokens > 0)
        .map((s) => (
          <span
            key={s.id}
            data-bar-segment={s.id}
            style={{ width: `${Math.max(0.4, (s.tokens / denom) * 100)}%`, background: s.color }}
          />
        ))}
    </div>
  );
}

// ── layer 1: next request ────────────────────────────────────────────

function NextRequestCard({
  snapshot,
  onCompactNow,
}: {
  snapshot: ContextWindowSnapshot;
  onCompactNow: () => void;
}) {
  const markers = useChatStore((s) => s.compactionMarkers);
  const lastMarker: CompactionMarker | null =
    markers.length > 0 ? markers[markers.length - 1]! : null;

  const transcriptTokens = snapshot.compactionPreview.rawTokens;
  const sentTokens = snapshot.usedTokens;
  const savedTokens = Math.max(0, transcriptTokens - sentTokens);
  const savedPct = transcriptTokens > 0 ? Math.round((savedTokens / transcriptTokens) * 100) : 0;

  const limit = snapshot.limitTokens;
  const compactThreshold = limit
    ? Math.min(Math.round(limit * COMPACTION_DEFAULT_RATIO), COMPACTION_DEFAULT_HARD_CAP_TOKENS)
    : COMPACTION_DEFAULT_HARD_CAP_TOKENS;
  const cost = snapshot.pricing.current;

  return (
    <section
      className="rounded-md border border-[#2a2a35] bg-content-bg/40 p-4"
      data-context-next-request="true"
    >
      <SectionHeader
        title="Next request"
        help="An estimate of the single request the model receives next: the transcript with any compaction summary applied and stale tool results trimmed. Compaction is an event — it runs when this crosses the threshold, or when you force it."
        right={
          <button
            type="button"
            data-context-compact-now="true"
            onClick={onCompactNow}
            className="rounded border border-[#2a2a35] px-2.5 py-1 text-[11px] font-mono text-slate-gray hover:text-soft-white hover:border-slate-gray transition-colors"
          >
            Compact now
          </button>
        }
      />

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div>
          <div className="text-[10px] font-mono uppercase tracking-wider text-slate-gray">
            Transcript
          </div>
          <Tokens
            value={transcriptTokens}
            className="text-[24px] font-semibold font-mono tabular-nums text-soft-white"
          />
        </div>
        <span className="text-slate-gray text-[15px]">→</span>
        <div>
          <div className="text-[10px] font-mono uppercase tracking-wider text-slate-gray">
            Sent to model
          </div>
          <Tokens
            value={sentTokens}
            className="text-[24px] font-semibold font-mono tabular-nums text-[#a4d4a8]"
          />
        </div>
        {savedTokens > 0 && savedPct >= 1 ? (
          <span
            className="ml-auto rounded-full border border-[#a4d4a8]/40 bg-[#a4d4a8]/10 px-3 py-0.5 text-[11px] font-mono text-[#a4d4a8]"
            title={
              lastMarker
                ? `Latest compaction (${lastMarker.source === 'model' ? 'written by the model' : 'mechanical fallback'}) plus trimmed older tool results`
                : 'Older tool results are trimmed to one-line summaries before each request'
            }
          >
            {lastMarker ? 'compacted' : 'results trimmed'} −{formatContextTokens(savedTokens)} (
            {savedPct}%)
          </span>
        ) : null}
      </div>

      <div className="mt-4">
        <StackedBar
          segments={snapshot.breakdown.map((r) => ({ id: r.id, tokens: r.tokens, color: r.color }))}
          total={Math.max(limit ?? 0, sentTokens)}
          className="h-2.5"
          title={
            limit
              ? `${formatContextTokens(sentTokens)} of ${formatContextTokens(limit)} context window`
              : `${formatContextTokens(sentTokens)} — context window size unknown`
          }
        />
        <div className="mt-2 text-[12px] text-slate-gray">
          {limit ? (
            <>
              <span className="text-soft-white">{formatContextPercent(snapshot)}</span>
              {' · '}
              <span className="font-mono tabular-nums">
                ≈{formatContextTokens(sentTokens)} / {formatContextTokens(limit)}
              </span>{' '}
              <span className="text-[11px] opacity-70">
                (exact: {formatExactTokens(sentTokens)})
              </span>
            </>
          ) : (
            <span className="font-mono tabular-nums">
              ≈{formatContextTokens(sentTokens)} · context window size unknown
            </span>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] font-mono text-slate-gray">
        {snapshot.breakdown.map((row) => (
          <span key={row.id} data-context-breakdown-row={row.id} className="inline-flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-sm" style={{ background: row.color }} />
            {row.label.toLowerCase()} <Tokens value={row.tokens} className="text-soft-white/90" />
          </span>
        ))}
      </div>

      <p className="mt-3 text-[12px] text-slate-gray leading-relaxed">
        {lastMarker ? (
          <>
            Last compacted{' '}
            <span className="text-soft-white">
              {formatContextTokens(lastMarker.beforeTokens)} →{' '}
              {formatContextTokens(lastMarker.afterTokens)}
            </span>{' '}
            ({lastMarker.source === 'model' ? 'written by the model' : 'mechanical fallback'}
            {'). '}
          </>
        ) : null}
        Compacts at ≈<Tokens value={compactThreshold} className="text-soft-white" />
        {cost ? (
          <>
            {' · '}next request costs {cost.estimated ? '≈' : ''}
            <span className="text-soft-white">{formatCostUsd(cost.costUsd)}</span> input
          </>
        ) : null}
        .
      </p>
    </section>
  );
}

// ── layer 2: session ledger ──────────────────────────────────────────

function SessionLedgerCard({ snapshot }: { snapshot: ContextWindowSnapshot }) {
  const usage = snapshot.sessionUsage;
  if (!usage) return null;
  const freshInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const requestsLabel =
    usage.requests === null ? 'unknown' : formatExactTokens(usage.requests);
  const perTurn =
    usage.requests !== null && usage.turns > 0 ? Math.round(usage.requests / usage.turns) : null;

  const rows = usage.turnRows;
  const recent = rows.slice(-LEDGER_TURN_ROWS);
  const earlier = rows.slice(0, Math.max(0, rows.length - LEDGER_TURN_ROWS));
  const earlierRollup =
    earlier.length > 0
      ? earlier.reduce(
          (acc, t) => ({
            cachedInputTokens: acc.cachedInputTokens + t.cachedInputTokens,
            freshInputTokens: acc.freshInputTokens + t.freshInputTokens,
            outputTokens: acc.outputTokens + t.outputTokens,
            tokensTotal: acc.tokensTotal + t.tokensTotal,
          }),
          { cachedInputTokens: 0, freshInputTokens: 0, outputTokens: 0, tokensTotal: 0 },
        )
      : null;
  const scale = Math.max(
    1,
    ...recent.map((t) => t.tokensTotal),
    earlierRollup?.tokensTotal ?? 0,
  );

  return (
    <section
      className="rounded-md border border-[#2a2a35] bg-content-bg/40 p-4"
      data-context-ledger="true"
    >
      <SectionHeader
        title="Session ledger"
        help="One chat turn makes many model requests (planning, tool loops, repairs). Processed counts every token the provider handled across all requests — most is usually served from cache at a fraction of fresh-input price, which is how millions of processed tokens can cost a few dollars."
      />

      <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <LedgerStat
          label="Spend"
          value={
            usage.costUsdTotal !== undefined ? (
              <span className="text-[#f0c36a]">{formatCostUsd(usage.costUsdTotal)}</span>
            ) : (
              <span className="text-slate-gray">—</span>
            )
          }
          sub={usage.costUsdTotal !== undefined ? 'provider-reported' : 'pricing unavailable'}
        />
        <LedgerStat
          label="Turns · requests"
          value={
            <>
              {usage.turns} · {requestsLabel}
            </>
          }
          sub={perTurn !== null ? `≈${perTurn} req/turn` : 'trace detail unavailable'}
        />
        <LedgerStat
          label="Processed"
          value={<Tokens value={usage.tokensTotal} />}
          sub={
            <span className="font-mono tabular-nums">
              {formatContextTokens(usage.cachedInputTokens)} cached ·{' '}
              {formatContextTokens(freshInput)} fresh
            </span>
          }
        />
        <LedgerStat
          label="Output"
          value={<Tokens value={usage.outputTokens} />}
          sub={
            <span className="font-mono tabular-nums">
              {formatContextTokens(usage.reasoningTokens)} reasoning
            </span>
          }
        />
      </div>

      {recent.length > 0 ? (
        <div className="mt-4 space-y-1.5" data-context-turn-bars="true">
          {earlierRollup ? (
            <LedgerTurnBar
              label="earlier"
              cached={earlierRollup.cachedInputTokens}
              fresh={earlierRollup.freshInputTokens}
              output={earlierRollup.outputTokens}
              total={earlierRollup.tokensTotal}
              scale={scale}
            />
          ) : null}
          {recent.map((t, i) => (
            <LedgerTurnBar
              key={t.id}
              label={`turn ${earlier.length + i + 1}`}
              cached={t.cachedInputTokens}
              fresh={t.freshInputTokens}
              output={t.outputTokens}
              total={t.tokensTotal}
              scale={scale}
            />
          ))}
          <p className="pt-1 text-[11px] text-slate-gray">
            Bars share one scale — cached input dominates recent turns because history grows.
            Hover any number for the exact count.
          </p>
        </div>
      ) : null}
    </section>
  );
}

function LedgerStat({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub: React.ReactNode;
}) {
  return (
    <div className="rounded border border-[#2a2a35] bg-[#1d1d27]/60 px-3 py-2">
      <div className="text-[10px] font-mono uppercase tracking-wider text-slate-gray">{label}</div>
      <div className="mt-0.5 text-[16px] font-semibold font-mono tabular-nums text-soft-white">
        {value}
      </div>
      <div className="text-[11px] text-slate-gray">{sub}</div>
    </div>
  );
}

function LedgerTurnBar({
  label,
  cached,
  fresh,
  output,
  total,
  scale,
}: {
  label: string;
  cached: number;
  fresh: number;
  output: number;
  total: number;
  scale: number;
}) {
  return (
    <div className="grid grid-cols-[56px_1fr_84px] items-center gap-2.5 text-[11px] font-mono text-slate-gray">
      <span>{label}</span>
      <div
        className="flex h-2 overflow-hidden rounded bg-[#1d1d27]"
        title={`${label}: ${formatExactTokens(total)} processed — ${formatContextTokens(cached)} cached, ${formatContextTokens(fresh)} fresh, ${formatContextTokens(output)} output`}
      >
        <span style={{ width: `${(cached / scale) * 100}%`, background: USAGE_COLORS.cached }} />
        <span style={{ width: `${(fresh / scale) * 100}%`, background: USAGE_COLORS.fresh }} />
        <span style={{ width: `${(output / scale) * 100}%`, background: USAGE_COLORS.output }} />
      </div>
      <span className="text-right tabular-nums text-soft-white" title={formatExactTokens(total)}>
        {formatContextTokens(total)}
      </span>
    </div>
  );
}

// ── layer 3: requests (on-demand drill) ──────────────────────────────

interface TurnGroup {
  turnId: string;
  ordinal: number;
  requests: ContextWindowSessionRequest[];
  tokensTotal: number;
  costUsd: number | null;
  prompt: string | null;
}

function RequestsCard({
  snapshot,
  onOpenTool,
}: {
  snapshot: ContextWindowSnapshot;
  onOpenTool: (messageId: string, callId: string) => void;
}) {
  const usage = snapshot.sessionUsage;
  const requests = usage?.requestRows ?? [];
  // Select the stable array reference; deriving inside the selector
  // would return a fresh array per getSnapshot and loop the render.
  const messages = useChatStore((s) => s.messages);
  const userPrompts = useMemo(
    () => messages.filter((m) => m.role === 'user').map((m) => m.text),
    [messages],
  );
  const [openTurns, setOpenTurns] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState<{ kind: 'provider' | 'model'; value: string } | null>(null);

  const filtered = filter
    ? requests.filter((r) =>
        filter.kind === 'provider' ? r.providerLabel === filter.value : r.modelLabel === filter.value,
      )
    : requests;

  const groups = useMemo(() => groupByTurn(filtered, userPrompts), [filtered, userPrompts]);
  const chips = useMemo(() => buildSummaryChips(requests), [requests]);

  if (requests.length === 0) {
    return (
      <section className="rounded-md border border-[#2a2a35] bg-content-bg/40 p-4" data-context-requests="true">
        <SectionHeader
          title="Requests"
          help="Per-request detail is built from saved trace telemetry."
        />
        <p className="mt-3 text-[12px] text-slate-gray">
          No per-request detail yet — the trace rows for this session were not saved or restored.
          High-level totals still appear in the session ledger above.
        </p>
      </section>
    );
  }

  return (
    <section
      className="rounded-md border border-[#2a2a35] bg-content-bg/40 p-4"
      data-context-requests="true"
    >
      <SectionHeader
        title="Requests"
        help="Grouped by turn. Expand a turn to list its requests; click a request for full detail (provider usage, emitted calls, kept vs trimmed results, schemas). Detail renders only when opened — hundreds of requests add no DOM until you look."
      />

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {chips.providers.map((c) => (
          <FilterChip
            key={`p:${c.label}`}
            label={c.label}
            count={c.count}
            active={filter?.kind === 'provider' && filter.value === c.label}
            onToggle={() =>
              setFilter((f) =>
                f?.kind === 'provider' && f.value === c.label
                  ? null
                  : { kind: 'provider', value: c.label },
              )
            }
          />
        ))}
        {chips.models.map((c) => (
          <FilterChip
            key={`m:${c.label}`}
            label={c.label}
            count={c.count}
            active={filter?.kind === 'model' && filter.value === c.label}
            onToggle={() =>
              setFilter((f) =>
                f?.kind === 'model' && f.value === c.label ? null : { kind: 'model', value: c.label },
              )
            }
          />
        ))}
        {chips.standardToolsetSize > 0 ? (
          <span className="rounded-full border border-[#2a2a35] px-2.5 py-0.5 text-[11px] font-mono text-slate-gray">
            standard toolset ×{chips.standardToolsetSize} · all requests
          </span>
        ) : null}
        {chips.extraSchemas.map((c) => (
          <span
            key={`x:${c.label}`}
            className="rounded-full border border-[#2a2a35] px-2.5 py-0.5 text-[11px] font-mono text-slate-gray"
          >
            +{c.label} · {c.count} request{c.count === 1 ? '' : 's'}
          </span>
        ))}
        {filter ? (
          <button
            type="button"
            onClick={() => setFilter(null)}
            className="rounded-full border border-soft-white/40 px-2.5 py-0.5 text-[11px] font-mono text-soft-white hover:border-soft-white transition-colors"
          >
            clear filter ×
          </button>
        ) : null}
      </div>

      <div className="mt-3 space-y-2">
        {groups.map((group) => (
          <TurnGroupRow
            key={group.turnId}
            group={group}
            open={openTurns.has(group.turnId)}
            onToggle={(open) =>
              setOpenTurns((prev) => {
                const next = new Set(prev);
                if (open) next.add(group.turnId);
                else next.delete(group.turnId);
                return next;
              })
            }
            standardToolset={chips.standardToolset}
            onOpenTool={onOpenTool}
          />
        ))}
      </div>
    </section>
  );
}

function FilterChip({
  label,
  count,
  active,
  onToggle,
}: {
  label: string;
  count: number;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      data-request-filter-chip={label}
      className={[
        'rounded-full border px-2.5 py-0.5 text-[11px] font-mono transition-colors',
        active
          ? 'border-soft-white/60 text-soft-white bg-soft-white/5'
          : 'border-[#2a2a35] text-slate-gray hover:text-soft-white hover:border-slate-gray',
      ].join(' ')}
    >
      {label} <span className="opacity-70">{count}</span>
    </button>
  );
}

function TurnGroupRow({
  group,
  open,
  onToggle,
  standardToolset,
  onOpenTool,
}: {
  group: TurnGroup;
  open: boolean;
  onToggle: (open: boolean) => void;
  standardToolset: ReadonlySet<string>;
  onOpenTool: (messageId: string, callId: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? group.requests : group.requests.slice(-REQUESTS_PER_TURN);
  const hidden = group.requests.length - visible.length;

  return (
    <details
      open={open}
      onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}
      className="rounded-md border border-[#2a2a35] bg-content-bg/60"
      data-turn-group={group.turnId}
    >
      <summary className="grid cursor-pointer list-none grid-cols-[auto_auto_1fr_auto] items-center gap-3 px-3.5 py-2.5 hover:bg-[#1d1d27]/60 rounded-md [&::-webkit-details-marker]:hidden">
        <span
          className={[
            'text-slate-gray text-[11px] transition-transform',
            open ? 'rotate-90' : '',
          ].join(' ')}
        >
          ▸
        </span>
        <span className="font-mono text-[12px] text-soft-white whitespace-nowrap">
          turn {group.ordinal}
        </span>
        <span className="min-w-0 truncate text-[12px] text-slate-gray">
          {group.prompt ? `“${group.prompt}”` : ''}
        </span>
        <span className="font-mono text-[11px] text-slate-gray tabular-nums whitespace-nowrap">
          {group.requests.length} req · <Tokens value={group.tokensTotal} />
          {group.costUsd !== null ? <> · {formatCostUsd(group.costUsd)}</> : null}
        </span>
      </summary>
      {open ? (
        <div className="border-t border-[#2a2a35] px-3.5 py-2 space-y-0.5">
          {hidden > 0 ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="w-full rounded px-2 py-1 text-left text-[11px] font-mono text-slate-gray hover:text-soft-white hover:bg-[#1d1d27]/60 transition-colors"
            >
              show {hidden} earlier request{hidden === 1 ? '' : 's'}…
            </button>
          ) : null}
          {visible.map((request) => (
            <RequestRow
              key={request.id}
              request={request}
              standardToolset={standardToolset}
              onOpenTool={onOpenTool}
            />
          ))}
        </div>
      ) : null}
    </details>
  );
}

function RequestRow({
  request,
  standardToolset,
  onOpenTool,
}: {
  request: ContextWindowSessionRequest;
  standardToolset: ReadonlySet<string>;
  onOpenTool: (messageId: string, callId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const inputTotal = Math.max(1, request.inputTokens);
  const extraSchemas = request.toolSchemaNames.filter((n) => !standardToolset.has(n));

  return (
    <div data-request-row={request.id}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={[
          'grid w-full grid-cols-[72px_1fr_auto] items-center gap-2.5 rounded px-2 py-1 text-left font-mono text-[11px] transition-colors',
          open ? 'bg-[#1d1d27]/80 text-soft-white' : 'text-slate-gray hover:bg-[#1d1d27]/60 hover:text-soft-white',
        ].join(' ')}
      >
        <span className="tabular-nums whitespace-nowrap">iter {request.iteration}</span>
        <div
          className="flex h-1.5 min-w-[100px] overflow-hidden rounded bg-[#1d1d27]"
          title={`fresh ${formatContextTokens(request.freshInputTokens)} · cached ${formatContextTokens(request.cachedInputTokens)}`}
        >
          <span
            style={{
              width: `${(request.cachedInputTokens / inputTotal) * 100}%`,
              background: USAGE_COLORS.cached,
            }}
          />
          <span
            style={{
              width: `${(request.freshInputTokens / inputTotal) * 100}%`,
              background: USAGE_COLORS.fresh,
            }}
          />
        </div>
        <span
          className="tabular-nums text-right whitespace-nowrap"
          title={`${formatExactTokens(request.inputTokens)} in / ${formatExactTokens(request.outputTokens)} out`}
        >
          {formatContextTokens(request.inputTokens)} → {formatContextTokens(request.outputTokens)}
        </span>
      </button>
      {open ? (
        <div className="ml-6 mt-1 mb-1.5 space-y-1.5 border-l-2 border-[#2a2a35] pl-3 text-[11px] font-mono text-slate-gray" data-request-drill={request.id}>
          <div>
            <span className="text-soft-white">
              {request.usageSource === 'provider' ? 'provider-reported' : 'estimated'}
            </span>
            {' · '}fresh {formatExactTokens(request.freshInputTokens)} · cached{' '}
            {formatExactTokens(request.cachedInputTokens)} · output{' '}
            {formatExactTokens(request.visibleOutputTokens)} · reasoning{' '}
            {formatExactTokens(request.reasoningTokens)}
            {request.costUsd !== undefined ? <> · {formatCostUsd(request.costUsd)}</> : null}
          </div>
          {request.modelLabel || request.strategy ? (
            <div>
              {request.modelLabel ?? ''}
              {request.strategy ? (
                <>
                  {request.modelLabel ? ' · ' : ''}
                  {request.strategy}
                  {request.strategySource ? ` (${request.strategySource})` : ''}
                </>
              ) : null}
            </div>
          ) : null}
          {request.emittedToolCalls.length > 0 ? (
            <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
              <span className="text-soft-white">emitted</span>
              {request.emittedToolCalls.map((call, i) => {
                const key = `${call.callId ?? call.name}-${i}`;
                return call.messageId && call.callId ? (
                  <button
                    key={key}
                    type="button"
                    onClick={() => onOpenTool(call.messageId!, call.callId!)}
                    className="underline decoration-dotted underline-offset-2 hover:text-soft-white transition-colors"
                  >
                    {call.name}
                  </button>
                ) : (
                  <span key={key}>{call.name}</span>
                );
              })}
            </div>
          ) : null}
          <div>
            <span className="text-soft-white">resent results</span>{' '}
            {request.resentToolResults.length}
            {request.resentToolResults.length > 0 ? (
              <> ({summarizeNames(request.resentToolResults.map((r) => r.name))})</>
            ) : null}
          </div>
          <div>
            <span className="text-soft-white">schemas</span> standard ×
            {request.toolSchemaNames.length - extraSchemas.length}
            {extraSchemas.length > 0 ? <> + {extraSchemas.join(', ')}</> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── grouping + aggregation helpers ───────────────────────────────────

function groupByTurn(
  requests: readonly ContextWindowSessionRequest[],
  userPrompts: readonly string[],
): TurnGroup[] {
  const byTurn = new Map<string, ContextWindowSessionRequest[]>();
  for (const r of requests) {
    const list = byTurn.get(r.turnId);
    if (list) list.push(r);
    else byTurn.set(r.turnId, [r]);
  }
  const groups: TurnGroup[] = [];
  let ordinal = 0;
  for (const [turnId, rows] of byTurn) {
    ordinal += 1;
    let costUsd: number | null = null;
    for (const r of rows) {
      if (r.costUsd !== undefined) costUsd = (costUsd ?? 0) + r.costUsd;
    }
    groups.push({
      turnId,
      ordinal,
      requests: rows,
      tokensTotal: rows.reduce((n, r) => n + r.tokensTotal, 0),
      costUsd,
      prompt: excerpt(userPrompts[ordinal - 1]),
    });
  }
  // Most recent turn first — it's what you came to inspect.
  return groups.reverse();
}

export function excerpt(text: string | undefined): string | null {
  if (!text) return null;
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (!oneLine) return null;
  return oneLine.length > 64 ? `${oneLine.slice(0, 64)}…` : oneLine;
}

function summarizeNames(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(', ');
}

function buildSummaryChips(requests: readonly ContextWindowSessionRequest[]): {
  providers: Array<{ label: string; count: number }>;
  models: Array<{ label: string; count: number }>;
  standardToolset: ReadonlySet<string>;
  standardToolsetSize: number;
  extraSchemas: Array<{ label: string; count: number }>;
} {
  const providers = new Map<string, number>();
  const models = new Map<string, number>();
  for (const r of requests) {
    if (r.providerLabel) providers.set(r.providerLabel, (providers.get(r.providerLabel) ?? 0) + 1);
    if (r.modelLabel) models.set(r.modelLabel, (models.get(r.modelLabel) ?? 0) + 1);
  }

  // Schemas present in EVERY request collapse to one "standard toolset"
  // chip; only the exceptions itemize.
  let standard: Set<string> | null = null;
  for (const r of requests) {
    const names = new Set(r.toolSchemaNames);
    if (standard === null) standard = names;
    else for (const s of [...standard]) if (!names.has(s)) standard.delete(s);
  }
  const standardToolset = standard ?? new Set<string>();
  const extraCounts = new Map<string, number>();
  for (const r of requests) {
    const extras = r.toolSchemaNames.filter((n) => !standardToolset.has(n));
    if (extras.length > 0) {
      const label = `${extras.length} skill tool${extras.length === 1 ? '' : 's'}`;
      extraCounts.set(label, (extraCounts.get(label) ?? 0) + 1);
    }
  }

  const toChips = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({ label, count }));

  return {
    providers: toChips(providers),
    models: toChips(models),
    standardToolset,
    standardToolsetSize: standardToolset.size,
    extraSchemas: toChips(extraCounts).slice(0, 4),
  };
}
