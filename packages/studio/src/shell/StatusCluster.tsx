/**
 * Shell status cluster (specs/shell.md): the bar's right region.
 *
 * Chips, all global truths:
 *
 *  - WORKER UPDATE — rendered when Studio's running SharedWorker is older
 *    than the version served with this page. Replaces the worker only after
 *    the user confirms by pressing the chip.
 *  - SANDBOX HEALTH — rendered ONLY when degraded (status by exception;
 *    a healthy sandbox earns no pixels). Degraded means: the environment
 *    factory failed, or Studio is SERVED (`/__pyric/init.json` answers) but
 *    the live SharedWorker plane is unreachable — the surfaces are then
 *    mirrors, not the live sandbox. Links to Settings (diagnostics), the
 *    surface that resolves it.
 *  - CONNECTED PAGES (#227) — how many logical pages share this sandbox
 *    worker. Quiet for one page; prominent when multiple. An accessible
 *    popover lists each client (app/Studio, route, visibility, freshness)
 *    and states the visibility boundary honestly.
 *  - MCP PRESENCE — rendered while the bridge is AVAILABLE: the bridge
 *    endpoint answers `/__pyric/health` and a sandbox peer (ANY tab) is
 *    connected. Deliberately NOT Studio's own peer registration — the peer
 *    slot is last-connection-wins, so another tab holding it must not hide
 *    the chip while MCP remains fully reachable (see bridge-availability.ts).
 *    (The bridge does not surface the remote client's name to browser peers,
 *    so the chip names the bridge, not the agent — deviation from
 *    specs/shell.md noted there.)
 *
 * Container-agnostic (L4): a flex row of chips, gap-spaced, no external
 * geometry.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useEnvironment } from './environment.js';
import { useServeInit } from './serve-init.js';
import { useBridgeAvailability } from './bridge-availability.js';
import { usePresenceView } from './presence.js';
import { useBridgeRemoteConsumers } from './bridge-presence.js';
import { RemoteClientsPopover } from './RemoteClientsPopover.js';
import { useStudioDataSource } from './studio-data.js';
import { hrefFor, pushPath } from './router.js';

const EMPTY_WORKER_RUNTIME = {
  servedEpoch: null,
  runningEpoch: null,
  updateAvailable: false,
  updating: false,
  error: null,
} as const;
const subscribeToNothing = () => () => {};
const getEmptyWorkerRuntime = () => EMPTY_WORKER_RUNTIME;

export function StatusCluster() {
  const env = useEnvironment();
  const serve = useServeInit();
  const bridgeAvailability = useBridgeAvailability();
  const presence = usePresenceView();
  const [presenceOpen, setPresenceOpen] = useState(false);
  const presenceTriggerRef = useRef<HTMLButtonElement>(null);
  const { consumers: remoteConsumers, setLens: setRemoteLens } = useBridgeRemoteConsumers();
  const [remoteOpen, setRemoteOpen] = useState(false);
  const remoteTriggerRef = useRef<HTMLButtonElement>(null);
  const studioData = useStudioDataSource();
  const authHandle = studioData.status === 'ready' ? (studioData.handles?.auth as any) : undefined;
  const workerRuntime = env.status === 'ready' ? env.env.live?.runtime : undefined;
  const workerRuntimeSnapshot = useSyncExternalStore(
    workerRuntime?.subscribe ?? subscribeToNothing,
    workerRuntime?.getSnapshot ?? getEmptyWorkerRuntime,
    workerRuntime?.getSnapshot ?? getEmptyWorkerRuntime,
  );

  const served = serve.status === 'ready';
  const workerDown = served && env.status === 'ready' && !env.env.live;
  const envDown = env.status === 'error';
  const degraded = workerRuntimeSnapshot.error
    ? 'worker update failed'
    : envDown
      ? 'backend error'
      : workerDown
        ? 'worker unreachable'
        : null;
  const degradedTitle = workerRuntimeSnapshot.error
    ?? (envDown
      ? env.error.message
      : 'Served, but the shared sandbox worker is not reachable; data views may be stale. Open Settings diagnostics.');

  const connected = bridgeAvailability === 'available';

  useEffect(() => {
    if (!presenceOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPresenceOpen(false);
        presenceTriggerRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [presenceOpen]);

  return (
    <div className="studio__status" aria-label="Studio status">
      {workerRuntimeSnapshot.updateAvailable ? (
        <button
          type="button"
          className="studio-chip studio-chip--warn"
          disabled={workerRuntimeSnapshot.updating}
          title="The Studio backend is running older code. Update every connected page to the served worker version."
          onClick={() => void workerRuntime?.update().catch(() => {})}
        >
          <span className="studio-chip__dot" aria-hidden="true" />
          {workerRuntimeSnapshot.updating ? 'updating worker…' : 'update worker'}
        </button>
      ) : null}
      {degraded ? (
        <a
          className="studio-chip studio-chip--warn"
          href={hrefFor({ tab: 'settings' })}
          title={degradedTitle}
          onClick={(e) => {
            e.preventDefault();
            pushPath({ tab: 'settings' });
          }}
        >
          <span className="studio-chip__dot" aria-hidden="true" />
          {degraded}
        </a>
      ) : null}
      {presence && presence.count > 0 ? (
        <span className="studio-presence">
          <button
            ref={presenceTriggerRef}
            type="button"
            className={
              presence.prominent
                ? 'studio-chip studio-chip--live studio-presence__trigger'
                : 'studio-chip studio-presence__trigger'
            }
            aria-haspopup="dialog"
            aria-expanded={presenceOpen}
            aria-controls="studio-presence-panel"
            title={
              presence.otherCount > 0
                ? `${presence.chipLabel}. ${presence.otherCount} other page${presence.otherCount === 1 ? '' : 's'} can keep the worker alive.`
                : `${presence.chipLabel}. Expand for details.`
            }
            onClick={() => setPresenceOpen((o) => !o)}
          >
            <span className="studio-chip__dot" aria-hidden="true" />
            {presence.chipLabel}
          </button>
          {presenceOpen ? (
            <>
              <div
                className="studio-presence__backdrop"
                onMouseDown={() => setPresenceOpen(false)}
              />
              <div
                id="studio-presence-panel"
                className="studio-presence__panel"
                role="dialog"
                aria-label="Connected pages"
              >
                <p className="studio-presence__lead">
                  {presence.count === 1
                    ? 'This page is the only connection to the shared sandbox worker.'
                    : `${presence.count} pages share this sandbox worker. Closing this page alone will not restart it.`}
                </p>
                <ul className="studio-presence__list">
                  {presence.clients.map((c) => (
                    <li key={c.clientId} className="studio-presence__item">
                      <div className="studio-presence__item-head">
                        <span className="studio-presence__kind">{c.kindLabel}</span>
                        {c.isThisPage ? (
                          <span className="studio-presence__this">This page</span>
                        ) : null}
                      </div>
                      <div className="studio-presence__route" title={c.route}>
                        {c.route}
                      </div>
                      <div className="studio-presence__meta">
                        {c.visibilityLabel} · {c.freshnessLabel}
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="studio-presence__boundary">{presence.boundaryCopy}</p>
              </div>
            </>
          ) : null}
        </span>
      ) : null}
      {remoteConsumers.length > 0 ? (
        <span className="studio-remote-clients">
          <button
            ref={remoteTriggerRef}
            type="button"
            className="studio-chip studio-chip--live studio-remote-clients__trigger"
            aria-haspopup="dialog"
            aria-expanded={remoteOpen}
            aria-controls="studio-remote-clients-panel"
            title={`${remoteConsumers.length} remote mobile client${remoteConsumers.length === 1 ? '' : 's'} connected over the bridge. Click to control identity.`}
            onClick={() => setRemoteOpen((o) => !o)}
          >
            <span className="studio-chip__dot" aria-hidden="true" />
            {remoteConsumers.length === 1 ? '1 remote client' : `${remoteConsumers.length} remote clients`}
          </button>
          <RemoteClientsPopover
            isOpen={remoteOpen}
            onClose={() => setRemoteOpen(false)}
            consumers={remoteConsumers}
            onSetLens={setRemoteLens}
            triggerRef={remoteTriggerRef}
            auth={authHandle}
          />
        </span>
      ) : null}
      {connected ? (
        <span
          className="studio-chip studio-chip--live"
          title="MCP bridge available — a sandbox peer is connected; external agents can reach this sandbox."
        >
          <span className="studio-chip__dot" aria-hidden="true" />
          MCP bridge
        </span>
      ) : null}
    </div>
  );
}
