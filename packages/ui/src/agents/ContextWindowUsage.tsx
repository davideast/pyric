import type { CSSProperties, ReactNode } from 'react';
import type {
  ContextWindowSnapshot,
  SessionRequestUsage,
  SessionTokenUsage,
} from '@inbrowser/agent/usage';

type ClassSlots = {
  root?: string;
  header?: string;
  body?: string;
  row?: string;
  label?: string;
  value?: string;
  bar?: string;
  segment?: string;
  empty?: string;
};

export interface ContextWindowRingProps {
  snapshot: ContextWindowSnapshot;
  size?: number;
  className?: string;
  innerClassName?: string;
  style?: CSSProperties;
}

export interface ContextWindowMeterProps {
  snapshot: ContextWindowSnapshot;
  onOpen?: () => void;
  className?: string;
  buttonClassName?: string;
  tooltipClassName?: string;
  ringClassName?: string;
  ringInnerClassName?: string;
  formatTokens?: (tokens: number) => string;
}

export interface TokenUsageInlineProps {
  usage?: SessionTokenUsage;
  className?: string;
  labelClassName?: string;
  valueClassName?: string;
  formatTokens?: (tokens: number) => string;
}

export interface SessionSpendSummaryProps {
  usage?: SessionTokenUsage;
  currentContextTokens?: number;
  className?: string;
  slots?: ClassSlots;
  formatTokens?: (tokens: number) => string;
}

export interface RequestUsageTimelineProps {
  requests: readonly SessionRequestUsage[];
  onOpenTool?: (messageId: string, callId: string) => void;
  className?: string;
  slots?: ClassSlots;
  formatTokens?: (tokens: number) => string;
  empty?: ReactNode;
}

export interface ContextWindowPanelProps {
  snapshot: ContextWindowSnapshot;
  onCompactNow?: () => void;
  className?: string;
  slots?: ClassSlots;
  formatTokens?: (tokens: number) => string;
}

const STATUS_COLORS: Record<ContextWindowSnapshot['status'], string> = {
  unknown: '#8b8b95',
  low: '#a4d4a8',
  medium: '#f0c36a',
  high: '#f08a8a',
  critical: '#ff5c7a',
};

export function ContextWindowRing({
  snapshot,
  size = 20,
  className,
  innerClassName,
  style,
}: ContextWindowRingProps) {
  const pct = snapshot.percentFull === undefined
    ? 0.28
    : Math.max(0, Math.min(1, snapshot.percentFull));
  const degrees = Math.max(10, Math.round(pct * 360));
  const color = `var(--pyric-context-window-status-color, ${STATUS_COLORS[snapshot.status]})`;
  const track = 'var(--pyric-context-window-track-color, #3a3a45)';
  const innerSize = Math.max(8, size - Math.max(6, Math.round(size * 0.34)));
  return (
    <span
      data-pyric-ui="context-window-ring"
      data-status={snapshot.status}
      data-basis={snapshot.basis}
      className={className}
      style={{
        display: 'inline-grid',
        placeItems: 'center',
        borderRadius: '999px',
        width: size,
        height: size,
        background: `conic-gradient(${color} ${degrees}deg, ${track} ${degrees}deg)`,
        ...style,
      }}
      aria-hidden="true"
    >
      <span
        data-pyric-ui="context-window-ring-inner"
        className={innerClassName}
        style={{
          display: 'block',
          borderRadius: '999px',
          width: innerSize,
          height: innerSize,
          background: 'var(--pyric-context-window-inner-color, currentColor)',
        }}
      />
    </span>
  );
}

export function ContextWindowMeter({
  snapshot,
  onOpen,
  className,
  buttonClassName,
  tooltipClassName,
  ringClassName,
  ringInnerClassName,
  formatTokens = formatCompactTokens,
}: ContextWindowMeterProps) {
  const title = `Context window: ${formatPercent(snapshot)} · ${formatRatio(snapshot, formatTokens)}`;
  return (
    <span
      data-pyric-ui="context-window-meter"
      data-status={snapshot.status}
      data-basis={snapshot.basis}
      className={className}
    >
      <button
        type="button"
        onClick={onOpen}
        className={buttonClassName}
        aria-label="Open context window details"
        title={title}
      >
        <ContextWindowRing
          snapshot={snapshot}
          size={20}
          className={ringClassName}
          innerClassName={ringInnerClassName}
        />
      </button>
      <span
        data-pyric-ui="context-window-meter-tooltip"
        className={tooltipClassName}
      >
        <span data-pyric-ui="context-window-meter-percent">
          {formatPercent(snapshot)}
        </span>
        <span data-pyric-ui="context-window-meter-ratio">
          {formatRatio(snapshot, formatTokens)}
        </span>
      </span>
    </span>
  );
}

export function TokenUsageInline({
  usage,
  className,
  labelClassName,
  valueClassName,
  formatTokens = formatCompactTokens,
}: TokenUsageInlineProps) {
  if (!usage) return null;
  return (
    <dl data-pyric-ui="token-usage-inline" className={className}>
      <MetricTerm
        label="input"
        value={formatTokens(usage.inputTokens)}
        labelClassName={labelClassName}
        valueClassName={valueClassName}
      />
      <MetricTerm
        label="output"
        value={formatTokens(usage.outputTokens)}
        labelClassName={labelClassName}
        valueClassName={valueClassName}
      />
      {usage.cachedInputTokens > 0 ? (
        <MetricTerm
          label="cached"
          value={formatTokens(usage.cachedInputTokens)}
          labelClassName={labelClassName}
          valueClassName={valueClassName}
        />
      ) : null}
      {usage.reasoningTokens > 0 ? (
        <MetricTerm
          label="reasoning"
          value={formatTokens(usage.reasoningTokens)}
          labelClassName={labelClassName}
          valueClassName={valueClassName}
        />
      ) : null}
    </dl>
  );
}

export function SessionSpendSummary({
  usage,
  currentContextTokens,
  className,
  slots,
  formatTokens = formatCompactTokens,
}: SessionSpendSummaryProps) {
  if (!usage || usage.tokensTotal <= 0) return null;
  const contextCopies =
    usage.workMultiplier ??
    (currentContextTokens && currentContextTokens > 0
      ? usage.tokensTotal / currentContextTokens
      : undefined);
  return (
    <section
      data-pyric-ui="session-spend-summary"
      className={className ?? slots?.root}
    >
      <div data-pyric-ui="session-spend-summary-header" className={slots?.header}>
        <span data-pyric-ui="session-spend-summary-title">Overall session spend</span>
        <span data-pyric-ui="session-spend-summary-total">
          {formatTokens(usage.tokensTotal)}
        </span>
      </div>
      <dl data-pyric-ui="session-spend-summary-body" className={slots?.body}>
        <MetricTerm
          label="turns"
          value={usage.turns === null ? 'unknown' : usage.turns.toLocaleString()}
          labelClassName={slots?.label}
          valueClassName={slots?.value}
        />
        <MetricTerm
          label="requests"
          value={usage.requests === null ? 'unknown' : usage.requests.toLocaleString()}
          labelClassName={slots?.label}
          valueClassName={slots?.value}
        />
        <MetricTerm
          label="average request"
          value={usage.averageRequestTokens ? formatTokens(usage.averageRequestTokens) : 'n/a'}
          labelClassName={slots?.label}
          valueClassName={slots?.value}
        />
        <MetricTerm
          label="context multiplier"
          value={contextCopies ? `${formatMultiplier(contextCopies)}x` : 'n/a'}
          labelClassName={slots?.label}
          valueClassName={slots?.value}
        />
      </dl>
      <TokenUsageInline
        usage={usage}
        className={slots?.row}
        labelClassName={slots?.label}
        valueClassName={slots?.value}
        formatTokens={formatTokens}
      />
    </section>
  );
}

export function RequestUsageTimeline({
  requests,
  onOpenTool,
  className,
  slots,
  formatTokens = formatCompactTokens,
  empty,
}: RequestUsageTimelineProps) {
  if (requests.length === 0) {
    return (
      <div
        data-pyric-ui="request-usage-timeline-empty"
        className={slots?.empty ?? className}
      >
        {empty ?? 'No request usage rows available.'}
      </div>
    );
  }
  return (
    <ol data-pyric-ui="request-usage-timeline" className={className ?? slots?.root}>
      {requests.map((request) => (
        <li
          key={request.id}
          data-pyric-ui="request-usage-row"
          data-usage-source={request.usageSource}
          data-provider={request.providerId}
          className={slots?.row}
        >
          <div data-pyric-ui="request-usage-row-header" className={slots?.header}>
            <span data-pyric-ui="request-usage-row-title">
              Request {request.iteration + 1}
            </span>
            <span data-pyric-ui="request-usage-row-total">
              {formatTokens(request.tokensTotal)}
            </span>
          </div>
          <SegmentBar
            rows={[
              ['fresh-input', request.freshInputTokens, '#8bb7ff'],
              ['cached-input', request.cachedInputTokens, '#a4d4a8'],
              ['visible-output', request.visibleOutputTokens, '#f0c36a'],
              ['reasoning-output', request.reasoningTokens, '#c9a7ff'],
            ]}
            total={Math.max(1, request.tokensTotal)}
            barClassName={slots?.bar}
            segmentClassName={slots?.segment}
          />
          <dl data-pyric-ui="request-usage-row-metrics" className={slots?.body}>
            <MetricTerm
              label="input"
              value={formatTokens(request.inputTokens)}
              labelClassName={slots?.label}
              valueClassName={slots?.value}
            />
            <MetricTerm
              label="output"
              value={formatTokens(request.outputTokens)}
              labelClassName={slots?.label}
              valueClassName={slots?.value}
            />
            <MetricTerm
              label="messages"
              value={request.messageCount.toLocaleString()}
              labelClassName={slots?.label}
              valueClassName={slots?.value}
            />
          </dl>
          {onOpenTool && request.emittedToolCalls.length > 0 ? (
            <div data-pyric-ui="request-usage-tools">
              {request.emittedToolCalls.map((tool) => (
                <button
                  key={`${tool.messageId ?? 'unknown'}:${tool.callId ?? tool.name}`}
                  type="button"
                  data-pyric-ui="request-usage-tool"
                  disabled={!tool.messageId || !tool.callId}
                  onClick={() => {
                    if (tool.messageId && tool.callId) onOpenTool(tool.messageId, tool.callId);
                  }}
                >
                  {tool.name}
                </button>
              ))}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function ContextWindowPanel({
  snapshot,
  onCompactNow,
  className,
  slots,
  formatTokens = formatCompactTokens,
}: ContextWindowPanelProps) {
  return (
    <section
      data-pyric-ui="context-window-panel"
      data-status={snapshot.status}
      data-basis={snapshot.basis}
      className={className ?? slots?.root}
    >
      <header data-pyric-ui="context-window-panel-header" className={slots?.header}>
        <ContextWindowRing snapshot={snapshot} size={56} />
        <div>
          <div data-pyric-ui="context-window-panel-percent">
            {formatPercent(snapshot)}
          </div>
          <div data-pyric-ui="context-window-panel-ratio">
            {formatRatio(snapshot, formatTokens)}
          </div>
        </div>
      </header>
      <SegmentBar
        rows={snapshot.breakdown.map((row) => [row.id, row.tokens, row.color])}
        total={Math.max(1, snapshot.usedTokens)}
        barClassName={slots?.bar}
        segmentClassName={slots?.segment}
      />
      <dl data-pyric-ui="context-window-breakdown" className={slots?.body}>
        {snapshot.breakdown.map((row) => (
          <MetricTerm
            key={row.id}
            label={row.label}
            value={formatTokens(row.tokens)}
            labelClassName={slots?.label}
            valueClassName={slots?.value}
          />
        ))}
      </dl>
      <SessionSpendSummary
        usage={snapshot.sessionUsage}
        currentContextTokens={snapshot.usedTokens}
        slots={slots}
        formatTokens={formatTokens}
      />
      {onCompactNow ? (
        <button
          type="button"
          data-pyric-ui="context-window-compact-action"
          onClick={onCompactNow}
        >
          Compact now
        </button>
      ) : null}
    </section>
  );
}

function MetricTerm({
  label,
  value,
  labelClassName,
  valueClassName,
}: {
  label: string;
  value: string;
  labelClassName?: string;
  valueClassName?: string;
}) {
  return (
    <div data-pyric-ui="metric-term">
      <dt data-pyric-ui="metric-label" className={labelClassName}>
        {label}
      </dt>
      <dd data-pyric-ui="metric-value" className={valueClassName}>
        {value}
      </dd>
    </div>
  );
}

function SegmentBar({
  rows,
  total,
  barClassName,
  segmentClassName,
}: {
  rows: readonly (readonly [id: string, tokens: number, color: string])[];
  total: number;
  barClassName?: string;
  segmentClassName?: string;
}) {
  const visibleRows = rows.filter(([, tokens]) => tokens > 0);
  if (visibleRows.length === 0) return null;
  return (
    <div data-pyric-ui="token-segment-bar" className={barClassName}>
      {visibleRows.map(([id, tokens, color]) => (
        <span
          key={id}
          data-pyric-ui="token-segment"
          data-segment={id}
          className={segmentClassName}
          style={{
            display: 'inline-block',
            width: `${Math.max(1, (tokens / total) * 100)}%`,
            background: `var(--pyric-token-segment-${id}, ${color})`,
          }}
        />
      ))}
    </div>
  );
}

function formatRatio(
  snapshot: ContextWindowSnapshot,
  formatTokens: (tokens: number) => string,
): string {
  const used = formatTokens(snapshot.usedTokens);
  if (!snapshot.limitTokens) return `${used} tokens used`;
  return `${used} / ${formatTokens(snapshot.limitTokens)} tokens used`;
}

function formatPercent(snapshot: ContextWindowSnapshot): string {
  if (snapshot.percentFull === undefined) return 'limit unknown';
  return `${Math.round(snapshot.percentFull * 100)}% full`;
}

function formatCompactTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.max(0, Math.round(tokens)));
  if (tokens < 100_000) {
    const k = tokens / 1000;
    const value = k.toFixed(1);
    return `${value.endsWith('.0') ? value.slice(0, -2) : value}k`;
  }
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  // Millions tier — "14.59M", never "14586k".
  const m = (tokens / 1_000_000).toFixed(2);
  return `${m.endsWith('.00') ? m.slice(0, -3) : m}M`;
}

function formatMultiplier(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  if (value < 10) return value.toFixed(1);
  if (value < 100) return Math.round(value).toString();
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
