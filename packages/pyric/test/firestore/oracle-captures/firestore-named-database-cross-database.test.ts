import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { seedDocuments, setRules, snapshotDocuments } from 'pyric/sandbox/firestore';
import { doc, getDoc, getFirestore } from 'pyric/firestore';
import { expectReplay, load } from './support.ts';

interface CrossDatabaseObservationFile {
  readonly diagnostics: {
    readonly conditions: Readonly<Record<string, string>>;
    readonly isolation: {
      readonly defaultValue: string;
      readonly probesValue: string;
      readonly defaultHasProbesOnly: boolean;
      readonly probesHasDefaultOnly: boolean;
    };
  };
}

const OBS_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'firestore',
  'firestore-named-database-cross-database.json',
);

function errorCodeOf(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const raw = (err as { code?: unknown }).code;
    if (typeof raw === 'string') return raw;
  }
  return 'unknown';
}

describe('Firestore named-database cross-database rules oracle capture (ADR-0021 C2)', () => {
  it('replays every deployed-rule case in firestore-named-database-cross-database (firestore#MD4)', async () => {
    const production = load('firestore-named-database-cross-database');
    const raw = JSON.parse(readFileSync(OBS_PATH, 'utf8')) as CrossDatabaseObservationFile;

    const runId = 'replay_c2';
    const base = `__pyric_named_db_c2/${runId}`;
    const sandbox = initializeSandbox({ projectId: 'demo-named-db-c2' });

    try {
      const caseMatches: string[] = [];
      for (const [caseName, template] of Object.entries(raw.diagnostics.conditions)) {
        const condition = template.replaceAll('<run>', runId);
        caseMatches.push(
          `    match /t/${caseName} {\n      allow get: if ${condition};\n    }`,
        );
      }
      const probesRules = [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        ...caseMatches,
        '    match /{document=**} { allow read, write: if false; }',
        '  }',
        '}',
      ].join('\n');

      setRules(sandbox, probesRules, 'probes');
      seedDocuments(sandbox, {
        [base]: { v: 'default' },
        [`${base}/only/default`]: { side: 'default' },
      });
      seedDocuments(
        sandbox,
        {
          [base]: { v: 'probes' },
          [`${base}/only/probes`]: { side: 'probes' },
        },
        'probes',
      );

      const defaultSnap = snapshotDocuments(sandbox);
      const probesSnap = snapshotDocuments(sandbox, 'probes');
      expect({
        defaultValue: (defaultSnap[base] as { v?: unknown } | undefined)?.v,
        probesValue: (probesSnap[base] as { v?: unknown } | undefined)?.v,
        defaultHasProbesOnly: Object.hasOwn(defaultSnap, `${base}/only/probes`),
        probesHasDefaultOnly: Object.hasOwn(probesSnap, `${base}/only/default`),
      }).toEqual(raw.diagnostics.isolation);

      const probesClient = getFirestore(sandbox.withAuth(null), 'probes');
      const actual: Record<string, string> = {};
      for (const caseName of Object.keys(raw.diagnostics.conditions)) {
        try {
          await getDoc(doc(probesClient, `t/${caseName}`));
          actual[caseName] = 'allowed';
        } catch (err) {
          actual[caseName] = errorCodeOf(err);
        }
      }

      expectReplay({ production, pyric: actual });
    } finally {
      sandbox.dispose();
    }
  });
});
