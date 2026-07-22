import { describe, expect, test } from 'bun:test';
import {
  crossServiceRules,
  storageStdlibRemainingProbeBlockDigest,
} from '../../src/run-storage-stdlib-remaining.ts';

describe('remaining cross-service Storage probe rules', () => {
  test('keeps named-database and project-isolation cases in one bounded block', () => {
    const rules = crossServiceRules('test-run');

    expect(rules).toContain('/databases/(default)/documents/');
    expect(rules).toContain('/databases/probes/documents/');
    expect(rules).toContain('/test-run/isolation/{id}');
    expect(storageStdlibRemainingProbeBlockDigest()).toHaveLength(64);
  });
});
