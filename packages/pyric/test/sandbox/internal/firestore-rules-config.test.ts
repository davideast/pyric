/**
 * `firebase.json` `firestore` resolved as `firebase deploy` resolves it
 * (`getFirestoreConfig` in firebase-tools 15.24.0), #1315.
 */
import { describe, expect, test } from 'bun:test';
import {
  defaultFirestoreDatabase,
  firestoreRulesConfig,
  invalidFirestoreDatabaseWarnings,
  isValidFirestoreDatabaseConfigId,
  MAX_CONFIGURED_FIRESTORE_DATABASES,
  unservedFirestoreDatabaseWarnings,
} from '../../../src/sandbox/internal/firestore-rules-config.js';

describe('firestoreRulesConfig', () => {
  test('without a firestore key, firestore.rules goes to (default), unconfigured', () => {
    expect(firestoreRulesConfig(undefined)).toEqual({
      form: 'absent',
      databases: [{ database: '(default)', rulesFile: 'firestore.rules', label: 'firebase.json', configured: false }],
      unresolved: [],
    });
  });

  test('an object deploys its rules and indexes to (default)', () => {
    const config = firestoreRulesConfig({ rules: 'a.rules', indexes: 'a.indexes.json' });
    expect(config.databases).toEqual([
      { database: '(default)', rulesFile: 'a.rules', indexesFile: 'a.indexes.json', label: 'firebase.json firestore', configured: true },
    ]);
  });

  test('an object with a named database deploys to that named database and leaves (default) undeployed', () => {
    const config = firestoreRulesConfig({ database: 'reports', rules: 'reports.rules' });
    expect(config.databases.map((entry) => entry.database)).toEqual(['reports']);
    expect(defaultFirestoreDatabase(config)).toBeUndefined();
    expect(unservedFirestoreDatabaseWarnings(config)).toEqual([]);
  });

  test('an object with a named database and no rules declares it with no rulesFile and adds no firestore.rules fallback (#1452)', () => {
    const config = firestoreRulesConfig({ database: 'reports' });
    expect(defaultFirestoreDatabase(config)).toBeUndefined();
    expect(config.databases).toEqual([
      { database: 'reports', label: 'firebase.json firestore', configured: false },
    ]);
  });

  test('an object that names no rules serves no Firestore rules file, as firebase-tools deploys none (#1452)', () => {
    const config = firestoreRulesConfig({ indexes: 'firestore.indexes.json' });
    expect(defaultFirestoreDatabase(config)).toEqual({
      database: '(default)',
      indexesFile: 'firestore.indexes.json',
      label: 'firebase.json firestore',
      configured: false,
    });
    expect(firestoreRulesConfig({}).databases).toEqual([
      {
        database: '(default)',
        label: 'firebase.json firestore',
        configured: false,
      },
    ]);
  });

  test('array entries with database deploy to each database, in order', () => {
    const config = firestoreRulesConfig([
      { database: '(default)', rules: 'firestore.default.rules', indexes: 'default.indexes.json' },
      { database: 'reports', rules: 'reports.rules' },
    ], { resolveFile: (file) => `/p/${file}` });
    expect(config.databases).toEqual([
      { database: '(default)', rulesFile: '/p/firestore.default.rules', indexesFile: '/p/default.indexes.json', label: 'firebase.json firestore[0]', configured: true },
      { database: 'reports', rulesFile: '/p/reports.rules', label: 'firebase.json firestore[1]', configured: true },
    ]);
    expect(config.unresolved).toEqual([]);
  });

  test('an array gets no firestore.rules fallback for (default)', () => {
    const config = firestoreRulesConfig([{ database: 'reports', rules: 'reports.rules' }]);
    expect(defaultFirestoreDatabase(config)).toBeUndefined();
  });

  test('an array entry without rules declares its database with no rules file', () => {
    const config = firestoreRulesConfig([{ database: '(default)', indexes: 'i.json' }]);
    expect(defaultFirestoreDatabase(config)).toEqual({ database: '(default)', indexesFile: 'i.json', label: 'firebase.json firestore[0]', configured: false });
  });

  test('a target deploys to every database .firebaserc maps it to', () => {
    const config = firestoreRulesConfig([{ target: 'main', rules: 'main.rules' }], {
      targetDatabases: (target) => (target === 'main' ? ['(default)', 'reports'] : undefined),
    });
    expect(config.databases.map((entry) => [entry.database, entry.rulesFile])).toEqual([
      ['(default)', 'main.rules'],
      ['reports', 'main.rules'],
    ]);
  });

  test('target wins over database in one entry, as the CLI checks it first', () => {
    const config = firestoreRulesConfig([{ target: 'main', database: 'ignored', rules: 'main.rules' }], {
      targetDatabases: () => ['(default)'],
    });
    expect(config.databases.map((entry) => entry.database)).toEqual(['(default)']);
  });

  test('a target no mapping resolves is returned unresolved', () => {
    const config = firestoreRulesConfig([{ target: 'main', rules: 'main.rules', indexes: 'main.json' }]);
    expect(config.databases).toEqual([]);
    expect(config.unresolved).toEqual([{ target: 'main', label: 'firebase.json firestore[0]', rulesFile: 'main.rules', indexesFile: 'main.json' }]);
  });

  test('an entry with neither target nor database is refused with the CLI message', () => {
    expect(() => firestoreRulesConfig([{ database: '(default)', rules: 'a.rules' }, { rules: 'b.rules' }])).toThrow(
      'firebase.json firestore[1]: Must supply either "target" or "databaseId" in firestore config',
    );
  });

  test('two rules files for one database are refused, naming both entries', () => {
    expect(() => firestoreRulesConfig([
      { database: '(default)', rules: 'a.rules' },
      { database: '(default)', rules: 'b.rules' },
    ])).toThrow('firebase.json deploys two rules files to Firestore database "(default)": a.rules from firebase.json firestore[0] and b.rules from firebase.json firestore[1].');
  });

  test('a pyric rules override replaces the rules a target maps to (default), without a second entry', () => {
    const config = firestoreRulesConfig([
      { target: 'main', rules: 'a.rules' },
      { pyricRulesOverride: 'firestore.modules.rules' },
    ], { targetDatabases: (target) => (target === 'main' ? ['(default)'] : undefined) });
    expect(config.databases).toEqual([
      { database: '(default)', rulesFile: 'firestore.modules.rules', label: 'the pyric rules override', configured: true },
    ]);
  });

  test('a pyric rules override adds (default) when the array deploys nothing to it', () => {
    const config = firestoreRulesConfig([{ database: 'reports', rules: 'r.rules' }, { pyricRulesOverride: 'o.rules' }]);
    expect(defaultFirestoreDatabase(config)?.rulesFile).toBe('o.rules');
    expect(config.databases.map((entry) => entry.database)).toEqual(['reports', '(default)']);
  });

  test('the same rules file twice for one database is one deploy', () => {
    const config = firestoreRulesConfig([
      { database: 'reports', rules: 'a.rules' },
      { target: 't', rules: 'a.rules', indexes: 'i.json' },
    ], { targetDatabases: () => ['reports'] });
    expect(config.databases).toEqual([
      { database: 'reports', rulesFile: 'a.rules', indexesFile: 'i.json', label: 'firebase.json firestore[0]', configured: true },
    ]);
  });

  test('validates Firebase named-database naming rules and enforces the 100-database cap', () => {
    expect(isValidFirestoreDatabaseConfigId('(default)')).toBe(true);
    expect(isValidFirestoreDatabaseConfigId('reports-1')).toBe(true);
    expect(isValidFirestoreDatabaseConfigId('Bad_Id')).toBe(false);
    expect(isValidFirestoreDatabaseConfigId('-bad')).toBe(false);
    expect(isValidFirestoreDatabaseConfigId('bad-')).toBe(false);
    expect(isValidFirestoreDatabaseConfigId('abc')).toBe(false);
    expect(isValidFirestoreDatabaseConfigId('550e8400-e29b-41d4-a716-446655440000')).toBe(false);

    const hundredEntries = Array.from({ length: MAX_CONFIGURED_FIRESTORE_DATABASES }, (_, idx) => ({
      database: `db-${String(idx).padStart(3, '0')}`,
      rules: 'r.rules',
    }));
    expect(() => firestoreRulesConfig(hundredEntries)).toThrow(/exceeding the limit of 100 databases/);
  });
});

describe('unservedFirestoreDatabaseWarnings', () => {
  test('emits no warning for valid named databases, and warns on invalid ids and unresolved targets', () => {
    const config = firestoreRulesConfig([
      { database: '(default)', rules: 'firestore.default.rules' },
      { database: 'reports', rules: 'reports.rules' },
      { database: 'Bad_Id', rules: 'bad.rules' },
      { target: 'archive', rules: 'archive.rules' },
    ]);
    expect(invalidFirestoreDatabaseWarnings(config)).toEqual([
      'firebase.json firestore[2] deploys bad.rules to Firestore database "Bad_Id", which is not a valid Firestore database id (must be 4-63 lowercase letters, digits, or hyphens, starting with a letter, ending with a letter or digit, and not a UUID), so pyric does not declare or serve it.',
    ]);
    expect(unservedFirestoreDatabaseWarnings(config)).toEqual([
      'firebase.json firestore[2] deploys bad.rules to Firestore database "Bad_Id", which is not a valid Firestore database id (must be 4-63 lowercase letters, digits, or hyphens, starting with a letter, ending with a letter or digit, and not a UUID), so pyric does not declare or serve it.',
      'firebase.json firestore[3] deploys archive.rules to deploy target "archive", which .firebaserc does not map for this project, so pyric does not serve it.',
    ]);
  });

  test('no warnings for valid object or array forms', () => {
    expect(unservedFirestoreDatabaseWarnings(firestoreRulesConfig({ rules: 'a.rules' }))).toEqual([]);
    expect(unservedFirestoreDatabaseWarnings(firestoreRulesConfig({ database: 'reports', rules: 'a.rules' }))).toEqual([]);
    expect(unservedFirestoreDatabaseWarnings(firestoreRulesConfig([{ database: '(default)', rules: 'a.rules' }, { database: 'reports', rules: 'b.rules' }]))).toEqual([]);
  });
});
