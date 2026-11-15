/**
 * Persistence lifecycle controller for an in-process MCP session.
 *
 * Owns the `in-process` project-state lock, snapshot/sidecar hydration,
 * debounced snapshot writes, synchronous exit flush, async storage sidecar
 * flush, and lazy lock acquisition when a session started against a Node host
 * falls back to the local in-process sandbox after that host stops.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FirebaseStorage } from 'pyric/storage';
import { claimProjectState } from '../../serve/hosted/project-ownership.js';
import {
  loadStorageSidecar,
  saveStorageSidecar,
  STORAGE_SIDECAR_RELATIVE,
} from './storage-sidecar.js';

export type ProjectStateOwner = Awaited<ReturnType<typeof claimProjectState>>;

interface InProcessPersistenceOptions {
  projectDir: string;
  stateRelativePath: string;
  initialOwner: ProjectStateOwner | null;
  storage: FirebaseStorage;
  loadSnapshot: () => number | null;
  saveSnapshot: () => void;
  reloadRules: () => void;
  log: (message: string) => void;
}

interface InProcessPersistence {
  isPersisting(): boolean;
  hydrateAtStartup(): Promise<void>;
  activateOnFallback(): Promise<string | undefined>;
  scheduleSave(): void;
  flush(): void;
  flushStorage(): Promise<void>;
  release(): void;
}

const SAVE_DEBOUNCE_MS = 750;

function failureMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function createInProcessPersistence(
  options: InProcessPersistenceOptions,
): InProcessPersistence {
  let owner: ProjectStateOwner | null = options.initialOwner;
  let persisting = owner !== null;
  let fallbackAttempted = persisting;
  let ephemeralNotice: string | undefined;
  let activationPromise: Promise<string | undefined> | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSave = false;
  let exitListenerAttached = false;

  const saveNow = (): void => {
    if (!persisting) return;
    pendingSave = false;
    try {
      options.saveSnapshot();
    } catch (error) {
      options.log(`persist failed: ${failureMessage(error)}`);
    }
  };

  const saveIfPendingAtExit = (): void => {
    if (pendingSave) saveNow();
  };

  const attachExitListener = (): void => {
    if (exitListenerAttached) return;
    exitListenerAttached = true;
    process.once('exit', saveIfPendingAtExit);
  };

  const detachExitListener = (): void => {
    if (!exitListenerAttached) return;
    exitListenerAttached = false;
    process.off('exit', saveIfPendingAtExit);
  };

  const clearSaveTimer = (): void => {
    if (saveTimer === null) return;
    clearTimeout(saveTimer);
    saveTimer = null;
  };

  const hydrateState = async (): Promise<void> => {
    const restored = options.loadSnapshot();
    if (restored !== null) {
      options.log(`restored ${restored} docs from ${join(options.projectDir, options.stateRelativePath)}`);
    }
    options.reloadRules();
    const restoredObjects = await loadStorageSidecar(options.storage, options.projectDir);
    if (restoredObjects > 0) {
      options.log(`restored ${restoredObjects} objects from ${join(options.projectDir, STORAGE_SIDECAR_RELATIVE)}`);
    }
  };

  if (persisting) {
    attachExitListener();
  }

  return {
    isPersisting(): boolean {
      return persisting;
    },

    async hydrateAtStartup(): Promise<void> {
      if (persisting) {
        await hydrateState();
        return;
      }
      options.reloadRules();
    },

    async activateOnFallback(): Promise<string | undefined> {
      if (activationPromise !== null) return await activationPromise;
      if (persisting) return undefined;
      if (fallbackAttempted) return ephemeralNotice;
      const activating = (async (): Promise<string | undefined> => {
        fallbackAttempted = true;
        let claimed: ProjectStateOwner | null = null;
        try {
          mkdirSync(options.projectDir, { recursive: true });
          claimed = await claimProjectState(options.projectDir, 'in-process');
          await hydrateState();
          owner = claimed;
          claimed = null;
          persisting = true;
          ephemeralNotice = undefined;
          attachExitListener();
          options.log(`fallback persistence enabled (${options.stateRelativePath})`);
          return undefined;
        } catch (error) {
          claimed?.close();
          const detail = failureMessage(error);
          options.log(`fallback persistence unavailable; running ephemerally: ${detail}`);
          ephemeralNotice = `Local state persistence is unavailable (${detail}); writes after fallback are ephemeral and will not be saved on exit.`;
          return ephemeralNotice;
        } finally {
          activationPromise = null;
        }
      })();
      activationPromise = activating;
      return await activating;
    },

    scheduleSave(): void {
      if (!persisting) return;
      pendingSave = true;
      clearSaveTimer();
      saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
    },

    flush(): void {
      clearSaveTimer();
      detachExitListener();
      saveNow();
    },

    async flushStorage(): Promise<void> {
      if (!persisting) return;
      try {
        await saveStorageSidecar(options.storage, options.projectDir);
      } catch (error) {
        options.log(`storage persist failed: ${failureMessage(error)}`);
      }
    },

    release(): void {
      clearSaveTimer();
      detachExitListener();
      if (owner !== null) {
        owner.close();
        owner = null;
      }
    },
  };
}
