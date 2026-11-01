import { describe, expect, it } from 'bun:test';
import { STANDALONE_BROWSER_PROBES } from '../../../../src/capture/app-check/browser-probes.ts';
import { AI_REQUEST_BROWSER_PROBES, runProbes } from '../../../../src/capture/app-check/enforcement-guard.ts';

const AI_PROBE = 'app-check-client-get-token-before-initialize';
const NON_AI_PROBES = ['app-check-client-initialize-twice-unset-auto-refresh', 'app-check-client-get-token-concurrent'];

/** Records each step the dispatch takes, in order. */
function recordedRun(only: string[] | undefined, enforcementMode: string) {
  const steps: string[] = [];
  const run = runProbes({
    only,
    readEnforcement: async () => {
      steps.push('read-enforcement');
      return enforcementMode;
    },
    runSelected: async (names) => {
      steps.push(`selected:${names.join(',')}`);
    },
    runAll: async (mode) => {
      steps.push(`all:${mode}`);
    },
  });
  return { run, steps };
}

describe('App Check rig enforcement guard', () => {
  it('lists only standalone probes as AI-request probes', () => {
    const standalone: readonly string[] = STANDALONE_BROWSER_PROBES;
    expect(AI_REQUEST_BROWSER_PROBES.every((name) => standalone.includes(name))).toBe(true);
    expect(AI_REQUEST_BROWSER_PROBES).toContain(AI_PROBE);
  });

  it('reads enforcement before a selection that names an AI probe', async () => {
    const { run, steps } = recordedRun([...NON_AI_PROBES, AI_PROBE], 'UNENFORCED');
    await run;
    expect(steps).toEqual(['read-enforcement', `selected:${[...NON_AI_PROBES, AI_PROBE].join(',')}`]);
  });

  it('refuses a selection that names an AI probe while enforcement is on', async () => {
    const { run, steps } = recordedRun([AI_PROBE], 'ENFORCED');
    await expect(run).rejects.toThrow('enforcementMode is ENFORCED');
    expect(steps).toEqual(['read-enforcement']);
  });

  it('refuses a full run while enforcement is on', async () => {
    const { run, steps } = recordedRun(undefined, 'ENFORCED');
    await expect(run).rejects.toThrow('enforcementMode is ENFORCED');
    expect(steps).toEqual(['read-enforcement']);
  });

  it('passes the mode it read to a full run', async () => {
    const { run, steps } = recordedRun(undefined, 'OFF');
    await run;
    expect(steps).toEqual(['read-enforcement', 'all:OFF']);
  });

  it('skips the read for a selection that sends no AI request', async () => {
    const { run, steps } = recordedRun(NON_AI_PROBES, 'ENFORCED');
    await run;
    expect(steps).toEqual([`selected:${NON_AI_PROBES.join(',')}`]);
  });
});
