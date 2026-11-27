/**
 * Pyric Studio Functions inspector surface.
 *
 * Consumes existing read-only CLI bridge methods (`functions.listTriggers`,
 * `functions.executions`, `functions.fire`) plus live `service: 'functions'`,
 * `op: 'execution_finished'` events off the shared Studio event stream.
 *
 * Shows:
 *   - Discovered triggers grouped or filterable by family with endpoint URLs,
 *     event patterns, and region badges
 *   - Unsupported-trigger diagnostics when a project exports skipped triggers
 *   - Manual Fire controls with strict JSON validation and inline feedback
 *   - Live execution history with status, latency, trigger name, and errors
 *   - Honest fallback banners for missing bridge, SharedWorker-only hosts,
 *     and Live Firebase mode
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { SandboxEvent } from 'pyric/sandbox';
import { IconFunctions } from '../../shell/icons.js';
import { useLiveHost } from '../../shell/live-status.js';
import { useServeInit } from '../../shell/serve-init.js';
import { useStudioEvents } from '../../shell/studio-events.js';
import { createFunctionsBridgeApi, resolveBridgeMetadata } from './bridge-client.js';
import { ExecutionLog } from './ExecutionLog.js';
import {
  FUNCTION_FAMILIES,
  countTriggersByFamily,
  extractLiveExecutions,
  filterTriggers,
  groupTriggersByFamily,
  mergeExecutions,
} from './model.js';
import { TriggerCard } from './TriggerCard.js';
import { UnsupportedDiagnostics } from './UnsupportedDiagnostics.js';
import type {
  DiscoveredTrigger,
  FireOutcome,
  FireTriggerInput,
  FunctionExecution,
  FunctionFamily,
  FunctionsApi,
  FunctionsTransportMode,
  UnsupportedTrigger,
} from './types.js';
import './functions.css';
import './functions-log.css';

export interface FunctionsSurfaceProps {
  /** Injectable Functions API for deterministic tests and custom hosts. */
  readonly api?: FunctionsApi;
  /** Optional explicit transport mode override (tests). */
  readonly modeOverride?: FunctionsTransportMode;
  /** Optional raw SandboxEvent override (tests). */
  readonly eventsOverride?: readonly SandboxEvent[];
  /** Optional origin override for HTTP/Callable endpoint URLs. */
  readonly originOverride?: string;
  /** Optional projectId override for HTTP/Callable endpoint URLs. */
  readonly projectIdOverride?: string | null;
}

export function FunctionsSurface({
  api: injectedApi,
  modeOverride,
  eventsOverride,
  originOverride,
  projectIdOverride,
}: FunctionsSurfaceProps = {}) {
  const serve = useServeInit();
  const liveHost = useLiveHost();
  const studioEvents = useStudioEvents();
  const effectiveEvents = eventsOverride ?? studioEvents;

  const isLiveMode = !injectedApi && liveHost !== null;
  const bridgeMeta = useMemo(
    () => (serve.status === 'ready' ? resolveBridgeMetadata(serve.payload) : null),
    [serve],
  );

  const defaultApi = useMemo<FunctionsApi | null>(() => {
    if (injectedApi) return injectedApi;
    if (isLiveMode) return null;
    if (serve.status !== 'ready' || !bridgeMeta || !bridgeMeta.hosted) return null;
    return createFunctionsBridgeApi({
      instanceId: bridgeMeta.instanceId,
      projectDir: bridgeMeta.projectDir,
      projectId: bridgeMeta.projectId,
      sessionToken: bridgeMeta.sessionToken,
    });
  }, [injectedApi, isLiveMode, serve.status, bridgeMeta]);

  const [mode, setMode] = useState<FunctionsTransportMode>(() => {
    if (modeOverride) return modeOverride;
    if (injectedApi) return 'loading';
    if (isLiveMode) return 'live-mode';
    if (serve.status === 'loading') return 'loading';
    if (serve.status === 'absent') return 'no-bridge';
    return bridgeMeta?.hosted ? 'loading' : 'shared-worker-fallback';
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [discoverySummary, setDiscoverySummary] = useState<string | null>(null);
  const [triggers, setTriggers] = useState<DiscoveredTrigger[]>([]);
  const [unsupported, setUnsupported] = useState<UnsupportedTrigger[]>([]);
  const [bridgeExecutions, setBridgeExecutions] = useState<FunctionExecution[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const [selectedFamily, setSelectedFamily] = useState<FunctionFamily | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [executionTriggerFilter, setExecutionTriggerFilter] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const logAnchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (modeOverride) {
      setMode(modeOverride);
      return;
    }
    if (!injectedApi) {
      if (isLiveMode) {
        setMode('live-mode');
        setErrorMessage(null);
        return;
      }
      if (serve.status === 'loading') {
        setMode('loading');
        return;
      }
      if (serve.status === 'absent') {
        setMode('no-bridge');
        setErrorMessage(null);
        return;
      }
      if (!bridgeMeta?.hosted) {
        setMode('shared-worker-fallback');
        setErrorMessage(null);
        return;
      }
    }
    if (!defaultApi) return;

    const controller = new AbortController();
    let active = true;
    setRefreshing(true);
    setErrorMessage(null);

    void Promise.all([
      defaultApi.listTriggers(controller.signal),
      defaultApi.listExecutions(undefined, controller.signal),
    ]).then(([triggersRes, executionsRes]) => {
      if (!active || controller.signal.aborted) return;
      setRefreshing(false);
      if (!triggersRes.ok) {
        if (triggersRes.failure.kind === 'shared-worker-fallback') {
          setMode('shared-worker-fallback');
          setErrorMessage(triggersRes.failure.message);
        } else if (triggersRes.failure.kind === 'no-bridge') {
          setMode('no-bridge');
          setErrorMessage(triggersRes.failure.message);
        } else {
          setMode('error');
          setErrorMessage(triggersRes.failure.message);
        }
        return;
      }
      setMode('ready');
      setTriggers(triggersRes.data.triggers);
      setUnsupported(triggersRes.data.unsupported);
      setDiscoverySummary(triggersRes.data.summary ?? null);
      if (executionsRes.ok) {
        setBridgeExecutions(executionsRes.data);
      }
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [defaultApi, injectedApi, isLiveMode, modeOverride, serve.status, bridgeMeta?.hosted, refreshNonce]);

  const liveExecutions = useMemo(
    () => extractLiveExecutions(effectiveEvents),
    [effectiveEvents],
  );
  const mergedExecutions = useMemo(
    () => mergeExecutions(bridgeExecutions, liveExecutions),
    [bridgeExecutions, liveExecutions],
  );

  const familyCounts = useMemo(() => countTriggersByFamily(triggers), [triggers]);
  const visibleFamilies = useMemo(() => {
    return FUNCTION_FAMILIES.filter((item) => (familyCounts[item.id] ?? 0) > 0);
  }, [familyCounts]);

  const filterTabs = useMemo(
    () => [
      { id: 'all' as const, label: 'All', count: triggers.length },
      ...visibleFamilies.map((item) => ({
        id: item.id,
        label: item.label,
        count: familyCounts[item.id] ?? 0,
      })),
    ],
    [triggers.length, visibleFamilies, familyCounts],
  );

  const filteredTriggers = useMemo(
    () => filterTriggers(triggers, { family: selectedFamily, query: searchQuery }),
    [triggers, selectedFamily, searchQuery],
  );
  const groupedTriggers = useMemo(
    () => groupTriggersByFamily(filteredTriggers),
    [filteredTriggers],
  );

  const handleRefresh = useCallback(() => {
    setRefreshNonce((n) => n + 1);
  }, []);

  const handleFire = useCallback(
    async (trigger: DiscoveredTrigger, input: FireTriggerInput): Promise<FireOutcome> => {
      if (!defaultApi) {
        return {
          ok: false,
          summary: 'Functions bridge is not connected.',
          error: 'Functions bridge is not connected.',
        };
      }
      const outcome = await defaultApi.fireTrigger(trigger, input);
      void defaultApi.listExecutions().then((res) => {
        if (res.ok) setBridgeExecutions(res.data);
      });
      return outcome;
    },
    [defaultApi],
  );

  const handleFilterLogsForTrigger = useCallback((triggerName: string) => {
    setExecutionTriggerFilter(triggerName);
    logAnchorRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = filterTabs.length;
    if (count === 0) return;
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % count;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + count) % count;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = count - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const target = filterTabs[nextIndex];
    if (target) {
      setSelectedFamily(target.id);
      tabRefs.current[nextIndex]?.focus();
    }
  };

  const effectiveOrigin =
    originOverride ??
    defaultApi?.origin ??
    (typeof window !== 'undefined' && window.location ? window.location.origin : '');
  const effectiveProjectId = projectIdOverride ?? defaultApi?.projectId ?? bridgeMeta?.projectId;
  const rejectedCount = mergedExecutions.filter(
    (item) => item.status === 'rejected' || item.status === 'timeout',
  ).length;

  return (
    <section
      className="studio-surface functions-surface"
      data-pyric-ui="functions-surface"
      data-functions-mode={mode}
      aria-labelledby="functions-title"
    >
      <header className="functions__header">
        <div className="studio-surface__intro functions__intro">
          <p className="studio-surface__eyebrow">
            <IconFunctions size={14} className="functions__eyebrow-icon" />
            Functions
          </p>
          <h1 id="functions-title" className="studio-surface__title">
            Cloud Functions
          </h1>
          <p className="studio-surface__copy">
            Inspect discovered triggers, unsupported export diagnostics, fire local triggers, and
            watch execution history live.
          </p>
        </div>

        <div className="functions__header-controls">
          {defaultApi ? (
            <button
              type="button"
              className="studio-button"
              disabled={refreshing}
              onClick={handleRefresh}
              data-functions-refresh=""
            >
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          ) : null}
        </div>
      </header>

      {mode === 'live-mode' ? (
        <div className="functions__notice" role="status" data-functions-notice="live-mode">
          <span className="functions__notice-badge">Live mode</span>
          <p className="functions__notice-title">
            Local Cloud Functions trigger execution is disabled in Live mode
          </p>
          <p className="functions__notice-copy">
            Live mode observes client SDK traffic without running local Functions handlers.
            Start a local sandbox with <code className="mono">pyric sandbox</code> to discover
            and fire project functions.
          </p>
        </div>
      ) : null}

      {mode === 'no-bridge' ? (
        <div className="functions__notice" role="status" data-functions-notice="no-bridge">
          <span className="functions__notice-badge">Bridge unavailable</span>
          <p className="functions__notice-title">
            Functions bridge is not connected
          </p>
          <p className="functions__notice-copy">
            {errorMessage ??
              'Start Pyric Studio from a local project with pyric sandbox --ui so Studio can discover your functions and fire triggers.'}
          </p>
        </div>
      ) : null}

      {mode === 'shared-worker-fallback' ? (
        <div
          className="functions__notice"
          role="status"
          data-functions-notice="shared-worker-fallback"
        >
          <span className="functions__notice-badge">SharedWorker fallback</span>
          <p className="functions__notice-title">
            Node-hosted sandbox required for trigger discovery and manual Fire
          </p>
          <p className="functions__notice-copy">
            {errorMessage ??
              'This Studio session is attached to a browser SharedWorker without the Node-hosted method endpoint. Restart with pyric sandbox --hosted (the default) to list and fire triggers. Live execution events still stream below.'}
          </p>
        </div>
      ) : null}

      {mode === 'error' ? (
        <div className="functions__notice functions__notice--error" role="alert" data-functions-notice="error">
          <span className="functions__notice-badge">Bridge error</span>
          <p className="functions__notice-title">Could not load Cloud Functions</p>
          <p className="functions__notice-copy">{errorMessage ?? 'An unexpected bridge error occurred.'}</p>
          {defaultApi ? (
            <button type="button" className="studio-button" onClick={handleRefresh}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {mode === 'loading' ? (
        <div className="functions__empty-card" role="status" data-functions-loading="">
          <p className="functions__empty-title">Discovering Functions triggers...</p>
          <p className="functions__empty-copy">
            Reading exports from your project Functions source via the local bridge.
          </p>
        </div>
      ) : null}

      {mode === 'ready' ? (
        <>
          <div className="functions__summary-bar" aria-label="Functions summary">
            <span className="studio-chip">
              <span className="studio-chip__dot" aria-hidden="true" />
              {triggers.length} {triggers.length === 1 ? 'trigger' : 'triggers'}
            </span>
            {unsupported.length > 0 ? (
              <span className="studio-chip studio-chip--warn">
                <span className="studio-chip__dot" aria-hidden="true" />
                {unsupported.length} unsupported
              </span>
            ) : null}
            <span className="studio-chip">
              <span className="studio-chip__dot" aria-hidden="true" />
              {mergedExecutions.length} {mergedExecutions.length === 1 ? 'execution' : 'executions'}
            </span>
            {rejectedCount > 0 ? (
              <span className="studio-chip studio-chip--warn">
                <span className="studio-chip__dot" aria-hidden="true" />
                {rejectedCount} failed
              </span>
            ) : null}
          </div>

          <UnsupportedDiagnostics items={unsupported} />

          <section
            className="functions__triggers-section"
            aria-labelledby="functions-triggers-heading"
          >
            <header className="functions__section-head">
              <div className="functions__section-title-group">
                <h2 id="functions-triggers-heading" className="functions__section-title">
                  Discovered triggers
                </h2>
                <span className="functions__count-pill">
                  {filteredTriggers.length} of {triggers.length}
                </span>
              </div>

              {triggers.length > 0 ? (
                <div className="functions__search-wrap">
                  <input
                    type="search"
                    className="functions__input functions__search"
                    aria-label="Filter functions"
                    placeholder="Filter by name, path, topic, or region..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
              ) : null}
            </header>

            {triggers.length > 0 ? (
              <div
                className="functions__family-tabs"
                role="tablist"
                aria-label="Filter triggers by family"
              >
                {filterTabs.map((tab, index) => {
                  const selected = selectedFamily === tab.id;
                  return (
                    <button
                      key={tab.id}
                      ref={(el) => {
                        tabRefs.current[index] = el;
                      }}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      tabIndex={selected ? 0 : -1}
                      className="functions__filter-pill"
                      data-functions-family-tab={tab.id}
                      onClick={() => setSelectedFamily(tab.id)}
                      onKeyDown={(e) => handleTabKeyDown(e, index)}
                    >
                      {tab.label} ({tab.count})
                    </button>
                  );
                })}
              </div>
            ) : null}

            {triggers.length === 0 ? (
              <div className="functions__empty-card" data-functions-empty="">
                <p className="functions__empty-title">
                  {unsupported.length > 0
                    ? 'No supported Functions triggers found'
                    : 'No Functions triggers discovered'}
                </p>
                <p className="functions__empty-copy">
                  {unsupported.length > 0
                    ? 'Every exported function in this project was reported as unsupported above.'
                    : discoverySummary ??
                      'Declare a "functions" source in firebase.json and export Cloud Functions triggers to inspect them here.'}
                </p>
              </div>
            ) : filteredTriggers.length === 0 ? (
              <div className="functions__empty-card" data-functions-filtered-empty="">
                <p className="functions__empty-title">No triggers match the current filter</p>
                <p className="functions__empty-copy">
                  Try clearing the family filter or search query.
                </p>
                <button
                  type="button"
                  className="studio-button"
                  onClick={() => {
                    setSelectedFamily('all');
                    setSearchQuery('');
                  }}
                >
                  Clear filters
                </button>
              </div>
            ) : (
              <div className="functions__groups">
                {groupedTriggers.map((group) => (
                  <div
                    key={group.family}
                    className="functions__group"
                    data-functions-group={group.family}
                  >
                    <h3 className="functions__group-title">
                      {group.label}
                      <span className="functions__group-count">{group.triggers.length}</span>
                    </h3>
                    <div className="functions__cards">
                      {group.triggers.map((trigger) => (
                        <TriggerCard
                          key={trigger.exportName}
                          trigger={trigger}
                          origin={effectiveOrigin}
                          projectId={effectiveProjectId}
                          onFire={handleFire}
                          onFilterExecutions={handleFilterLogsForTrigger}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}

      <div ref={logAnchorRef}>
        <ExecutionLog
          executions={mergedExecutions}
          triggerFilter={executionTriggerFilter}
          onClearTriggerFilter={() => setExecutionTriggerFilter(null)}
        />
      </div>
    </section>
  );
}
