import { describe, expect, test } from 'bun:test';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';
import { probe as generateEnvelopeProbe } from '../../probes/ai/ai-sdk-generate-envelope-and-string-request.ts';
import { probe as functionCallsHelperProbe } from '../../probes/ai/ai-sdk-response-helpers-functioncalls.ts';
import { probe as structuredThinkingProbe } from '../../probes/ai/ai-sdk-structured-system-and-thinking.ts';

const AI_LIVE_WAVE2_PROBE_IDS = [
  'ai-sdk-generate-envelope-and-string-request',
  'ai-sdk-response-helpers-functioncalls',
  'ai-sdk-structured-system-and-thinking',
] as const;

describe('AI live client SDK generateContent, Schema, and response-helper probes (sdk-probes)', () => {
  test('registers staged live AI SDK probes with pendingRowLink and web-config requirement', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of AI_LIVE_WAVE2_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const stagedProbes = [
      generateEnvelopeProbe,
      functionCallsHelperProbe,
      structuredThinkingProbe,
    ];
    for (const probeRecord of stagedProbes) {
      expect(probeRecord.rig).toBe('sdk-probes');
      expect(probeRecord.requires).toEqual(['web-config']);
      expect(probeRecord.pendingRowLink).toBe(true);
      expect(probeRecord.matrixRow).toBe('');
      expect(probeRecord.rowIds).toEqual([]);
      expect(probeRecord.description.length).toBeGreaterThan(20);
    }

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );

    expectStagedUntilCaptured(AI_LIVE_WAVE2_PROBE_IDS, {
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
    for (const id of AI_LIVE_WAVE2_PROBE_IDS) {
      expect(lines.some((line) => line.includes(id))).toBe(true);
    }
  });
});
