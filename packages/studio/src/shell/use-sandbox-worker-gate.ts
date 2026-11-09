/**
 * Shared gate for Studio's sandbox SharedWorker RPC plane.
 *
 * Until `/__pyric/health` answers (`!hostAnswered`) or while Studio is attached
 * to a live Firebase host (`liveHost !== null`), sandbox worker data, state,
 * and presence RPCs stay off so Studio neither reads nor mutates the local
 * sandbox implicitly. Event streaming (`env.live.feed`) and worker runtime
 * health (`env.live.runtime`) stay active on `EnvironmentProvider` directly.
 */
import type { LiveHostStatus } from 'pyric/sandbox/internal';
import type { WorkerLivePlane } from '../env.js';
import { useEnvironment } from './environment.js';
import { useHostAnswered, useLiveHost } from './live-status.js';

/** True once `/__pyric/health` has confirmed the host is a sandbox (not live). */
export function isSandboxHostConfirmed(
  hostAnswered: boolean,
  liveHost: LiveHostStatus | null,
): boolean {
  return hostAnswered && liveHost === null;
}

/** Hook form of {@link isSandboxHostConfirmed}. */
export function useIsSandboxWorkerAllowed(): boolean {
  const hostAnswered = useHostAnswered();
  const liveHost = useLiveHost();
  return isSandboxHostConfirmed(hostAnswered, liveHost);
}

/**
 * Returns the SharedWorker sandbox plane only when the environment is ready
 * and `/__pyric/health` has confirmed sandbox mode.
 */
export function useSandboxWorkerLive(): WorkerLivePlane | undefined {
  const env = useEnvironment();
  const allowed = useIsSandboxWorkerAllowed();
  if (!allowed || env.status !== 'ready') return undefined;
  return env.env.live;
}
