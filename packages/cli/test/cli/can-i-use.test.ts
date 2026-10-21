import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { CLI_ENTRY, PACKAGE_ROOT, runCli, runDispatch } from './run-cli.js';

const REJECT_CONFORMANCE_PRELOAD = join(PACKAGE_ROOT, 'test', 'fixtures', 'reject-conformance-preload.ts');

// Each child `bun` process costs about a second at idle, so these tests spawn
// the real entry once per behavior and check the remaining inputs through the
// same parser and dispatcher in this process (#1166).

const NONCANONICAL_SPELLINGS = [
  'getafter',
  'GETAFTER',
  'get-after',
  'get_after',
  'getAfter(not canonical)',
  'Firestore-Rules/getAfter',
  'firestore_rules/getAfter',
  'firestore-rules:getAfter',
  ' getAfter',
  'getAfter ',
  'firestore-rules/ getAfter',
  'firestore-rules/getAfter ',
] as const;

function expectNoncanonicalRejection(result: { code: number; stdout: string }): void {
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    match: 'suggestions',
    supports: [expect.objectContaining({ feature: 'getAfter' })],
  });
}

function expectUnknownOption(result: { code: number; stdout: string; stderr: string }): void {
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('unknown option');
}

describe('can-i-use command', () => {
  it('keeps the generated conformance table off the real source --help module graph', () => {
    const result = spawnSync('bun', ['--preload', REJECT_CONFORMANCE_PRELOAD, CLI_ENTRY, '--help'], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('eager conformance query import');
  });

  it('reports feature support using the same three trust axes', () => {
    const result = runCli(['can-i-use', 'getAfter', '--json']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      match: 'exact',
      supports: [{
        feature: 'getAfter',
        availability: 'available',
        fidelity: 'conforms',
        assurance: 'eligible',
      }],
    });
  });

  it('accepts both documented JSON flag positions', async () => {
    for (const args of [
      ['can-i-use', 'getAfter', '--json=true'],
      ['can-i-use', '--json', 'getAfter'],
    ]) {
      const result = await runDispatch(args);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ match: 'exact' });
    }
  });

  it('rejects an unknown flag from the real CLI entry instead of printing human output', () => {
    expectUnknownOption(runCli(['can-i-use', 'getAfter', '--jsoon']));
  });

  it('rejects unknown and invalid flags instead of silently printing human output', async () => {
    for (const flag of ['--jsoon', '--json=banana']) {
      expectUnknownOption(await runDispatch(['can-i-use', 'getAfter', flag]));
    }
  });

  it('returns the usage-error status when no feature name is provided', async () => {
    const result = await runDispatch(['can-i-use']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('provide a developer feature name');
  });

  it('returns a failing status for an unmatched JSON query', async () => {
    const result = await runDispatch(['can-i-use', 'featureThatDoesNotExistAnywhere', '--json']);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      query: 'featureThatDoesNotExistAnywhere',
      match: 'none',
      supports: [],
    });
  });

  it('labels fuzzy matches as suggestions and exits nonzero', async () => {
    const result = await runDispatch(['can-i-use', 'getDown']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('No exact conformance feature matched');
    expect(result.stdout).toContain('storage/getDownloadURL');
    expect(result.stdout).not.toContain('availability:');
  });

  it('rejects a noncanonical spelling from the real CLI entry instead of returning a trust answer', () => {
    expectNoncanonicalRejection(runCli(['can-i-use', 'firestore-rules/getAfter ', '--json']));
  });

  it('rejects every noncanonical spelling instead of returning a trust answer', async () => {
    for (const query of NONCANONICAL_SPELLINGS) {
      expectNoncanonicalRejection(await runDispatch(['can-i-use', query, '--json']));
    }
  });

  it('shows ambiguous candidates but never returns a successful trust answer', async () => {
    for (const [args, marker] of [
      [['can-i-use', 'get'], 'matches more than one surface'],
      [['can-i-use', 'get', '--json'], '"match":"ambiguous"'],
    ] as const) {
      const result = await runDispatch([...args]);
      expect(result.code).toBe(1);
      expect(result.stdout).toContain(marker);
    }
  });

  it('keeps normalized multi-matches in discovery mode', async () => {
    const result = await runDispatch(['can-i-use', 'GET']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('No exact conformance feature matched');
    expect(result.stdout).not.toContain('availability:');
  });

  it('keeps feature discovery out of rules-fixture verification', async () => {
    const result = await runDispatch(['verify', 'can-i-use', 'getAfter', '--json']);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
  });
});
