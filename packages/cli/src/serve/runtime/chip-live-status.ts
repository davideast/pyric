/**
 * How the chip reads its page host's live status: the host's
 * `/__pyric/health` report, read through the shared poller
 * (`pyric/sandbox/internal`).
 */
import { readLiveHostStatus, type ReadLiveStatus } from 'pyric/sandbox/internal';
import { hostRestartedSincePageLoad, pageBootHostInstanceId, type HostRestart, type PageBootGlobals } from './host-restart.js';

/** The host boot id a `/__pyric/health` report names, if it names one. */
function healthInstanceId(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') return undefined;
  return (payload as { instanceId?: unknown }).instanceId;
}

/**
 * The live status in the page host's `/__pyric/health` report. The report
 * also names the host boot, so a host that restarted since this page loaded
 * is reported to `onHostRestarted`, once.
 */
export function healthLiveStatus(
  documentLike: Document,
  onHostRestarted?: (restart: HostRestart) => void,
): ReadLiveStatus {
  let reportedHostRestart = false;
  return async () => {
    const view = documentLike.defaultView as (Window & PageBootGlobals) | null;
    const fetchHealth = view?.fetch?.bind(view);
    if (fetchHealth === undefined) return null;
    const response = await fetchHealth('/__pyric/health', { cache: 'no-store' });
    if (!response.ok) throw new Error(`The host's health report answered ${response.status}.`);
    const payload: unknown = await response.json();
    const bootIds = {
      initialHostInstanceId: view === null ? undefined : pageBootHostInstanceId(view),
      currentHostInstanceId: healthInstanceId(payload),
    };
    if (!reportedHostRestart && hostRestartedSincePageLoad(bootIds)) {
      reportedHostRestart = true;
      onHostRestarted?.(bootIds);
    }
    return readLiveHostStatus(payload);
  };
}

