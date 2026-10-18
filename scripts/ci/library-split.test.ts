import { describe, expect, test } from 'bun:test';
import rootManifest from '../../package.json';

// library-tests runs packages/pyric in two shards plus test:ci:libraries:rest,
// and the conformance suite runs in its own CI job; together they must equal
// the canonical serial chain, or a suite added to one form silently escapes the
// other.
describe('CI library split', () => {
  test('test:ci:libraries:core is exactly test:ci:libraries minus the conformance suite', () => {
    const scripts = rootManifest.scripts as Record<string, string>;
    const conformanceSegment = ' && bun test --cwd packages/conformance';
    expect(scripts['test:ci:libraries']).toContain(conformanceSegment);
    expect(scripts['test:ci:libraries:core']).not.toContain('packages/conformance');
    expect(scripts['test:ci:libraries'].replace(conformanceSegment, ''))
      .toBe(scripts['test:ci:libraries:core']);
  });

  test('test:ci:libraries:rest is exactly test:ci:libraries:core minus packages/pyric, which runs sharded', () => {
    const scripts = rootManifest.scripts as Record<string, string>;
    expect(`bun test --cwd packages/pyric && ${scripts['test:ci:libraries:rest']}`).toBe(scripts['test:ci:libraries:core']);
  });
});
