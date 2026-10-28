import { describe, expect, test } from 'bun:test';
import {
  blamedPackages,
  declaredRanges,
  failingTests,
  issueTitle,
  issueTitlePrefix,
  rewriteSpecifiers,
  selectVersion,
  type RegistryDocument,
} from './sdk-drift.ts';

const registry: RegistryDocument = {
  'dist-tags': { latest: '13.1.0', next: '13.2.0-beta.1' },
  versions: {
    '12.12.0': {},
    '12.13.0': {},
    '12.19.0': {},
    '12.20.0': { deprecated: 'published by mistake' },
    '12.21.0-canary.3f2a': {},
    '13.0.0': {},
    '13.1.0': {},
    '13.2.0-beta.1': {},
  },
};

describe('version selection', () => {
  test('in-range picks the newest stable, undeprecated release the range allows', () => {
    expect(selectVersion(registry, 'in-range', '^12.12.0')).toBe('12.19.0');
  });

  test('latest picks the dist-tag, even outside the declared range', () => {
    expect(selectVersion(registry, 'latest', '^12.12.0')).toBe('13.1.0');
  });

  test('in-range fails loudly when nothing satisfies the range', () => {
    expect(() => selectVersion(registry, 'in-range', '^14.0.0')).toThrow('^14.0.0');
  });

  test('latest fails loudly when the registry has no latest tag', () => {
    expect(() => selectVersion({ 'dist-tags': {}, versions: {} }, 'latest', '^12.0.0')).toThrow('latest');
  });
});

describe('declared ranges', () => {
  test('reads both SDK ranges from the pyric manifest', () => {
    expect(declaredRanges({
      devDependencies: { firebase: '^12.12.0', 'firebase-admin': '^13.0.0', typescript: '^5.7.0' },
    })).toEqual({ firebase: '^12.12.0', 'firebase-admin': '^13.0.0' });
  });

  test('fails when a range is missing', () => {
    expect(() => declaredRanges({ devDependencies: { firebase: '^12.12.0' } })).toThrow('firebase-admin');
  });
});

describe('specifier rewriting', () => {
  const versions = { firebase: '13.1.0', 'firebase-admin': '14.5.0' };

  test('rewrites only the two SDK specifiers, in every dependency section', () => {
    const manifest = {
      name: 'x',
      dependencies: { firebase: '^12.12.0', 'firebase-functions': '^7.2.5' },
      devDependencies: { 'firebase-admin': '^13.0.0', typescript: '^5.7.0' },
      optionalDependencies: { firebase: '~12.13.0' },
    };
    expect(rewriteSpecifiers(manifest, versions)).toEqual({
      name: 'x',
      dependencies: { firebase: '13.1.0', 'firebase-functions': '^7.2.5' },
      devDependencies: { 'firebase-admin': '14.5.0', typescript: '^5.7.0' },
      optionalDependencies: { firebase: '13.1.0' },
    });
  });

  test('keeps peer dependency ranges, which describe what users may install', () => {
    const manifest = { peerDependencies: { firebase: '>=12' }, devDependencies: { firebase: '^12.12.0' } };
    expect(rewriteSpecifiers(manifest, versions)).toEqual({
      peerDependencies: { firebase: '>=12' },
      devDependencies: { firebase: '13.1.0' },
    });
  });

  test('a $firebase override keeps pointing at the rewritten root specifier', () => {
    const root = {
      overrides: { firebase: '$firebase' },
      devDependencies: { firebase: '12.13.0', 'firebase-admin': '^13.0.0' },
    };
    const rewritten = rewriteSpecifiers(root, versions);
    expect(rewritten.overrides).toEqual({ firebase: '$firebase' });
    expect(rewritten.devDependencies).toEqual({ firebase: '13.1.0', 'firebase-admin': '14.5.0' });
  });

  test('a literal override moves with the rewrite, so it cannot pin the old version', () => {
    const root = { overrides: { firebase: '12.13.0', zod: '3.23.0' } };
    expect(rewriteSpecifiers(root, versions).overrides).toEqual({ firebase: '13.1.0', zod: '3.23.0' });
  });

  test('does not mutate its input', () => {
    const manifest = { devDependencies: { firebase: '^12.12.0' } };
    rewriteSpecifiers(manifest, versions);
    expect(manifest.devDependencies.firebase).toBe('^12.12.0');
  });
});

describe('failing test extraction', () => {
  test('lists bun test (fail) lines without color codes or timings', () => {
    const output = [
      '(pass) storage > uploads [1.20ms]',
      '\u001b[31m(fail)\u001b[0m firestore > orderBy rejects a missing field [12.34ms]',
      '(fail) auth > signIn keeps tenantId',
      ' 2 fail',
    ].join('\n');
    expect(failingTests(output)).toEqual([
      'firestore > orderBy rejects a missing field',
      'auth > signIn keeps tenantId',
    ]);
  });
});

describe('issue titles', () => {
  test('names the package and version', () => {
    expect(issueTitle('firebase', '13.1.0')).toBe('pyric fails against firebase 13.1.0');
  });

  test('the search prefix is shared by every release of one major', () => {
    expect(issueTitle('firebase', '13.4.2').startsWith(issueTitlePrefix('firebase', '13.1.0'))).toBe(true);
    expect(issueTitle('firebase', '14.0.0').startsWith(issueTitlePrefix('firebase', '13.1.0'))).toBe(false);
    expect(issueTitle('firebase-admin', '13.1.0').startsWith(issueTitlePrefix('firebase', '13.1.0'))).toBe(false);
  });
});

describe('blamed packages', () => {
  const ranges = { firebase: '^12.12.0', 'firebase-admin': '^13.0.0' };

  test('blames only the packages that left the declared range', () => {
    expect(blamedPackages({ firebase: '13.1.0', 'firebase-admin': '13.10.0' }, ranges)).toEqual(['firebase']);
  });

  test('blames both when both left the range, or when neither did', () => {
    expect(blamedPackages({ firebase: '13.1.0', 'firebase-admin': '14.5.0' }, ranges)).toEqual(['firebase', 'firebase-admin']);
    expect(blamedPackages({ firebase: '12.19.0', 'firebase-admin': '13.10.0' }, ranges)).toEqual(['firebase', 'firebase-admin']);
  });
});
