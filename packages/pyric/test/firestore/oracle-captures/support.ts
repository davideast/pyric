/**
 * Replays an SDK behavior scenario (`packages/conformance/src/capture/sdk-scenarios/`)
 * against the in-page sandbox and compares the result with the production
 * observation the same scenario captured. See `replay-comparison.ts` for how
 * pins hold both answers.
 */
import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import * as pyricFirestore from '../../../src/firestore/index.js';
import { replayTiming } from '../../../../conformance/src/capture/sdk-scenarios/scenario-timing.ts';
import { replayMismatches, type Behavior, type Replay } from '../../../../conformance/src/capture/sdk-scenarios/replay-comparison.ts';
import type {
  FirestoreScenario,
  FirestoreScenarioContext,
  FirestoreSdk,
} from '../../../../conformance/src/capture/sdk-scenarios/scenario-types.ts';

export { CACHED_INITIAL_SNAPSHOT, withoutMessages, type Pin } from '../../../../conformance/src/capture/sdk-scenarios/replay-comparison.ts';

const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', 'conformance', 'observations', 'firestore');

/** The oracle project's rules: signed-in access under the run namespace, nothing else. */
export const ORACLE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /pyric_oracle/{run}/{doc=**} { allow read, write: if request.auth != null; }
    match /{document=**} { allow read, write: if false; }
  }
}`;

/** The committed observation's behavior block. */
export function load(name: string): Behavior {
  return JSON.parse(readFileSync(join(OBS_DIR, `${name}.json`), 'utf8')).behavior as Behavior;
}

/** A scenario context over a fresh in-page sandbox with the oracle rules. */
export function inPageContext(): FirestoreScenarioContext {
  const sandbox = initializeSandbox();
  setRules(sandbox, ORACLE_RULES);
  const fs = pyricFirestore as unknown as FirestoreSdk;
  const open = (uid: string) => ({ db: fs.getFirestore(sandbox.withAuth({ uid }) as never) });
  return {
    ...replayTiming,
    fs,
    db: open('main').db,
    base: 'pyric_oracle/replay',
    deniedDocPath: 'pyric_oracle_denied_replay/x',
    newClient: async (name) => open(name),
  };
}

export function expectReplay(replay: Replay): void {
  expect(replayMismatches(replay)).toEqual([]);
}

export async function runInPage(scenario: FirestoreScenario, ctx: FirestoreScenarioContext = inPageContext()): Promise<Behavior> {
  return scenario.run(ctx);
}
