/**
 * Replays SDK behavior scenarios (`packages/conformance/src/capture/sdk-scenarios/`)
 * through the served worker client and a real host over the fake port pair,
 * and compares the result with the production observation. The Node host runs
 * the same host and client code over a socket. See `replay-comparison.ts` for
 * how pins hold both answers.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setRules } from 'pyric/sandbox/firestore';
import * as ipDatabase from 'pyric/database';
import * as client from '../../../../src/serve/worker/index.js';
import { readDocumentAs, readQueryAs } from '../../../../src/serve/worker/client/firestore-reads.js';
import { setDatabaseRules } from '../../../../src/serve/worker/host/rules.js';
import { connectClientToHost, makeHostCtx, sleep } from '../integration-support.js';
import { replayTiming } from '../../../../../conformance/src/capture/sdk-scenarios/scenario-timing.ts';
import { replayMismatches, type Behavior, type Replay } from '../../../../../conformance/src/capture/sdk-scenarios/replay-comparison.ts';
import type {
  DatabaseSdk,
  FirestoreScenarioContext,
  FirestoreSdk,
  RtdbScenarioContext,
} from '../../../../../conformance/src/capture/sdk-scenarios/scenario-types.ts';

export { withoutMessages, type Pin } from '../../../../../conformance/src/capture/sdk-scenarios/replay-comparison.ts';

const OBSERVATIONS = join(import.meta.dir, '..', '..', '..', '..', '..', 'conformance', 'observations');

/** The committed observation's behavior block. */
export function load(name: string): Behavior {
  const surface = name.startsWith('rtdb-modular-') ? 'rtdb-modular' : 'firestore';
  return JSON.parse(readFileSync(join(OBSERVATIONS, surface, `${name}.json`), 'utf8')).behavior as Behavior;
}

/** Frames cross the fake ports on macrotasks; give each wait time to drain. */
const servedTiming = { ...replayTiming, wait: () => sleep(150) };

const OPEN_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

/** connectClientToHost swaps in a fake SharedWorker; put the real one back after each test. */
export function restoreSharedWorker(): void {
  let previous: unknown;
  beforeEach(() => { previous = (globalThis as { SharedWorker?: unknown }).SharedWorker; });
  afterEach(() => { (globalThis as { SharedWorker?: unknown }).SharedWorker = previous; });
}

export async function servedFirestoreContext(): Promise<FirestoreScenarioContext> {
  const ctx = await makeHostCtx();
  setRules(ctx.sandbox, OPEN_FIRESTORE_RULES);
  // The served entry routes these two reads through the worker client (entries/firestore-surface.ts).
  const fs = {
    ...client,
    getDocFromServer: (ref: Parameters<typeof readDocumentAs>[0]) => readDocumentAs(ref, 'getDocFromServer'),
    getDocsFromServer: (source: Parameters<typeof readQueryAs>[0]) => readQueryAs(source, 'getDocsFromServer'),
  } as unknown as FirestoreSdk;
  const open = (name: string) => ({ db: connectClientToHost(ctx, `worker://capture-${name}-${Math.random()}`).db as never });
  return {
    ...servedTiming,
    fs,
    db: open('main').db,
    base: 'pyric_oracle/replay',
    deniedDocPath: 'pyric_oracle_denied_replay/x',
    newClient: async (name) => open(name),
  };
}

/** The worker client's RTDB functions under their modular names, as the served entry exports them. */
function databaseSdk(): DatabaseSdk {
  const named: Record<string, unknown> = {};
  const prefix = 'rtdb';
  for (const [key, value] of Object.entries(client)) {
    if (!key.startsWith(prefix) || typeof value !== 'function') continue;
    const name = key.slice(prefix.length);
    named[name.charAt(0).toLowerCase() + name.slice(1)] = value;
  }
  // The served entry builds queries with pyric/database over worker refs (entries/database-surface.ts).
  const constraints = ['query', 'orderByValue', 'orderByKey', 'orderByPriority', 'limitToFirst', 'limitToLast', 'startAt', 'endAt', 'endBefore'] as const;
  for (const name of constraints) named[name] = ipDatabase[name];
  return named as unknown as DatabaseSdk;
}

export async function servedRtdbContext(): Promise<RtdbScenarioContext> {
  const ctx = await makeHostCtx();
  setDatabaseRules(ctx, undefined, { rules: { '.read': true, '.write': true } });
  const rtdb = databaseSdk();
  const open = (name: string) => ({ db: rtdb.getDatabase(connectClientToHost(ctx, `worker://capture-${name}-${Math.random()}`).db as never) });
  return { ...servedTiming, rtdb, db: open('main').db, base: '/pyric_oracle/replay', newClient: async (name) => open(name) };
}

export function expectReplay(replay: Replay): void {
  expect(replayMismatches(replay)).toEqual([]);
}
