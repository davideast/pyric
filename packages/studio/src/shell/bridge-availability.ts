/**
 * Bridge AVAILABILITY for the shell's presence chip.
 *
 * The chip used to mirror Studio's OWN bridge-peer connection
 * (`env.bridge`, fed by `connectStudioBridgePeer`'s `onStateChange`) — which
 * is the wrong truth: the bridge holds ONE peer slot (last-connection-wins),
 * so the moment another tab (the served app, a second Studio tab, the
 * playground embed) takes the slot, Studio's own registration goes standby
 * and the chip vanished even though MCP was fully available through that
 * other tab.
 *
 * The honest signal is the bridge's own health endpoint: GET /__pyric/health
 * answers `{ sandboxConnected }` — the same signal the standby poller and
 * the dev-runner's first-run gate consume. The chip shows when the bridge
 * endpoint is live AND a sandbox peer (ANY tab) is connected.
 *
 * Polling is gentle: one probe on mount; if the endpoint is absent (not
 * served / bridge off — it cannot appear without a serve restart) polling
 * stops for good; otherwise re-probe every `intervalMs` (default 5s) and
 * only while the tab is visible.
 */

import { useEffect, useState } from 'react';

/** One health probe's outcome, network-free (pure mapping input). */
export type HealthProbe =
  | { kind: 'json'; sandboxConnected: boolean }
  | { kind: 'absent' };

export type BridgeAvailability =
  /** First probe not answered yet. */
  | 'checking'
  /** No bridge endpoint (dev-seed / review, or serve without --bridge). */
  | 'absent'
  /** Bridge endpoint live, but no sandbox peer connected (no tab). */
  | 'idle'
  /** Bridge live + a sandbox peer (any tab) connected: MCP reaches the sandbox. */
  | 'available';

/** Pure probe → availability mapping (unit-tested seam). */
export function availabilityFromProbe(probe: HealthProbe): BridgeAvailability {
  if (probe.kind === 'absent') return 'absent';
  return probe.sandboxConnected ? 'available' : 'idle';
}

/** Parse a health response into a probe. Anything but 200+JSON with a boolean
 *  `sandboxConnected` is `absent` — only the bridge mount answers this shape. */
export function probeFromResponse(status: number, body: unknown): HealthProbe {
  if (status !== 200 || typeof body !== 'object' || body === null) return { kind: 'absent' };
  const flag = (body as { sandboxConnected?: unknown }).sandboxConnected;
  if (typeof flag !== 'boolean') return { kind: 'absent' };
  return { kind: 'json', sandboxConnected: flag };
}

async function probeHealth(fetchImpl: typeof fetch): Promise<HealthProbe> {
  try {
    const res = await fetchImpl('/__pyric/health');
    if (!res.ok) return { kind: 'absent' };
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('json')) return { kind: 'absent' };
    return probeFromResponse(res.status, await res.json());
  } catch {
    return { kind: 'absent' };
  }
}

/**
 * Poll bridge availability while the tab is visible. `intervalMs` defaults to
 * a gentle 5s; the loop stops permanently once the endpoint proves absent.
 */
export function useBridgeAvailability(intervalMs = 5_000): BridgeAvailability {
  const [state, setState] = useState<BridgeAvailability>('checking');

  useEffect(() => {
    if (typeof fetch === 'undefined') {
      setState('absent');
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const probe = async (): Promise<BridgeAvailability> => {
      const result = availabilityFromProbe(await probeHealth(fetch));
      if (!alive) return result;
      setState(result);
      if (result === 'absent' && timer) {
        clearInterval(timer);
        timer = null;
      }
      return result;
    };

    const visible = (): boolean =>
      typeof document === 'undefined' || document.visibilityState !== 'hidden';

    const start = (): void => {
      if (timer) return;
      timer = setInterval(() => {
        if (visible()) void probe();
      }, intervalMs);
    };

    const onVisibility = (): void => {
      if (visible()) {
        void probe(); // immediate refresh on return to the tab
      }
    };

    void probe().then((result) => {
      if (alive && result !== 'absent') start();
    });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [intervalMs]);
  return state;
}
