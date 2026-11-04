/**
 * How the chip reads its page host's live status: the host's
 * `/__pyric/health` report, read through the shared poller
 * (`pyric/sandbox/internal`).
 */
import { readLiveHostStatus, type ReadLiveStatus } from 'pyric/sandbox/internal';

/** The live status in the page host's `/__pyric/health` report. */
export function healthLiveStatus(documentLike: Document): ReadLiveStatus {
  return async () => {
    const view = documentLike.defaultView;
    const fetchHealth = view?.fetch?.bind(view);
    if (fetchHealth === undefined) return null;
    const response = await fetchHealth('/__pyric/health', { cache: 'no-store' });
    if (!response.ok) throw new Error(`The host's health report answered ${response.status}.`);
    return readLiveHostStatus(await response.json());
  };
}

