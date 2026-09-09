/**
 * Fake provider. Replays a canned transcript against the real headless server
 * over stdio, so the seeding, spawning, logging, scoring and reporting path can
 * be exercised end to end without a model.
 *
 * The transcript is supplied by whoever schedules the run rather than by the
 * corpus record, because it is a property of the test harness and not of the
 * task the corpus states.
 */
import { join } from 'node:path';
import type { EvalRun, Invocation } from '../types.js';
import { serverEntry } from './server-env.js';

export const FAKE_PLAN_FILE = 'fake-plan.json';

/** One canned call. The tool name is whatever the variant under test renders. */
export interface FakeCall {
  tool: string;
  args: Record<string, unknown>;
}

/** The plan file the replay client reads. */
export interface FakePlan {
  server: { command: string; args: string[]; env: Record<string, string> };
  transcript: FakeCall[];
}

/** Path of the replay client this provider spawns. Injectable for tests. */
export const FAKE_CLIENT = join(import.meta.dirname, 'fake-client.ts');

export function buildInvocation(run: EvalRun): Invocation {
  const transcript = run.fakeTranscript ?? [];
  const plan: FakePlan = { server: serverEntry(run), transcript };
  return {
    // The plan is passed by path, so it lives in the run directory and the
    // workspace the client is started in stays empty.
    command: ['bun', FAKE_CLIENT, join(run.dir, FAKE_PLAN_FILE)],
    env: {},
    files: { [FAKE_PLAN_FILE]: `${JSON.stringify(plan, null, 2)}\n` },
    workspaceFiles: {},
  };
}

export default buildInvocation;
