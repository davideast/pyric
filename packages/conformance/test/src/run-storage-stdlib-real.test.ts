import { describe, expect, test } from 'bun:test';
import {
  injectProbeRules,
  storageStdlibRealProbeBlockDigest,
} from '../../src/run-storage-stdlib-real.ts';

describe('real-resource Storage stdlib rig source', () => {
  test('injects the bounded probe block only into the canonical Storage match', () => {
    const source = "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { } }";
    const injected = injectProbeRules(source, 'test-run', false);

    expect(injected).toContain('@pyric/storage-stdlib-real/test-run');
    expect(injected).toContain('/test-run/three/{id}');
    expect(storageStdlibRealProbeBlockDigest(false)).toHaveLength(64);
    expect(() => injectProbeRules("rules_version = '2';", 'test-run', false))
      .toThrow('lack canonical');
  });
});
