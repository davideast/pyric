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

const AI_LIVE_WAVE2_STAGED_PROBE_IDS: readonly string[] = [];

describe('AI live client SDK generateContent, Schema, and response-helper probes (sdk-probes)', () => {
  test('registers and links all 3 live AI SDK probes with web-config requirement', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of AI_LIVE_WAVE2_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    expect(generateEnvelopeProbe.rig).toBe('sdk-probes');
    expect(generateEnvelopeProbe.requires).toEqual(['web-config']);
    expect(generateEnvelopeProbe.pendingRowLink).toBeUndefined();
    expect(generateEnvelopeProbe.matrixRow).toBe('ai#generate-envelope-keys');
    expect(generateEnvelopeProbe.rowIds).toEqual([
      'ai#generate-candidate-keys',
      'ai#generate-envelope-keys',
      'ai#generate-finish-stop',
      'ai#generate-modelversion-responseid',
      'ai#generate-role-model',
      'ai#generate-string-request',
      'ai#generate-usage-key-set',
      'ai#generate-usage-service-tier',
      'ai#helper-text',
    ]);
    expect(generateEnvelopeProbe.description.length).toBeGreaterThan(20);

    expect(structuredThinkingProbe.rig).toBe('sdk-probes');
    expect(structuredThinkingProbe.requires).toEqual(['web-config']);
    expect(structuredThinkingProbe.pendingRowLink).toBeUndefined();
    expect(structuredThinkingProbe.matrixRow).toBe('ai#generate-structured-output');
    expect(structuredThinkingProbe.rowIds).toEqual([
      'ai#generate-structured-output',
      'ai#generate-system-instruction',
      'ai#generate-thinking-signature',
      'ai#helper-thoughtsummary',
      'ai#schema-rides-request',
    ]);
    expect(structuredThinkingProbe.description.length).toBeGreaterThan(20);

    expect(functionCallsHelperProbe.rig).toBe('sdk-probes');
    expect(functionCallsHelperProbe.requires).toEqual(['web-config']);
    expect(functionCallsHelperProbe.pendingRowLink).toBeUndefined();
    expect(functionCallsHelperProbe.matrixRow).toBe('ai#helper-functioncalls');
    expect(functionCallsHelperProbe.rowIds).toEqual(['ai#helper-functioncalls']);
    expect(functionCallsHelperProbe.description.length).toBeGreaterThan(20);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );
    for (const id of AI_LIVE_WAVE2_PROBE_IDS) {
      expect(unfilteredIds.has(id)).toBe(true);
    }

    expectStagedUntilCaptured(AI_LIVE_WAVE2_STAGED_PROBE_IDS, {
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
