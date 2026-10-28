/**
 * Replays an RTDB SDK behavior scenario (`packages/conformance/src/capture/sdk-scenarios/rtdb/`)
 * against the in-page sandbox. Each client is its own signed-in handle on one
 * sandbox, as each production client was its own app on one instance. See
 * `replay-comparison.ts` for how pins hold both answers.
 */
import { expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import * as pyricDatabase from '../../../src/database/index.js';
import { setRules } from '../../../src/database/sandbox-controls.js';
import { loadObservation } from '../modular/cdd-replay-helpers.js';
import { replayTiming } from '../../../../conformance/src/capture/sdk-scenarios/scenario-timing.ts';
import { replayMismatches, type Behavior, type Replay } from '../../../../conformance/src/capture/sdk-scenarios/replay-comparison.ts';
import {
  SIGNED_IN_RULES,
  type DatabaseSdk,
  type RtdbScenario,
  type RtdbScenarioContext,
} from '../../../../conformance/src/capture/sdk-scenarios/scenario-types.ts';

export type { Pin } from '../../../../conformance/src/capture/sdk-scenarios/replay-comparison.ts';

/** The committed observation's behavior block. The observation gate looks for `obs('<name>')` calls. */
export const obs = (name: string): Behavior => loadObservation(name);

export function inPageContext(scenario: RtdbScenario): RtdbScenarioContext {
  const sandbox = initializeSandbox();
  setRules(sandbox, { rules: { pyric_oracle: { $run: scenario.rules ?? SIGNED_IN_RULES } } });
  const rtdb = pyricDatabase as unknown as DatabaseSdk;
  let clients = 0;
  const open = (name: string) => ({ db: rtdb.getDatabase(sandbox.withAuth({ uid: `${name}-${clients++}` }) as never) });
  return { ...replayTiming, rtdb, db: open('main').db, base: '/pyric_oracle/replay', newClient: async (name) => open(name) };
}

export function runInPage(scenario: RtdbScenario): Promise<Behavior> {
  return scenario.run(inPageContext(scenario));
}

export function expectReplay(replay: Replay): void {
  expect(replayMismatches(replay)).toEqual([]);
}
