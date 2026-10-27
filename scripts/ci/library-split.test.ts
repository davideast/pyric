import { describe, expect, test } from 'bun:test';
import rootManifest from '../../package.json';

// library-tests runs packages/pyric in two shards plus test:ci:libraries:rest,
// the conformance suite runs in its own CI job, and the CLI suite in its own;
// together they must equal the canonical serial chain, test:serial, which
// `bun run test` runs through scripts/test-all.ts, or a suite added to one form
// silently escapes the other.
describe('CI library split', () => {
  test('test:ci:libraries is exactly test:serial minus the CLI suite, which runs as test:ci:cli', () => {
    const scripts = rootManifest.scripts as Record<string, string>;
    const cliSegment = ' && bun test --cwd packages/cli';
    expect(scripts['test:serial']).toContain(cliSegment);
    expect(scripts['test:serial'].replace(cliSegment, '')).toBe(scripts['test:ci:libraries']);
    expect(scripts['test:ci:cli']).toBe(cliSegment.slice(' && '.length));
  });

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
