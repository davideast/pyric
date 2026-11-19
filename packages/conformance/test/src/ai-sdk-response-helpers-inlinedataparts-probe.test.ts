import { describe, expect, test } from 'bun:test';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';
import { probe as inlineDataPartsProbe } from '../../probes/ai/ai-sdk-response-helpers-inlinedataparts.ts';

const PROBE_ID = 'ai-sdk-response-helpers-inlinedataparts';

describe('AI live client SDK inlineDataParts response-helper probe (sdk-probes)', () => {
  test('registers as a staged pendingRowLink sdk-probe with web-config requirement', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    expect(loadedIds).toContain(PROBE_ID);

    expect(inlineDataPartsProbe.rig).toBe('sdk-probes');
    expect(inlineDataPartsProbe.requires).toEqual(['web-config']);
    expect(inlineDataPartsProbe.pendingRowLink).toBe(true);
    expect(inlineDataPartsProbe.matrixRow).toBe('');
    expect(inlineDataPartsProbe.rowIds).toEqual([]);
    expect(inlineDataPartsProbe.description.length).toBeGreaterThan(20);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );

    expectStagedUntilCaptured([PROBE_ID], {
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
    expect(lines.some((line) => line.includes(PROBE_ID))).toBe(true);
  });
});
