import { describe, expect, test } from 'bun:test';
import rootManifest from '../../package.json';

// library-tests runs test:ci:libraries:core and the conformance suite runs in
// its own CI job; together they must equal the canonical serial chain, or a
// suite added to one form silently escapes the other.
describe('CI library split', () => {
  test('test:ci:libraries:core is exactly test:ci:libraries minus the conformance suite', () => {
    const scripts = rootManifest.scripts as Record<string, string>;
    const conformanceSegment = ' && bun test --cwd packages/conformance';
    expect(scripts['test:ci:libraries']).toContain(conformanceSegment);
    expect(scripts['test:ci:libraries:core']).not.toContain('packages/conformance');
    expect(scripts['test:ci:libraries'].replace(conformanceSegment, ''))
      .toBe(scripts['test:ci:libraries:core']);
  });
});
