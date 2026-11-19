import { describe, expect, test } from 'bun:test';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';
import { probe as chatErrorsAbortProbe } from '../../probes/ai/ai-offline-chat-roles-errors-and-abort.ts';
import { probe as initBackendsProbe } from '../../probes/ai/ai-offline-init-backends-and-model-guards.ts';
import { probe as schemaBuildersProbe } from '../../probes/ai/ai-offline-schema-builders-and-guards.ts';

const AI_OFFLINE_SLICE12_PROBE_IDS = [
  'ai-offline-chat-roles-errors-and-abort',
  'ai-offline-init-backends-and-model-guards',
  'ai-offline-schema-builders-and-guards',
] as const;

const AI_OFFLINE_STAGED_PROBE_IDS = [
  'ai-offline-chat-roles-errors-and-abort',
  'ai-offline-init-backends-and-model-guards',
] as const;

describe('AI offline zero-network client SDK probes (sdk-probes)', () => {
  test('registers staged offline AI probes with pendingRowLink and links ai-offline-schema-builders-and-guards', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of AI_OFFLINE_SLICE12_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const stagedProbes = [initBackendsProbe, chatErrorsAbortProbe];
    for (const probeRecord of stagedProbes) {
      expect(probeRecord.rig).toBe('sdk-probes');
      expect(probeRecord.requires).toEqual([]);
      expect(probeRecord.pendingRowLink).toBe(true);
      expect(probeRecord.matrixRow).toBe('');
      expect(probeRecord.rowIds).toEqual([]);
      expect(probeRecord.description.length).toBeGreaterThan(20);
    }

    expect(schemaBuildersProbe.rig).toBe('sdk-probes');
    expect(schemaBuildersProbe.requires).toEqual([]);
    expect(schemaBuildersProbe.pendingRowLink).toBeUndefined();
    expect(schemaBuildersProbe.matrixRow).toBe('ai#schema-object-tojson');
    expect(schemaBuildersProbe.rowIds).toEqual([
      'ai#schema-object-tojson',
      'ai#schema-string-enum',
      'ai#schema-primitives',
      'ai#schema-anyof',
    ]);
    expect(schemaBuildersProbe.description.length).toBeGreaterThan(20);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );
    expect(unfilteredIds.has('ai-offline-schema-builders-and-guards')).toBe(true);

    expectStagedUntilCaptured(AI_OFFLINE_STAGED_PROBE_IDS, {
      rig: 'sdk-probes',
      filterFlag: '--probe',
      filterValueFor: (name) => name,
      whenUncaptured(name) {
        expect(unfilteredIds.has(name)).toBe(false);
      },
      whenCaptured(name) {
        expect(unfilteredIds.has(name)).toBe(true);
      },
    });

    const lines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => lines.push(line),
    });
    for (const id of AI_OFFLINE_SLICE12_PROBE_IDS) {
      expect(lines.some((line) => line.includes(id))).toBe(true);
    }
  });

  test('executes all 3 offline AI probes deterministically across runs with fetchCalls === 0', async () => {
    const initRun1 = (await initBackendsProbe.observe()) as { fetchCalls: number };
    const initRun2 = (await initBackendsProbe.observe()) as { fetchCalls: number };
    expect(initRun1).toEqual(initRun2);
    expect(initRun1.fetchCalls).toBe(0);

    const chatRun1 = (await chatErrorsAbortProbe.observe()) as { fetchCalls: number };
    const chatRun2 = (await chatErrorsAbortProbe.observe()) as { fetchCalls: number };
    expect(chatRun1).toEqual(chatRun2);
    expect(chatRun1.fetchCalls).toBe(0);

    const schemaRun1 = (await schemaBuildersProbe.observe()) as { fetchCalls: number };
    const schemaRun2 = (await schemaBuildersProbe.observe()) as { fetchCalls: number };
    expect(schemaRun1).toEqual(schemaRun2);
    expect(schemaRun1.fetchCalls).toBe(0);
  });
});
