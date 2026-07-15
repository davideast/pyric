import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const PACKAGE_ROOT = join(import.meta.dir, '..', '..');
const CLI_ENTRY = join(PACKAGE_ROOT, 'src', 'cli', 'index.ts');
const REJECT_CONFORMANCE_PRELOAD = join(PACKAGE_ROOT, 'test', 'fixtures', 'reject-conformance-preload.ts');

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('bun', [CLI_ENTRY, ...args], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
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
        fidelity: 'diverged',
        assurance: 'ineligible',
      }],
    });
  });

  it('accepts both documented JSON flag positions', () => {
    for (const args of [
      ['can-i-use', 'getAfter', '--json=true'],
      ['can-i-use', '--json', 'getAfter'],
    ]) {
      const result = runCli(args);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ match: 'exact' });
    }
  });

  it('rejects unknown and invalid flags instead of silently printing human output', () => {
    for (const flag of ['--jsoon', '--json=banana']) {
      const result = runCli(['can-i-use', 'getAfter', flag]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('unknown option');
    }
  });

  it('returns the usage-error status when no feature name is provided', () => {
    const result = runCli(['can-i-use']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('provide a developer feature name');
  });

  it('returns a failing status for an unmatched JSON query', () => {
    const result = runCli(['can-i-use', 'featureThatDoesNotExistAnywhere', '--json']);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      query: 'featureThatDoesNotExistAnywhere',
      match: 'none',
      supports: [],
    });
  });

  it('labels fuzzy matches as suggestions and exits nonzero', () => {
    const result = runCli(['can-i-use', 'getDown']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('No exact conformance feature matched');
    expect(result.stdout).toContain('storage/getDownloadURL');
    expect(result.stdout).not.toContain('availability:');
  });

  it('rejects noncanonical spelling instead of returning a trust answer', () => {
    for (const query of [
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
    ]) {
      const result = runCli(['can-i-use', query, '--json']);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        match: 'suggestions',
        supports: [expect.objectContaining({ feature: 'getAfter' })],
      });
    }
  });

  it('shows ambiguous candidates but never returns a successful trust answer', () => {
    for (const [args, marker] of [
      [['can-i-use', 'get'], 'matches more than one surface'],
      [['can-i-use', 'get', '--json'], '"match":"ambiguous"'],
    ] as const) {
      const result = runCli(args);
      expect(result.code).toBe(1);
      expect(result.stdout).toContain(marker);
    }
  });

  it('keeps normalized multi-matches in discovery mode', () => {
    const result = runCli(['can-i-use', 'GET']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('No exact conformance feature matched');
    expect(result.stdout).not.toContain('availability:');
  });

  it('keeps feature discovery out of rules-fixture verification', () => {
    const result = runCli(['verify', 'can-i-use', 'getAfter', '--json']);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
  });
});
