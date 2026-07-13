import { describe, expect, test } from 'bun:test';
import { validateEntryPath, packageToCensusSurface, type EntryPathCensusRow, type EntryPathValidationInput } from './entry-path-validate.ts';
import type { CriticalSymbolsReport } from './entry-path-symbols.ts';
import type { ExpectedFailureRecord } from '../entry-path/types.ts';

/** A minimal, valid base input every test tweaks — keeps each case's diff small. */
function baseInput(): EntryPathValidationInput {
  const census: EntryPathCensusRow[] = [
    { surface: 'auth', mapped: ['getAuth', 'onAuthStateChanged', 'signInWithPopup'], unmapped: ['getApps'] },
    { surface: 'app', mapped: ['initializeApp'], unmapped: ['getApps'] },
  ];
  const criticalSymbols: CriticalSymbolsReport = {
    generatedAt: new Date().toISOString(),
    packages: {
      'pyric/auth': { symbols: ['getAuth', 'onAuthStateChanged'], programs: ['auth'] },
      'pyric/app': { symbols: ['initializeApp'], programs: ['auth'] },
    },
  };
  return {
    criticalSymbols,
    expectedFailures: [],
    census,
    ledgerRowStatuses: new Map([
      ['auth#99', 'unverified'],
      ['auth#100', 'conforms'],
    ]),
    programNames: ['auth', 'firestore', 'database', 'storage'],
  };
}

describe('packageToCensusSurface', () => {
  test('derives package -> census surface from the real surface descriptors', () => {
    const map = packageToCensusSurface();
    expect(map.get('pyric/auth')).toBe('auth');
    expect(map.get('pyric/firestore')).toBe('firestore');
    expect(map.get('pyric/database')).toBe('database');
    expect(map.get('pyric/storage')).toBe('storage');
    expect(map.get('pyric/app')).toBe('app');
    // pyric/sandbox has no upstream firebase module — no census surface.
    expect(map.has('pyric/sandbox')).toBe(false);
  });
});

describe('validateEntryPath — critical symbols', () => {
  test('a fully census-mapped corpus with no expected-failures is clean', () => {
    expect(validateEntryPath(baseInput())).toEqual([]);
  });

  test('an unmapped critical symbol with no citation is fatal', () => {
    const input = baseInput();
    input.criticalSymbols.packages['pyric/app'].symbols.push('getApps');
    const problems = validateEntryPath(input);
    expect(problems.some((p) => p.includes("critical symbol 'getApps'") && p.includes('no expected-failure citation'))).toBe(true);
  });

  test('an unmapped critical symbol covered by a matching unmapped-symbol citation is clean', () => {
    const input = baseInput();
    input.criticalSymbols.packages['pyric/app'].symbols.push('getApps');
    const record: ExpectedFailureRecord = {
      program: 'auth',
      reason: 'app surface mid-climb',
      fixedBy: 'the app climb',
      gap: { kind: 'unmapped-symbol', surface: 'app', symbol: 'getApps' },
    };
    input.expectedFailures = [record];
    expect(validateEntryPath(input)).toEqual([]);
  });

  test('a citation for a DIFFERENT program than the one using the symbol does not cover it', () => {
    const input = baseInput();
    input.criticalSymbols.packages['pyric/app'].symbols.push('getApps');
    const record: ExpectedFailureRecord = {
      program: 'storage', // 'auth' is the program that actually imports pyric/app's getApps here
      reason: 'unrelated',
      fixedBy: 'unrelated',
      gap: { kind: 'unmapped-symbol', surface: 'app', symbol: 'getApps' },
    };
    input.expectedFailures = [record];
    const problems = validateEntryPath(input);
    expect(problems.some((p) => p.includes("critical symbol 'getApps'"))).toBe(true);
  });

  test('pyric/sandbox symbols (no census surface) are never flagged', () => {
    const input = baseInput();
    input.criticalSymbols.packages['pyric/sandbox'] = { symbols: ['initializeSandbox'], programs: ['auth'] };
    expect(validateEntryPath(input)).toEqual([]);
  });
});

describe('validateEntryPath — expected-failure citation validity', () => {
  test('an unmapped-symbol citation naming a symbol that is NOT actually unmapped is stale (fatal)', () => {
    const input = baseInput();
    input.expectedFailures = [
      { program: 'auth', reason: 'r', fixedBy: 'f', gap: { kind: 'unmapped-symbol', surface: 'auth', symbol: 'getAuth' } },
    ];
    const problems = validateEntryPath(input);
    expect(problems.some((p) => p.includes('stale citation'))).toBe(true);
  });

  test('a denylist-deferred citation naming a real deferred deny-list entry is valid', () => {
    const input = baseInput();
    // 'multiFactor' is a real, currently-deferred auth deny-list entry
    // (surface-denylist.ts) — see the MFA / phone / reCAPTCHA group.
    //
    // This fixture used to name 'linkWithCredential'. The auth resolver climb
    // MIRRORED account linking, so that symbol is no longer deferred and the
    // citation went stale — which is exactly the failure this suite exists to
    // catch, caught on itself. Any symbol used here must be one the deny-list
    // still actually defers.
    input.expectedFailures = [
      { program: 'auth', reason: 'r', fixedBy: 'f', gap: { kind: 'denylist-deferred', surface: 'auth', symbol: 'multiFactor' } },
    ];
    expect(validateEntryPath(input).some((p) => p.includes('multiFactor'))).toBe(false);
  });

  test('a denylist-deferred citation naming a symbol that is NOT deferred is stale (fatal)', () => {
    const input = baseInput();
    input.expectedFailures = [
      { program: 'auth', reason: 'r', fixedBy: 'f', gap: { kind: 'denylist-deferred', surface: 'auth', symbol: 'signInWithPopup' } },
    ];
    const problems = validateEntryPath(input);
    expect(problems.some((p) => p.includes('stale citation'))).toBe(true);
  });

  test('an unverified-row citation naming a row that is currently unverified is valid', () => {
    const input = baseInput();
    input.expectedFailures = [
      { program: 'auth', reason: 'r', fixedBy: 'f', gap: { kind: 'unverified-row', rowId: 'auth#99' } },
    ];
    expect(validateEntryPath(input)).toEqual([]);
  });

  test('an unverified-row citation naming a row that is now conforms is stale (fatal)', () => {
    const input = baseInput();
    input.expectedFailures = [
      { program: 'auth', reason: 'r', fixedBy: 'f', gap: { kind: 'unverified-row', rowId: 'auth#100' } },
    ];
    const problems = validateEntryPath(input);
    expect(problems.some((p) => p.includes('stale citation'))).toBe(true);
  });

  test('an unverified-row citation naming a row that no longer exists is stale (fatal)', () => {
    const input = baseInput();
    input.expectedFailures = [
      { program: 'auth', reason: 'r', fixedBy: 'f', gap: { kind: 'unverified-row', rowId: 'auth#does-not-exist' } },
    ];
    const problems = validateEntryPath(input);
    expect(problems.some((p) => p.includes('MISSING'))).toBe(true);
  });

  test('a record naming an unknown program is fatal', () => {
    const input = baseInput();
    input.expectedFailures = [
      { program: 'messaging', reason: 'r', fixedBy: 'f', gap: { kind: 'unverified-row', rowId: 'auth#99' } },
    ];
    const problems = validateEntryPath(input);
    expect(problems.some((p) => p.includes("no entry-path program named 'messaging'"))).toBe(true);
  });

  test('two records for the same program is fatal', () => {
    const input = baseInput();
    input.expectedFailures = [
      { program: 'auth', reason: 'r', fixedBy: 'f', gap: { kind: 'unverified-row', rowId: 'auth#99' } },
      { program: 'auth', reason: 'r2', fixedBy: 'f2', gap: { kind: 'unverified-row', rowId: 'auth#99' } },
    ];
    const problems = validateEntryPath(input);
    expect(problems.some((p) => p.includes('duplicate expected-failure record'))).toBe(true);
  });

  test('missing reason / fixedBy are each fatal', () => {
    const input = baseInput();
    input.expectedFailures = [
      { program: 'auth', reason: '', fixedBy: '', gap: { kind: 'unverified-row', rowId: 'auth#99' } },
    ];
    const problems = validateEntryPath(input);
    expect(problems.some((p) => p.includes('missing reason'))).toBe(true);
    expect(problems.some((p) => p.includes('missing fixedBy'))).toBe(true);
  });
});
