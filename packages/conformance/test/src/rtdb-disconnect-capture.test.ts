import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupAfterRulesProbe,
  createRtdbDisconnectProbes,
  runProbeCleanup,
  type RtdbDisconnectContext,
} from '../../src/capture/rtdb-disconnect/probes.ts';

const context = {
  config: {
    apiKey: 'test',
    appId: 'test',
    projectId: 'test-project',
    databaseURL: 'https://test-project.invalid',
  },
  serviceAccount: {
    client_email: 'test@example.invalid',
    private_key: 'not-a-key',
    project_id: 'test-project',
  },
  rtdbAdminToken: 'test-token',
  runId: 'test-run',
} satisfies RtdbDisconnectContext;

const observationDir = join(import.meta.dir, '..', '..', 'observations', 'rtdb-modular');

describe('RTDB disconnect capture descriptors', () => {
  it('regenerates the linkage recorded by every committed disconnect observation', () => {
    const probes = createRtdbDisconnectProbes(context);
    const observationFiles = readdirSync(observationDir)
      .filter((name) => name.startsWith('rtdb-modular-ondisconnect-') && name.endsWith('.json'));

    expect(probes.map(({ name }) => `${name}.json`).toSorted()).toEqual(observationFiles.toSorted());
    for (const probe of probes) {
      const observation = JSON.parse(
        readFileSync(join(observationDir, `${probe.name}.json`), 'utf8'),
      ) as { matrixRow: string; rowIds: string[] };
      expect(
        { matrixRow: probe.matrixRow, rowIds: probe.rowIds },
        probe.name,
      ).toEqual({ matrixRow: observation.matrixRow, rowIds: observation.rowIds });
    }
  });
});

describe('RTDB rules probe cleanup', () => {
  it('attempts every cleanup after an earlier cleanup failure', async () => {
    const calls: string[] = [];
    await expect(runProbeCleanup([
      async () => {
        calls.push('close');
        throw new Error('close failed');
      },
      async () => {
        calls.push('remove');
      },
    ])).rejects.toThrow('close failed');
    expect(calls).toEqual(['close', 'remove']);
  });

  it('attempts every cleanup and still restores and verifies rules after a cleanup failure', async () => {
    const calls: string[] = [];
    await expect(cleanupAfterRulesProbe(
      [
        async () => {
          calls.push('close');
          throw new Error('close failed');
        },
        async () => {
          calls.push('remove');
        },
      ],
      async () => {
        calls.push('restore');
      },
      async () => {
        calls.push('verify');
      },
    )).rejects.toThrow('close failed');
    expect(calls).toEqual(['close', 'remove', 'restore', 'verify']);
  });
});
