import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProbeObservationLinkage } from '../../src/observation-linkage.ts';
import { loadModularProbes } from '../../src/sdk-probes.ts';

const MODULAR_PROBE_RIGS = [
  'sdk-probes',
  'android-sdk-probes',
  'admin-auth',
  'admin-firestore',
  'ios-sdk-probes',
  'storage-admin',
  'messaging-send',
  'storage-stdlib-discovery',
] as const;

describe('modular probe observation envelope sync', () => {
  test('every committed modular probe observation matches the envelope fields written by --write', async () => {
    const mismatches: string[] = [];

    for (const rig of MODULAR_PROBE_RIGS) {
      const loaded = await loadModularProbes(rig);
      for (const item of loaded) {
        const obsPath = join(
          import.meta.dir,
          '..',
          '..',
          'observations',
          item.surfaceDir,
          `${item.id}.json`,
        );
        if (!existsSync(obsPath)) {
          continue;
        }
        const obs = JSON.parse(readFileSync(obsPath, 'utf8')) as {
          description?: unknown;
          matrixRow?: unknown;
          rowIds?: unknown;
        };
        const expectedLinkage = resolveProbeObservationLinkage(item.probe, obsPath);

        if (obs.description !== item.probe.description) {
          mismatches.push(
            `${item.surfaceDir}/${item.id}.json: description mismatch vs probes/${item.surfaceDir}/${item.id}.ts`,
          );
        }
        if (obs.matrixRow !== expectedLinkage.matrixRow) {
          mismatches.push(
            `${item.surfaceDir}/${item.id}.json: matrixRow mismatch (${String(obs.matrixRow)} !== ${expectedLinkage.matrixRow})`,
          );
        }
        if (JSON.stringify(obs.rowIds) !== JSON.stringify(expectedLinkage.rowIds)) {
          mismatches.push(
            `${item.surfaceDir}/${item.id}.json: rowIds mismatch (${JSON.stringify(obs.rowIds)} !== ${JSON.stringify(expectedLinkage.rowIds)})`,
          );
        }
      }
    }

    expect(mismatches).toEqual([]);
  });
});
