/**
 * `firebase.json` `firestore` resolved as `firebase deploy` resolves it
 * (`getFirestoreConfig` in firebase-tools 15.24.0), #1315.
 */
import { describe, expect, test } from 'bun:test';
import {
  defaultFirestoreDatabase,
  firestoreRulesConfig,
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

  test('an object with a named database deploys to it, and pyric still serves its rules on (default)', () => {
    const config = firestoreRulesConfig({ database: 'reports', rules: 'reports.rules' });
    expect(config.databases.map((entry) => entry.database)).toEqual(['reports']);
    // Pyric enforced this file on (default) before it modeled named databases; it keeps doing so.
    expect(defaultFirestoreDatabase(config)?.rulesFile).toBe('reports.rules');
    expect(unservedFirestoreDatabaseWarnings(config)).toEqual([
      'firebase.json deploys reports.rules to Firestore database "reports". Pyric serves only (default) for now, so it enforces reports.rules on (default), and getFirestore(app, "reports") reads and writes (default). See https://github.com/davideast/pyric/issues/1314.',
    ]);
  });

  test('an object with a named database and no rules keeps the firestore.rules fallback', () => {
    expect(defaultFirestoreDatabase(firestoreRulesConfig({ database: 'reports' }))?.rulesFile).toBe('firestore.rules');
  });

  test('an object that names no rules keeps the firestore.rules fallback for (default)', () => {
    const config = firestoreRulesConfig({ indexes: 'firestore.indexes.json' });
    expect(defaultFirestoreDatabase(config)).toEqual({
      database: '(default)',
      rulesFile: 'firestore.rules',
      indexesFile: 'firestore.indexes.json',
      label: 'firebase.json',
      configured: false,
    });
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
});

describe('unservedFirestoreDatabaseWarnings', () => {
  test('one warning per named database and per unresolved target, none for (default)', () => {
    const config = firestoreRulesConfig([
      { database: '(default)', rules: 'firestore.default.rules' },
      { database: 'reports', rules: 'reports.rules' },
      { target: 'archive', rules: 'archive.rules' },
    ]);
    expect(unservedFirestoreDatabaseWarnings(config)).toEqual([
      'firebase.json deploys reports.rules to Firestore database "reports". Pyric serves only (default) for now, so getFirestore(app, "reports") reads and writes (default) under (default)\'s rules. See https://github.com/davideast/pyric/issues/1314.',
      'firebase.json firestore[2] deploys archive.rules to deploy target "archive", which .firebaserc does not map for this project, so pyric does not serve it. Pyric serves only (default) for now. See https://github.com/davideast/pyric/issues/1314.',
    ]);
  });

  test('no warnings for the object form or a (default)-only array', () => {
    expect(unservedFirestoreDatabaseWarnings(firestoreRulesConfig({ rules: 'a.rules' }))).toEqual([]);
    expect(unservedFirestoreDatabaseWarnings(firestoreRulesConfig([{ database: '(default)', rules: 'a.rules' }]))).toEqual([]);
  });
});
