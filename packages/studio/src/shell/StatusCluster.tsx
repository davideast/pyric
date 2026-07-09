/**
 * Shell status cluster (specs/shell.md): the bar's right region.
 *
 * Two chips, both global truths, both by exception or by presence:
 *
 *  - SANDBOX HEALTH — rendered ONLY when degraded (status by exception;
 *    a healthy sandbox earns no pixels). Degraded means: the environment
 *    factory failed, or Studio is SERVED (`/__pyric/init.json` answers) but
 *    the live SharedWorker plane is unreachable — the surfaces are then
 *    mirrors, not the live sandbox. Links to Settings (diagnostics), the
 *    surface that resolves it.
 *  - MCP PRESENCE — rendered only while Studio's own bridge-peer registration
 *    is CONNECTED: the honest, cheap signal that the MCP relay into this
 *    sandbox is live. (The bridge does not surface the remote client's name
 *    to browser peers, so the chip names the bridge, not the agent —
 *    deviation from specs/shell.md noted there.)
 *
 * Container-agnostic (L4): a flex row of chips, gap-spaced, no external
 * geometry.
 */

import { useSyncExternalStore } from 'react';
import { useEnvironment } from './environment.js';
import { useServeInit } from './serve-init.js';
import { hrefFor, pushPath } from './router.js';

const NONE = () => () => {};

export function StatusCluster() {
  const env = useEnvironment();
  const serve = useServeInit();

  const bridge = env.status === 'ready' ? env.env.bridge : undefined;
  const bridgeState = useSyncExternalStore(
    bridge ? bridge.subscribe : NONE,
    bridge ? bridge.get : () => null,
    () => null,
  );

  const served = serve.status === 'ready';
  const workerDown = served && env.status === 'ready' && !env.env.live;
  const envDown = env.status === 'error';
  const degraded = envDown
    ? 'backend error'
    : workerDown
      ? 'worker unreachable'
      : null;

  const connected = bridgeState?.kind === 'connected';

  return (
    <div className="studio__status" aria-label="Studio status">
      {degraded ? (
        <a
          className="studio-chip studio-chip--warn"
          href={hrefFor({ tab: 'settings' })}
          title={
            envDown
              ? env.error.message
              : 'Served, but the shared sandbox worker is not reachable; data views may be stale. Open Settings diagnostics.'
          }
          onClick={(e) => {
            e.preventDefault();
            pushPath({ tab: 'settings' });
          }}
        >
          <span className="studio-chip__dot" aria-hidden="true" />
          {degraded}
        </a>
      ) : null}
      {connected ? (
        <span
          className="studio-chip studio-chip--live"
          title={`MCP bridge connected (bridge v${
            bridgeState.kind === 'connected' ? bridgeState.bridgeVersion : ''
          }) — external agents can reach this sandbox.`}
        >
          <span className="studio-chip__dot" aria-hidden="true" />
          MCP bridge
        </span>
      ) : null}
    </div>
  );
}
