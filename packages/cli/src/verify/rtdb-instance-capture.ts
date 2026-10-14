/**
 * The verify capture's named RTDB instances: each one's active rules and
 * data, so `pyric verify` replays an instance into the tree the session left
 * it with, as it replays the default instance.
 *
 * Runs wherever a capture is written: the SharedWorker and the Node host
 * (`serve/worker/serve-init.ts`) and the in-page runtime
 * (`serve/entries/runtime.ts`). The default instance is captured at the top
 * of `services.rtdb`, so it is not listed here.
 */
import type { Sandbox } from 'pyric/sandbox';
import { getAdminDatabase } from 'pyric/database';
import { heldDatabaseInstances } from 'pyric/database/internal';
import { getActiveRules, snapshotState } from 'pyric/sandbox/database';
import { UNNAMED_DEFAULT_DATABASE_INSTANCE } from 'pyric/sandbox/internal';

import type { VerifyRtdbInstanceCapture } from './fixture.js';

/**
 * Every named instance `sandbox` holds, by name, with its active rules and
 * its tree. `defaultInstance` is the default instance's name: a sandbox may
 * hold a separate backend under that name, opened before the host learned
 * the name was the default's, and that backend is not a named instance.
 */
export function captureRtdbInstances(
  sandbox: Sandbox,
  defaultInstance?: string,
): Record<string, VerifyRtdbInstanceCapture> {
  const instances: Record<string, VerifyRtdbInstanceCapture> = {};
  for (const name of heldDatabaseInstances(sandbox)) {
    if (name === defaultInstance) continue;
    const database = getAdminDatabase(sandbox, name);
    instances[name] = {
      rules: { format: 'rtdb.rules.json', json: getActiveRules(database) ?? { rules: {} } },
      state: { tree: snapshotState(database) },
    };
  }
  return instances;
}

/**
 * The URL the capture records for the default instance, from its name;
 * `undefined` while no project names it.
 */
export function defaultInstanceUrl(name: string | undefined): string | undefined {
  const isNamed = name !== undefined && name !== UNNAMED_DEFAULT_DATABASE_INSTANCE;
  return isNamed ? `https://${name}.firebaseio.com` : undefined;
}
