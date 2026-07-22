import { describe, expect, test } from 'bun:test';
import {
  resolveStProbe,
  stProbeFor,
  stRun,
} from '../../src/rules-language-storage-capability.ts';

describe('Storage rules-language capability probes', () => {
  test('resolves expression probes with their requested operation', () => {
    const resolved = resolveStProbe({ expr: 'true', method: 'create' });

    expect('unprobeable' in resolved).toBe(false);
    if ('unprobeable' in resolved) return;
    expect(resolved.rules).toContain('allow create: if true;');
    expect(resolved.input.request.method).toBe('create');
  });

  test('classifies the added Storage collection and identity probes', () => {
    const constructs = ([
      { id: 'storage.method.map.keys', kind: 'method' },
      { id: 'storage.method.map.get', kind: 'method' },
      { id: 'storage.method.set.hasAll', kind: 'method' },
      { id: 'storage.binding.resource.generation', kind: 'binding' },
    ] as const).map((construct) => ({
      ...construct,
      engine: 'storage' as const,
      reference: 'https://firebase.google.com/docs/reference/rules',
      status: 'accepted' as const,
    }));

    for (const construct of constructs) {
      const probe = stProbeFor(construct);
      expect('unprobeable' in probe).toBe(false);
      expect(stRun(probe)).toEqual({ classification: 'implemented', detail: 'ALLOW' });
    }
  });

  test('keeps unmodeled noted bindings honest', () => {
    const probe = stProbeFor({
      id: 'storage.binding.resource.unmodeled',
      kind: 'binding',
      engine: 'storage',
      reference: 'https://firebase.google.com/docs/reference/rules',
      status: 'unprobeable',
      probeNote: 'Requires production context.',
      note: 'Production-only field.',
    });

    expect(probe).toEqual({
      unprobeable: 'resource.unmodeled is unmodeled by the standalone evaluator (reads undefined); a micro-scenario cannot distinguish unimplemented from implemented-but-absent. Production-only field.',
    });
  });
});
