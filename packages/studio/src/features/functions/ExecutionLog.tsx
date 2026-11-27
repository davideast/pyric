/**
 * Live execution history panel for the Pyric Studio Functions inspector.
 *
 * Displays merged execution records from `functions.executions` and live
 * `service: 'functions'`, `op: 'execution_finished'` events on the sandbox
 * event stream, with status/trigger filtering and expandable details.
 */

import { useMemo, useState } from 'react';
import { formatDurationMs, formatJsonPreview } from './model.js';
import type { FunctionExecution, FunctionExecutionStatus } from './types.js';

export interface ExecutionLogProps {
  readonly executions: readonly FunctionExecution[];
  readonly triggerFilter: string | null;
  readonly onClearTriggerFilter?: () => void;
}

type StatusFilter = 'all' | FunctionExecutionStatus;

const STATUS_FILTERS: ReadonlyArray<{ id: StatusFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'fulfilled', label: 'Fulfilled' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'timeout', label: 'Timeout' },
];

function formatTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '--:--:--';
  return new Date(epochMs).toLocaleTimeString(undefined, { hour12: false });
}

export function ExecutionLog({
  executions,
  triggerFilter,
  onClearTriggerFilter,
}: ExecutionLogProps) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const filtered = useMemo(() => {
    return executions.filter((item) => {
      if (triggerFilter && item.trigger !== triggerFilter) return false;
      if (statusFilter !== 'all' && item.status !== statusFilter) return false;
      return true;
    });
  }, [executions, triggerFilter, statusFilter]);

  const counts = useMemo(() => {
    let fulfilled = 0;
    let rejected = 0;
    let timeout = 0;
    for (const item of executions) {
      if (triggerFilter && item.trigger !== triggerFilter) continue;
      if (item.status === 'fulfilled') fulfilled++;
      else if (item.status === 'rejected') rejected++;
      else if (item.status === 'timeout') timeout++;
    }
    return { all: fulfilled + rejected + timeout, fulfilled, rejected, timeout };
  }, [executions, triggerFilter]);

  const hasActiveFilter = statusFilter !== 'all' || triggerFilter !== null;

  return (
    <section
      className="functions__log"
      data-functions-execution-log=""
      aria-labelledby="functions-executions-heading"
    >
      <header className="functions__section-head">
        <div className="functions__section-title-group">
          <h2 id="functions-executions-heading" className="functions__section-title">
            Execution log
          </h2>
          <span className="functions__count-pill" aria-live="polite">
            {filtered.length} {filtered.length === 1 ? 'run' : 'runs'}
          </span>
          {triggerFilter ? (
            <span className="functions__active-filter" data-functions-trigger-filter={triggerFilter}>
              trigger: <code>{triggerFilter}</code>
              {onClearTriggerFilter ? (
                <button
                  type="button"
                  className="functions__clear-inline"
                  aria-label="Clear trigger filter"
                  onClick={onClearTriggerFilter}
                >
                  Clear
                </button>
              ) : null}
            </span>
          ) : null}
        </div>

        <div className="functions__status-filters" role="group" aria-label="Filter executions by status">
          {STATUS_FILTERS.map((opt) => {
            const count = counts[opt.id];
            return (
              <button
                key={opt.id}
                type="button"
                className="functions__filter-pill"
                aria-pressed={statusFilter === opt.id}
                data-functions-status-filter={opt.id}
                onClick={() => setStatusFilter(opt.id)}
              >
                {opt.label} ({count})
              </button>
            );
          })}
        </div>
      </header>

      {filtered.length === 0 ? (
        <div className="functions__empty-card" data-functions-executions-empty="">
          {hasActiveFilter ? (
            <>
              <p className="functions__empty-title">No matching executions</p>
              <p className="functions__empty-copy">
                No recorded runs match the active filter.
              </p>
              <button
                type="button"
                className="studio-button"
                onClick={() => {
                  setStatusFilter('all');
                  onClearTriggerFilter?.();
                }}
              >
                Clear filters
              </button>
            </>
          ) : (
            <>
              <p className="functions__empty-title">No executions recorded yet</p>
              <p className="functions__empty-copy">
                Fire a trigger above or invoke a local HTTP endpoint to stream live execution
                records here.
              </p>
            </>
          )}
        </div>
      ) : (
        <ol className="functions__exec-list">
          {filtered.map((item) => {
            const rowKey = `${item.id}:${item.trigger}:${item.startedAt}`;
            const expanded = expandedKey === rowKey;
            const paramEntries = Object.entries(item.cause.params);
            return (
              <li
                key={rowKey}
                className="functions__exec-item"
                data-functions-execution={item.id}
                data-functions-execution-status={item.status}
              >
                <button
                  type="button"
                  className="functions__exec-row"
                  aria-expanded={expanded}
                  onClick={() => setExpandedKey(expanded ? null : rowKey)}
                >
                  <span
                    className="functions__status-badge"
                    data-status={item.status}
                  >
                    {item.status}
                  </span>
                  <span className="functions__exec-trigger mono">{item.trigger}</span>
                  <span className="functions__exec-ref mono" title={item.cause.ref}>
                    {item.cause.ref || '(no ref)'}
                  </span>
                  <span className="functions__exec-latency mono">
                    {formatDurationMs(item.durationMs)}
                  </span>
                  <time
                    className="functions__exec-time mono"
                    dateTime={
                      item.startedAt > 0 ? new Date(item.startedAt).toISOString() : undefined
                    }
                  >
                    {formatTimestamp(item.startedAt)}
                  </time>
                </button>

                {item.status === 'rejected' && item.error && !expanded ? (
                  <p className="functions__exec-error-preview" data-functions-exec-error="">
                    {item.error}
                  </p>
                ) : null}

                {expanded ? (
                  <div className="functions__exec-detail" data-functions-exec-detail={item.id}>
                    <div className="functions__exec-detail-meta">
                      <span>Run #{item.id}</span>
                      <span>Latency: {formatDurationMs(item.durationMs)}</span>
                      {item.source ? <span>Source: {item.source}</span> : null}
                    </div>

                    {item.error ? (
                      <div className="functions__exec-detail-block">
                        <span className="functions__detail-label">Error</span>
                        <pre className="functions__code-block functions__code-block--err">
                          {item.error}
                        </pre>
                      </div>
                    ) : null}

                    {paramEntries.length > 0 ? (
                      <div className="functions__exec-detail-block">
                        <span className="functions__detail-label">Params</span>
                        <dl className="functions__params-grid">
                          {paramEntries.map(([key, val]) => (
                            <div key={key} className="functions__param-pair">
                              <dt className="mono">{key}</dt>
                              <dd className="mono">{val}</dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    ) : null}

                    {item.result !== undefined ? (
                      <div className="functions__exec-detail-block">
                        <span className="functions__detail-label">Result</span>
                        <pre className="functions__code-block">
                          {formatJsonPreview(item.result)}
                        </pre>
                      </div>
                    ) : null}

                    {item.retryConfig ? (
                      <div className="functions__exec-detail-block">
                        <span className="functions__detail-label">Retry config</span>
                        <pre className="functions__code-block">
                          {formatJsonPreview(item.retryConfig)}
                        </pre>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
