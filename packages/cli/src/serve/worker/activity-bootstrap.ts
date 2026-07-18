import type { ActivityMonitor } from 'pyric/firestore/internal';
import { setupFirebaseActivityGuard as setupActivityGuardForFeed } from '../activity-guard.js';
import type { HostCtx } from './host.js';

export interface WorkerActivityEnv {
  fetch: typeof fetch;
}

/** Own the worker-lifetime warning guard after capture history has hydrated. */
export function setupFirebaseActivityGuard(
  ctx: HostCtx,
  env: WorkerActivityEnv,
  activityToken: string | undefined,
): ActivityMonitor | null {
  if (!activityToken) return null;
  return setupActivityGuardForFeed(
    {
      history: () => ctx.sandbox.history(),
      subscribe: (listener) => ctx.sandbox.onEvent(listener),
    },
    env.fetch,
    activityToken,
  );
}
