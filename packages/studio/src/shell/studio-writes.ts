/**
 * Everything Studio writes to the sandbox: rules, seed documents, seed
 * accounts, and the clear-and-reseed that starts a session over.
 *
 * Each hook routes the same way the reads do, dev-seed first: the in-process
 * `pyric/*` API against the seeded sandbox in review, the worker bundle under
 * `pyric dev --ui`. Every write is an admin write, because Studio is the
 * operator's surface and rules govern the app, not the operator.
 */

import { useCallback } from 'react';
import { setRules as setInProcessFirestoreRules } from 'pyric/sandbox/firestore';
import { doc as inProcessDoc, setDoc as inProcessSetDoc } from 'pyric/firestore';
import { sandbox as authSandbox, type CreateUserRequest } from 'pyric/auth';
import { setRules as workerSetRules } from '@pyric/cli/serve/worker';
import { useDevSeed } from '../dev/DevSeedProvider.js';
import { useEnvironment } from './environment.js';
import { useStudioDataSource } from './studio-data.js';

/**
 * Deploy a ruleset to the live sandbox (Pyric Studio rules-fix "Apply"): the
 * dev-seed's in-process sandbox in review, or the live worker under
 * `pyric dev --ui`. The same `setRules` op the served app uses. Throws when
 * neither source is present.
 */
export function useStudioSetRules(): (source: string) => Promise<void> {
  const seed = useDevSeed();
  const env = useEnvironment();
  const live = env.status === 'ready' ? env.env.live : undefined;
  const seedSandbox = seed.status === 'ready' ? seed.handles.sandbox : null;
  return useCallback(
    async (source: string) => {
      if (seedSandbox) {
        setInProcessFirestoreRules(seedSandbox, source);
        return;
      }
      if (live) {
        await workerSetRules(live.db, source);
        return;
      }
      throw new Error('No sandbox available to deploy rules to.');
    },
    [seedSandbox, live],
  );
}

/** One generated seed document. */
export interface SeedOp {
  path: string;
  data: Record<string, unknown>;
}

/**
 * Apply generated seed documents to the live sandbox as ADMIN (rules bypass),
 * for the NL-seed assist. Routes through the same handle + Firestore API the data
 * grids use: the in-process `pyric/firestore` for dev-seed, the worker bundle in
 * served mode. Returns per-op errors so the caller can report partial failures.
 */
export function useStudioSeed(): (ops: readonly SeedOp[]) => Promise<{ written: number; errors: string[] }> {
  const data = useStudioDataSource();
  return useCallback(
    async (ops: readonly SeedOp[]) => {
      if (data.status !== 'ready') throw new Error('No sandbox available to seed.');
      const adminDb = data.handles.adminFirestore as unknown as Parameters<typeof inProcessDoc>[0];
      const docFn = (data.firestoreApi?.doc ?? inProcessDoc) as typeof inProcessDoc;
      const setDocFn = (data.firestoreApi?.setDoc ?? inProcessSetDoc) as typeof inProcessSetDoc;
      let written = 0;
      const errors: string[] = [];
      for (const op of ops) {
        try {
          await setDocFn(docFn(adminDb, op.path), op.data);
          written++;
        } catch (e) {
          errors.push(`${op.path}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return { written, errors };
    },
    [data],
  );
}

/** One staged auth-user creation. The `{ request }` wrapper leaves room for
 *  update/delete kinds when the proposal auth-op capture lands (next step). */
export interface AuthCreateOp {
  request: CreateUserRequest;
}

/**
 * Create auth users on the live sandbox as ADMIN, mirroring {@link useStudioSeed}.
 * Routes through the same auth handle + API the data surfaces use: in-process
 * `pyric/auth` for dev-seed, the worker bundle in served mode (so it `await`s,
 * since the worker variant is async). Returns per-op errors so the caller can
 * report partial failures (e.g. `auth/uid-already-exists` at apply time).
 */
export function useStudioSeedAuth(): (
  ops: readonly AuthCreateOp[],
) => Promise<{ created: number; errors: string[] }> {
  const data = useStudioDataSource();
  return useCallback(
    async (ops: readonly AuthCreateOp[]) => {
      if (data.status !== 'ready') throw new Error('No sandbox available to seed auth.');
      const authHandle = data.handles.auth as unknown as Parameters<typeof authSandbox.createUser>[0];
      const createUserFn = (data.authApi?.createUser ??
        authSandbox.createUser) as typeof authSandbox.createUser;
      let created = 0;
      const errors: string[] = [];
      for (const op of ops) {
        try {
          await createUserFn(authHandle, op.request);
          created++;
        } catch (e) {
          const who = op.request.uid ?? op.request.email ?? '<auto>';
          errors.push(`${who}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return { created, errors };
    },
    [data],
  );
}

/**
 * Clear the sandbox through the ONE sandbox-owned path (issue #359):
 * `sandbox.resetAll()` — Firestore env + signed-in session + EVERY registered
 * persistable service (auth users, the RTDB tree, storage objects). Because
 * the sandbox iterates its own service registry, Studio cannot forget a
 * service (the old doc-walk + clearUsers approach here never touched storage).
 *
 * Routing: served mode calls the worker's `resetAll` op so the SHARED worker
 * sandbox clears (the same one the app + agent use); dev-seed and the
 * HTTP-mirror fallback call `resetAll()` on the in-process sandbox handle.
 */
export function useStudioClear(): () => Promise<{ errors: string[] }> {
  const data = useStudioDataSource();
  const env = useEnvironment();
  const live = env.status === 'ready' ? env.env.live : undefined;
  return useCallback(async () => {
    if (data.status !== 'ready') throw new Error('No sandbox to clear.');
    const errors: string[] = [];
    try {
      const result = live
        ? await live.resetAll()
        : await data.handles.sandbox.resetAll();
      errors.push(...(result?.errors ?? []));
    } catch (e) {
      errors.push(`reset: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { errors };
  }, [data, live]);
}

/**
 * Reset the session: clear the sandbox, then re-apply the seed. Dev-seed mode
 * re-runs the in-process fixture; served mode re-applies `/__pyric/init.json`.
 */
export function useStudioReset(): () => Promise<{ errors: string[] }> {
  const clear = useStudioClear();
  const seedDocs = useStudioSeed();
  const seedAuthUsers = useStudioSeedAuth();
  const dev = useDevSeed();
  return useCallback(async () => {
    const result = await clear();
    if (dev.status === 'ready') {
      const { applySeed, deploySeedRules } = await import('../dev/seed.js');
      // resetAll swapped the env, wiping the deployed dev ruleset — re-deploy
      // it BEFORE reseeding so the fixture lands under the same governance.
      deploySeedRules(dev.handles.sandbox);
      await applySeed(dev.handles);
    } else {
      try {
        const payload = await fetch('/__pyric/init.json').then((r) => (r.ok ? r.json() : null));
        const seedMap = payload?.seed as Record<string, Record<string, unknown>> | undefined;
        if (seedMap) {
          await seedDocs(Object.entries(seedMap).map(([path, docData]) => ({ path, data: docData })));
        }
        const authUsers = payload?.authUsers as CreateUserRequest[] | undefined;
        if (Array.isArray(authUsers)) {
          await seedAuthUsers(authUsers.map((request) => ({ request })));
        }
      } catch (e) {
        result.errors.push(`reseed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return result;
  }, [clear, seedDocs, seedAuthUsers, dev]);
}
