/**
 * Build a verify session capture fixture from the live rules and state
 * currently active in a sandbox.
 *
 * Shared by the hosted/SharedWorker runtime (`serve/worker/serve-init.ts`) and
 * the in-page browser runtime (`serve/entries/runtime.ts`), so this module
 * stays strictly browser-safe (no Node built-ins).
 */
import type { Database } from 'pyric/database';
import { getDatabase, sandbox as rtdbSandbox } from 'pyric/database';
import { getActiveRules as getActiveDatabaseRules } from 'pyric/sandbox/database';
import type { Sandbox } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { getAdminStorageSandbox, getStorageRulesResolution } from 'pyric/storage/internal';
import {
  buildVerifyFixture,
  type BuildVerifyFixtureInput,
  type PyricVerifyFixture,
  type VerifyObservedCallValues,
} from '../verify/fixture.js';
import { captureRtdbInstances, defaultInstanceUrl } from '../verify/rtdb-instance-capture.js';

export interface LiveSessionCaptureOptions {
  sandbox: Sandbox;
  defaultDatabase?: Database;
  defaultInstance?: string;
  authState: {
    users: unknown[];
    currentUser: unknown;
  };
  capturedBy?: string;
  observedCalls?: Record<string, VerifyObservedCallValues>;
}

/** Snapshot active Firestore, RTDB, and Storage rules alongside current sandbox state. */
export function buildLiveSessionCaptureFixture(
  options: LiveSessionCaptureOptions,
): PyricVerifyFixture {
  const { sandbox } = options;
  const rawFirestoreRules = getInternalEnv(sandbox).getRules();
  const firestoreRules = rawFirestoreRules === '' ? null : rawFirestoreRules;

  const defaultDatabase = options.defaultDatabase ?? getDatabase(sandbox);
  const rtdbRules = getActiveDatabaseRules(defaultDatabase);
  const hasRtdbHistory = sandbox.history().some((event) => event.service === 'rtdb');
  let rtdbState: ReturnType<typeof rtdbSandbox.snapshotState> | undefined;
  if (rtdbRules !== null || hasRtdbHistory) {
    rtdbState = rtdbSandbox.snapshotState(defaultDatabase, { includePriorities: true });
  }

  const storageResolution = getStorageRulesResolution(getAdminStorageSandbox(sandbox));
  let storageRules: string | null = null;
  if (storageResolution !== null) {
    storageRules = storageResolution.source;
  }

  const input: BuildVerifyFixtureInput = {
    sandbox,
    firestoreRules,
    rtdbRules,
    rtdbState,
    rtdbDatabaseUrl: defaultInstanceUrl(options.defaultInstance),
    rtdbInstances: captureRtdbInstances(sandbox, options.defaultInstance),
    storageRules,
    authState: options.authState,
  };
  if (options.capturedBy !== undefined) {
    input.capturedBy = options.capturedBy;
  }
  if (options.observedCalls !== undefined) {
    input.observedCalls = options.observedCalls;
  }
  return buildVerifyFixture(input);
}
