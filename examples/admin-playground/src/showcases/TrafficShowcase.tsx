import { useMemo, useState } from 'react';
import { SegmentedControl, Badge } from '@pyric/ui/primitives';
import {
  useTrafficMonitor,
  useTrafficFilter,
  useRuleHeatmap,
  useTrafficStats,
  useTrafficGroups,
  TrafficLog,
  TrafficDetail,
  RuleHeatmap,
  TrafficStats,
  type TrafficEvent,
  type TrafficOriginFilter,
  type TrafficResultFilter,
} from '@pyric/ui/traffic';
import { makeReplaySource } from './traffic-fixtures';

// Stable across renders — useTrafficMonitor re-subscribes on identity
// change, so the source must not be re-created each render.
const REPLAY_SOURCE = makeReplaySource(650);

/**
 * Demo classification slot — the library doesn't own denial
 * classification (that's app-source analysis), so the consumer
 * supplies it via the renderClassification render-prop. Here it's a
 * trivial stand-in: every deny gets an "ambiguous" badge.
 */
function renderClassification(event: TrafficEvent) {
  if (event.result !== 'deny') return null;
  return <Badge kind="ambiguous">ambiguous</Badge>;
}

export function TrafficShowcase() {
  const monitor = useTrafficMonitor({ source: REPLAY_SOURCE, bufferSize: 500 });
  const [selectedRule, setSelectedRule] = useState<number | null>(null);
  const [grouped, setGrouped] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Cross-view interaction: a rule pick narrows the log to that rule
  // before the origin/result/path filter runs.
  const ruleScoped = useMemo(
    () =>
      selectedRule == null
        ? monitor.events
        : monitor.events.filter(
            (e) => e.matchedRule?.ruleIndex === selectedRule,
          ),
    [monitor.events, selectedRule],
  );

  const { filtered, filter, setOrigin, setResult, setPathQuery } =
    useTrafficFilter({ events: ruleScoped });

  // Newest-first for display.
  const ordered = useMemo(() => [...filtered].reverse(), [filtered]);
  const { items } = useTrafficGroups({ events: ordered });
  const { entries } = useRuleHeatmap({ events: monitor.events });
  const stats = useTrafficStats({ events: filtered });

  const selectedEvent = selectedId
    ? monitor.events.find((e) => e.id === selectedId)
    : undefined;

  return (
    <div className="space-y-4">
      <div className="text-[12px] text-muted-gray">
        Live buffer fed by a replayed <code className="font-mono text-soft-gray">TrafficSource</code>.
        In a real app this is <code className="font-mono text-soft-gray">sandbox.onRequest</code>.
      </div>

      {/* Header — counts + transport controls */}
      <div className="flex items-center gap-3 text-[12px] font-mono">
        <span className="text-soft-white">{monitor.counts.total} events</span>
        <span className="text-danger">{monitor.counts.denied} denied</span>
        <span className="text-muted-gray">{monitor.counts.listener} listener</span>
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={monitor.isPaused ? monitor.resume : monitor.pause}
            className="px-2 py-1 rounded border border-border-soft text-soft-gray hover:text-soft-white hover:border-primary transition-colors"
          >
            {monitor.isPaused ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            onClick={monitor.clear}
            className="px-2 py-1 rounded border border-border-soft text-soft-gray hover:text-soft-white hover:border-primary transition-colors"
          >
            Clear
          </button>
        </span>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <SegmentedControl<TrafficOriginFilter>
          ariaLabel="Origin filter"
          options={[
            { value: 'user', label: 'user' },
            { value: 'all', label: 'all' },
            { value: 'listener', label: 'listener' },
          ]}
          value={filter.origin}
          onChange={setOrigin}
        />
        <SegmentedControl<TrafficResultFilter>
          ariaLabel="Result filter"
          options={[
            { value: 'all', label: 'all' },
            { value: 'deny', label: 'denied', tone: 'error' },
            { value: 'allow', label: 'allowed', tone: 'ok' },
          ]}
          value={filter.result}
          onChange={setResult}
        />
        <input
          type="text"
          value={filter.pathQuery}
          onChange={(e) => setPathQuery(e.target.value)}
          placeholder="path"
          className="bg-canvas-bg border border-border-soft rounded px-2 py-1 text-[12px] font-mono text-soft-white placeholder:text-muted-gray focus:border-primary focus:outline-none"
        />
        <label className="flex items-center gap-1.5 text-[11px] font-mono text-muted-gray ml-auto">
          <input
            type="checkbox"
            checked={grouped}
            onChange={(e) => setGrouped(e.target.checked)}
            className="accent-primary"
          />
          group batches + listener runs
        </label>
      </div>

      {selectedRule != null ? (
        <div className="text-[11px] font-mono text-muted-gray flex items-center gap-2">
          scoped to rule #{selectedRule}
          <button
            type="button"
            onClick={() => setSelectedRule(null)}
            className="text-soft-gray hover:text-soft-white underline"
          >
            clear
          </button>
        </div>
      ) : null}

      {/* Body — log on the left, detail or analytics on the right */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        <TrafficLog
          className="rounded-lg border border-border-soft bg-panel-bg overflow-hidden"
          events={grouped ? [] : ordered}
          items={grouped ? items : undefined}
          selectedId={selectedId ?? undefined}
          onSelect={(e) => setSelectedId(e.id)}
          renderClassification={renderClassification}
          emptyState={
            <div className="px-3 py-4 text-[12px] text-muted-gray italic">
              no events match the current filters
            </div>
          }
        />

        <div className="space-y-4">
          {selectedEvent ? (
            <TrafficDetail
              className="rounded-lg border border-border-soft bg-panel-bg"
              event={selectedEvent}
              onBack={() => setSelectedId(null)}
              renderClassification={(e) =>
                e.result === 'deny' ? (
                  <div className="rounded border border-danger/30 bg-danger-soft px-3 py-2 text-[11px] font-mono text-danger">
                    consumer classification overlay goes here
                  </div>
                ) : null
              }
            />
          ) : (
            <>
              <div>
                <h3 className="text-[11px] uppercase tracking-wider text-muted-gray mb-1.5">
                  Rule heatmap
                </h3>
                <RuleHeatmap
                  className="rounded-lg border border-border-soft bg-panel-bg overflow-hidden"
                  entries={entries}
                  selectedRuleIndex={selectedRule ?? undefined}
                  onSelectRule={(i) =>
                    setSelectedRule((cur) => (cur === i ? null : i))
                  }
                  emptyState={
                    <div className="px-3 py-3 text-[12px] text-muted-gray italic">
                      no matched rules yet
                    </div>
                  }
                />
              </div>
              <div>
                <h3 className="text-[11px] uppercase tracking-wider text-muted-gray mb-1.5">
                  Stats
                </h3>
                <TrafficStats
                  className="rounded-lg border border-border-soft bg-panel-bg p-3"
                  stats={stats}
                />
              </div>
            </>
          )}
        </div>
      </div>

      <pre className="bg-panel-bg border border-border-soft rounded p-3 text-[12px] font-mono text-soft-gray overflow-x-auto">{`const monitor = useTrafficMonitor({ source: sandbox.onRequest });
const { filtered, filter, setOrigin } = useTrafficFilter({ events: monitor.events });
const { entries } = useRuleHeatmap({ events: monitor.events });

<TrafficLog events={filtered} onSelect={openDetail} />
<RuleHeatmap entries={entries} onSelectRule={scopeLogToRule} />`}</pre>
    </div>
  );
}
