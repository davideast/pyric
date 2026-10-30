/**
 * The order of an rtdb-rules capture (`capture()` in run-rules-rtdb.ts runs
 * these phases): ordinary deploy scenarios, operation scenarios, the restore
 * before the late phase, the large-ruleset deploy scenarios, the final restore
 * and cleanup with their checks, then the writes and the exit code. A late
 * failure keeps what was captured; anything earlier, or a failed check,
 * writes nothing.
 */
import { describe, expect, it } from 'bun:test';
import { restoreRulesBeforeLatePhase, runCapturePhases, type CapturePhases } from './rtdb-rules-capture-run.ts';
import type { DeployPhaseResult } from './rtdb-rules-deploy-run.ts';
import { deployScenario } from './rtdb-rules-deploy-fakes.ts';

const observation = (id: string) => ({ scenario: deployScenario(id), behavior: {} });
const phase = (result: Partial<DeployPhaseResult>): DeployPhaseResult => ({ observations: [], unanswered: [], ...result });

function recordingPhases(overrides: Partial<CapturePhases> = {}): CapturePhases & { events: string[] } {
  const events: string[] = [];
  const phases: CapturePhases = {
    earlyDeploys: async () => {
      events.push('early deploys');
      return phase({ observations: [observation('r29')] });
    },
    operations: async () => {
      events.push('operations');
      return [{ scenario: { id: 'r15', fm: 'rtdb#71', rationale: 'fixture' }, behavior: {} }];
    },
    restoreBeforeLate: async () => {
      events.push('restore before late');
    },
    lateDeploys: async () => {
      events.push('late deploys');
      return phase({ observations: [observation('r51')], unanswered: [{ id: 'r61', timeoutMs: 300_000 }] });
    },
    restoreAndCleanUp: async () => {
      events.push('final restore and cleanup');
    },
    assertClean: () => {
      events.push('clean check');
    },
    write: (o) => {
      events.push(`write ${o.scenario.id}`);
    },
    log: (line) => {
      events.push(line);
    },
  };
  return { ...phases, ...overrides, events };
}

/** Wraps a phase so the event log still records it. */
function failing(events: string[], name: string, error: Error): () => Promise<never> {
  return async () => {
    events.push(name);
    throw error;
  };
}

describe('rtdb-rules capture order', () => {
  it('restores, runs the late phase, cleans up, writes, then returns the exit code', async () => {
    const phases = recordingPhases();
    const exitCode = await runCapturePhases(phases);
    expect(exitCode).toBe(1);
    expect(phases.events.slice(0, 9)).toEqual([
      'early deploys',
      'operations',
      'restore before late',
      'late deploys',
      'final restore and cleanup',
      'clean check',
      'write r29',
      'write r15',
      'write r51',
    ]);
    expect(phases.events[9]).toMatch(/r61 produced no observation/);
  });

  it('ends zero when every scenario is answered', async () => {
    const phases = recordingPhases({ lateDeploys: async () => phase({ observations: [observation('r51')] }) });
    expect(await runCapturePhases(phases)).toBe(0);
  });

  it('keeps every observation from before a late-phase failure, names the failure, and ends non-zero', async () => {
    const phases = recordingPhases();
    phases.lateDeploys = async () => {
      phases.events.push('late deploys');
      return phase({ observations: [observation('r51')], failed: { id: 'r61', reason: 'dry run returned 503: x' } });
    };
    expect(await runCapturePhases(phases)).toBe(1);
    expect(phases.events).toContain('final restore and cleanup');
    expect(phases.events.filter((e) => e.startsWith('write '))).toEqual(['write r29', 'write r15', 'write r51']);
    expect(phases.events.at(-1)).toMatch(/r61 failed and produced no observation: dry run returned 503/);
  });

  it('writes nothing when the cleanup checks fail after a late-phase failure', async () => {
    const phases = recordingPhases({
      lateDeploys: async () => phase({ failed: { id: 'r61', reason: 'dry run returned 503: x' } }),
    });
    phases.assertClean = () => {
      throw new Error('restore invariant NOT verified');
    };
    await expect(runCapturePhases(phases)).rejects.toThrow(/restore invariant NOT verified/);
    expect(phases.events.some((e) => e.startsWith('write '))).toBe(false);
  });

  it('skips the late phase when the restore before it does not take, still cleans up, and writes nothing', async () => {
    const phases = recordingPhases();
    phases.restoreBeforeLate = failing(phases.events, 'restore before late', new Error('restore before the late phase did not take'));
    await expect(runCapturePhases(phases)).rejects.toThrow(/did not take/);
    expect(phases.events).toEqual(['early deploys', 'operations', 'restore before late', 'final restore and cleanup']);
  });

  it('cleans up and writes nothing when the operation scenarios fail', async () => {
    const phases = recordingPhases();
    phases.operations = failing(phases.events, 'operations', new Error('custom-token sign-in failed'));
    await expect(runCapturePhases(phases)).rejects.toThrow(/sign-in failed/);
    expect(phases.events).toEqual(['early deploys', 'operations', 'final restore and cleanup']);
  });

  it('cleans up and writes nothing when an ordinary deploy scenario fails', async () => {
    const phases = recordingPhases({
      earlyDeploys: async () => phase({ failed: { id: 'r29', reason: 'dry run returned 500: x' } }),
    });
    await expect(runCapturePhases(phases)).rejects.toThrow(/r29 failed: dry run returned 500/);
    expect(phases.events).toEqual(['final restore and cleanup']);
  });
});

describe('rtdb-rules restore before the late phase', () => {
  const BEFORE = { '.read': false, app: { '.read': 'auth != null' } };

  it('writes the pre-run rules and confirms them by reading back', async () => {
    const calls: string[] = [];
    let live: Record<string, unknown> = { ...BEFORE, mount: {} };
    await restoreRulesBeforeLatePhase(
      {
        writeRules: async (rules) => {
          calls.push('write');
          live = rules;
        },
        readRules: async () => {
          calls.push('read');
          return { app: { '.read': 'auth != null' }, '.read': false };
        },
      },
      BEFORE,
    );
    expect(calls).toEqual(['write', 'read']);
    expect(live).toEqual(BEFORE);
  });

  it('throws when the rules read back differ from the pre-run rules', async () => {
    const endpoint = {
      writeRules: async () => {},
      readRules: async () => ({ ...BEFORE, mount: { still: 'here' } }),
    };
    await expect(restoreRulesBeforeLatePhase(endpoint, BEFORE)).rejects.toThrow(
      /restore before the late phase did not take/,
    );
  });
});
