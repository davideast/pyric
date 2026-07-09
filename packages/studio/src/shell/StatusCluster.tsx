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

import { useEnvironment } from './environment.js';
import { useServeInit } from './serve-init.js';
import { useBridgeAvailability } from './bridge-availability.js';
import { hrefFor, pushPath } from './router.js';

export function StatusCluster() {
  const env = useEnvironment();
  const serve = useServeInit();
  const bridgeAvailability = useBridgeAvailability();

  const served = serve.status === 'ready';
  const workerDown = served && env.status === 'ready' && !env.env.live;
  const envDown = env.status === 'error';
  const degraded = envDown
    ? 'backend error'
    : workerDown
      ? 'worker unreachable'
      : null;

  const connected = bridgeAvailability === 'available';

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
          title="MCP bridge available — a sandbox peer is connected; external agents can reach this sandbox."
        >
          <span className="studio-chip__dot" aria-hidden="true" />
          MCP bridge
        </span>
      ) : null}
    </div>
  );
}
