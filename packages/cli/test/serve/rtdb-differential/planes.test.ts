import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPrivateJobTmpDir,
  JOB_TMP_MARKER,
  removePrivateJobTmpDir,
} from '../../../../../scripts/lib/private-job-tmpdir.ts';
import { createPlaneRunner } from './differential.js';
import { generateSequence } from './generator.js';
import { portPair, tick } from './served-plane.js';

describe('RTDB differential private scratch storage and Node plane isolation', () => {
  test('Node plane isolates SQLite state inside PYRIC_TEST_TMP_ROOT, reaps stale markers, and never touches OS tmpdir', async () => {
    const outerEnv: NodeJS.ProcessEnv = { ...process.env };
    const dedicatedTmp = createPrivateJobTmpDir('rtdb-ut-root', outerEnv);
    const readOnlyOsTmp = createPrivateJobTmpDir('rtdb-ut-ostmp', outerEnv);
    const staleChild = join(dedicatedTmp, 'rtdb-stale-dead');
    mkdirSync(staleChild);
    writeFileSync(join(staleChild, JOB_TMP_MARKER), '2147483646\n');
    expect(existsSync(staleChild)).toBe(true);
    chmodSync(readOnlyOsTmp, 0o555);

    const runnerEnv: NodeJS.ProcessEnv = {
      ...outerEnv,
      PYRIC_TEST_TMP_ROOT: dedicatedTmp,
      TMPDIR: readOnlyOsTmp,
      TMP: readOnlyOsTmp,
      TEMP: readOnlyOsTmp,
    };

    try {
      const runner = await createPlaneRunner({ chunks: 1, env: runnerEnv });
      try {
        expect(existsSync(staleChild)).toBe(false);
        const activeEntries = readdirSync(dedicatedTmp).filter((name) => name !== JOB_TMP_MARKER);
        expect(activeEntries).toHaveLength(1);
        const runnerDirName = activeEntries[0];
        expect(runnerDirName).toBeDefined();
        if (runnerDirName === undefined) {
          throw new Error('Expected active runner scratch directory');
        }
        expect(runnerDirName.startsWith('rtdb-diff-')).toBe(true);
        expect(existsSync(join(dedicatedTmp, runnerDirName, JOB_TMP_MARKER))).toBe(true);

        const outcomes = await runner.run('node', [generateSequence(1, { minSteps: 6, maxSteps: 6 })]);
        expect(outcomes).toHaveLength(1);
        const firstOutcome = outcomes[0];
        expect(firstOutcome).toBeDefined();
        if (firstOutcome === undefined) {
          throw new Error('Expected one sequence outcome');
        }
        expect('fatal' in firstOutcome).toBe(false);
        expect(readdirSync(dedicatedTmp).filter((name) => name !== JOB_TMP_MARKER)).toEqual([runnerDirName]);
        expect(readdirSync(readOnlyOsTmp)).toEqual([JOB_TMP_MARKER]);
      } finally {
        runner.dispose();
      }
      expect(readdirSync(dedicatedTmp)).toEqual([JOB_TMP_MARKER]);
    } finally {
      chmodSync(readOnlyOsTmp, 0o755);
      expect(removePrivateJobTmpDir(readOnlyOsTmp, outerEnv)).toBe(true);
      expect(removePrivateJobTmpDir(dedicatedTmp, outerEnv)).toBe(true);
    }
  }, 60_000);

  test('portPair delivers structured-cloned messages asynchronously in FIFO order', async () => {
    const { page, host } = portPair();
    const received: Array<{ seq: number; items: string[] }> = [];
    let synchronousDelivery = false;

    host.onmessage = (event) => {
      received.push(event.data as { seq: number; items: string[] });
    };

    const first = { seq: 1, items: ['a'] };
    page.postMessage(first);
    first.items.push('mutated-after-send');
    page.postMessage({ seq: 2, items: ['b'] });
    page.postMessage({ seq: 3, items: ['c'] });

    if (received.length > 0) synchronousDelivery = true;
    await Promise.resolve();
    if (received.length > 0) synchronousDelivery = true;

    await tick();
    expect(synchronousDelivery).toBe(false);
    expect(received).toEqual([
      { seq: 1, items: ['a'] },
      { seq: 2, items: ['b'] },
      { seq: 3, items: ['c'] },
    ]);
  });
});
