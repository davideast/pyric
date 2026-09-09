/**
 * The sandbox instance a Studio tab is looking at, and the states it holds.
 *
 * Three things a session needs and nothing else does: which instance this is
 * (the same URL in another browser profile is a separate sandbox), the whole
 * state as a bundle that can leave and come back, and the named saved states
 * kept beside the sandbox that a user can go back to. All three are the live
 * worker's; in dev-seed and review there is no worker, so each answers with
 * nothing rather than guessing.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SandboxSnapshot } from 'pyric/sandbox';
import { useDevSeed } from '../dev/DevSeedProvider.js';
import { useEnvironment } from './environment.js';

/**
 * A getter for the current sandbox snapshot (Pyric Studio rules re-run): the
 * dev-seed's in-process sandbox in review, or the live worker's snapshot under
 * `pyric dev --ui`. Studio forks the result to test a denied op against edited
 * rules / re-issue it as the attempting user, all on a throwaway branch (no live
 * mutation). Resolves null when neither source is present (the re-run UI stays
 * off rather than guessing).
 */
export function useStudioSnapshot(): () => Promise<SandboxSnapshot | null> {
  const seed = useDevSeed();
  const env = useEnvironment();
  const live = env.status === 'ready' ? env.env.live : undefined;
  const seedSandbox = seed.status === 'ready' ? seed.handles.sandbox : null;
  return useCallback(async () => {
    if (seedSandbox) return seedSandbox.snapshot();
    if (live) return live.getSnapshot();
    return null;
  }, [seedSandbox, live]);
}

/**
 * The live sandbox's stable instance id (Phase 1: instance identity). Empty in
 * dev-seed / review (no live worker). Studio renders it as a slug so a user can
 * tell WHICH sandbox instance they're looking at: the same `localhost:<port>`
 * in another browser profile is a separate instance.
 */
export function useSandboxInstanceId(): string {
  const env = useEnvironment();
  const live = env.status === 'ready' ? env.env.live : undefined;
  const [id, setId] = useState('');
  useEffect(() => {
    if (!live) {
      setId('');
      return;
    }
    let cancelled = false;
    void live.instanceId().then((v) => {
      if (!cancelled) setId(v);
    });
    return () => {
      cancelled = true;
    };
  }, [live]);
  return id;
}

/**
 * Phase 2 (transfer): export the live sandbox's full state as a portable bundle
 * string. Returns null in dev-seed / review (no live worker).
 */
export function useStudioExport(): () => Promise<string | null> {
  const env = useEnvironment();
  const live = env.status === 'ready' ? env.env.live : undefined;
  return useCallback(async () => {
    if (!live) return null;
    return live.exportState();
  }, [live]);
}

/**
 * Phase 2 (clobber): replace the live sandbox's ENTIRE state with `bundle`.
 * Returns false in dev-seed / review (no live worker to clobber).
 */
export function useStudioImport(): (bundle: string) => Promise<boolean> {
  const env = useEnvironment();
  const live = env.status === 'ready' ? env.env.live : undefined;
  return useCallback(async (bundle: string) => {
    if (!live) return false;
    await live.importState(bundle);
    return true;
  }, [live]);
}

/** The sandbox's saved states, and what can be done with one. */
export interface StudioSavedStates {
  /** The names this instance holds, ordered. */
  names: string[];
  save(name: string): Promise<void>;
  restore(name: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/**
 * The live sandbox's saved states and their mutations. A saved state is the
 * whole sandbox under a name: documents, the database tree, objects, accounts,
 * and rules. The list refreshes after each save and delete; empty in dev-seed
 * and review, which have no live worker to hold one.
 */
export function useSavedStates(): StudioSavedStates {
  const env = useEnvironment();
  const live = env.status === 'ready' ? env.env.live : undefined;
  const [names, setNames] = useState<string[]>([]);
  const refresh = useCallback(async () => {
    if (!live) {
      setNames([]);
      return;
    }
    const listed = await live.listStates();
    setNames(listed.map((entry) => entry.name));
  }, [live]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const save = useCallback(
    async (name: string) => {
      if (!live) return;
      await live.saveState(name);
      await refresh();
    },
    [live, refresh],
  );
  const restore = useCallback(
    async (name: string) => {
      if (live) await live.restoreState(name);
    },
    [live],
  );
  const remove = useCallback(
    async (name: string) => {
      if (!live) return;
      await live.deleteState(name);
      await refresh();
    },
    [live, refresh],
  );
  return { names, save, restore, remove };
}
