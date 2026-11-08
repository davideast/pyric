/**
 * Traffic on a live host: each row is one grid (time, Production or Sandbox,
 * service, method, path, outcome, chevron), and every row opens in place
 * through Traffic's `?inspect=<id>` expansion. Who sent an op and as whom
 * live in the expansion, which leads with one label/value list and then
 * shows Traffic's existing detail. The "From" select, at the tab strip's
 * trailing edge, scopes the rows by client or user.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { keepChosenOption, type LiveHostStatus, type ScopeOption } from 'pyric/sandbox/internal';
import { currentPath, pushPath, subscribeToLocation } from '../../shell/router.js';
import {
  localDrift,
  opensRulesInspector,
  rowNavigationTarget,
  type StudioTrafficEvent,
} from './verdict.js';
import { LiveRulesView } from './TrafficLiveRulesDetail.js';
import { TrafficRulesInspector } from './TrafficRulesInspector.js';
import {
  EVERY_CLIENT,
  fromOptions,
  fullTime,
  liveIdentity,
  liveSourceLabel,
  outcomeText,
  rowOutcome,
} from './live-row.js';

type LiveClient = NonNullable<LiveHostStatus['clients']>[number];

const DRIFT_REASON =
  "The local rules file differs from the deployed rules, or pyric's rules engine differs from production's.";

/** The row's lead cell: Production or Sandbox, in one fixed track. */
export function TargetCell({ event }: { event: StudioTrafficEvent }) {
  const isProduction = event.production !== undefined;
  return (
    <span className="traffic__target" data-target={isProduction ? 'production' : 'sandbox'}>
      {isProduction ? 'Production' : 'Sandbox'}
    </span>
  );
}

/** The row's closing cell: the outcome pill, blank but still holding its track when there is none. */
export function OutcomeCell({ event }: { event: StudioTrafficEvent }) {
  const outcome = rowOutcome(event);
  if (outcome === null) return <span className="traffic__verdict traffic__verdict--blank" aria-hidden="true" />;
  return (
    <span className="traffic__verdict" data-verdict={outcome.verdict}>
      {outcome.label}
    </span>
  );
}

type Fact = readonly [label: string, value: string, mono?: boolean];

function rowFacts(event: StudioTrafficEvent, live: LiveHostStatus | null): Fact[] {
  const clients = live?.clients ?? [];
  const isProduction = event.production !== undefined;
  return [
    ['Source', liveSourceLabel(event, clients)],
    ['Identity', liveIdentity(event, clients)],
    ['Method', event.method, true],
    ['Target', isProduction ? `Production, ${live?.projectId ?? ''}` : 'Local sandbox'],
    ['Path', event.path || '/', true],
    ['Outcome', outcomeText(event)],
    ['Time', fullTime(event.at), true],
  ];
}

/**
 * The expanded row: one label/value list (`data-pyric-row-fact` names each
 * field), then the detail Traffic already shows, then the row's actions.
 */
export function LiveRowDetail({
  event,
  live,
  onClose,
}: {
  event: StudioTrafficEvent;
  live: LiveHostStatus | null;
  onClose: () => void;
}) {
  const isProduction = event.production !== undefined;
  // A production RTDB op has no record in the local sandbox viewer, so it offers no link.
  const target = rowNavigationTarget(event);
  const opensSandboxRules = !isProduction && opensRulesInspector(event);
  return (
    <div className="traffic__inspector traffic__row-detail" data-pyric-ui="traffic-row-detail">
      <dl className="traffic__facts">
        {rowFacts(event, live).map(([label, value, mono]) => (
          <div key={label} className="traffic__fact" data-pyric-row-fact={label.toLowerCase()}>
            <dt>{label}</dt>
            <dd data-mono={mono ? '' : undefined}>{value}</dd>
          </div>
        ))}
      </dl>
      {localDrift(event) === undefined ? null : (
        <p className="traffic__drift-reason traffic__row-detail-wide" data-drift-reason="">
          {DRIFT_REASON}
        </p>
      )}
      {isProduction ? <LiveRulesView event={event} className="traffic__row-detail-wide" showDrift={false} /> : null}
      {opensSandboxRules ? (
        <div className="traffic__row-detail-wide">
          <TrafficRulesInspector eventId={event.id} onClose={onClose} />
        </div>
      ) : null}
      <div className="traffic__row-detail-actions traffic__row-detail-wide">
        {target === null ? null : (
          <button type="button" className="traffic__row-detail-action" onClick={() => pushPath(target)}>
            {isProduction ? 'Open in Studio' : 'Open the record'}
          </button>
        )}
        <button type="button" className="traffic__inspector-close" onClick={onClose} aria-label="Close details (Esc)">
          Close
        </button>
      </div>
    </div>
  );
}

/** Two-way bind the "From" select to `?from=` (the URL is the store, as `?hide=studio` is). */
export function useFromScope(): readonly [string, (value: string) => void] {
  const value = useSyncExternalStore(
    subscribeToLocation,
    () => currentPath().query.from ?? EVERY_CLIENT,
    () => EVERY_CLIENT,
  );
  const choose = useCallback((next: string) => {
    const query = { ...currentPath().query } as Record<string, string | undefined>;
    if (next === EVERY_CLIENT) delete query.from;
    else query.from = next;
    pushPath({ tab: 'traffic', query });
  }, []);
  return [value, choose] as const;
}

/** The "From" select, at the tab strip's trailing edge beside "Hide Studio traffic". */
export function FromSelect({
  value,
  onChange,
  clients,
  events,
}: {
  value: string;
  onChange: (value: string) => void;
  clients: readonly LiveClient[];
  events: readonly StudioTrafficEvent[];
}) {
  const listedOptions = fromOptions(clients, events);
  const listed = [...listedOptions.clients, ...listedOptions.users].find((option) => option.value === value);
  // The option the scope was chosen from, as last listed: a client that
  // disconnects while chosen keeps its option and its rows, as the chip's does.
  const [chosen, setChosen] = useState<ScopeOption | null>(listed ?? null);
  useEffect(() => {
    if (listed !== undefined) setChosen(listed);
  }, [listed?.value, listed?.label]); // eslint-disable-line react-hooks/exhaustive-deps
  const options = keepChosenOption(listedOptions, value, listed ?? chosen);
  return (
    <span className="traffic__from">
      <select
        className="traffic__filter-select traffic__from-select"
        aria-label="Requests from"
        data-pyric-traffic-from=""
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value={EVERY_CLIENT}>From every client</option>
        <optgroup label="Clients">
          {options.clients.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </optgroup>
        <optgroup label="Users">
          {options.users.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </optgroup>
      </select>
    </span>
  );
}
