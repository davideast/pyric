import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDatabaseIndexesGenerate } from '../../src/cli/database-indexes.js';
import { parseArgs } from '../../src/cli/parse-args.js';
import { runDispatch } from './run-cli.js';

const tempDirs: string[] = [];

function createTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-cli-db-idx-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('pyric database indexes generate', () => {
  test('returns usage exit code 1 when source path is omitted', async () => {
    let err = '';
    const code = await runDatabaseIndexesGenerate(
      { subcommand: 'database', positional: [], flags: new Map() },
      { stderr: { write: (s) => { err += s; } }, stdout: { write: () => {} } },
    );
    expect(code).toBe(1);
    expect(err).toContain('missing source path');
  });

  test('merges extracted .indexOn into database.rules.json without clobbering existing rules', async () => {
    const root = createTempProject();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'firebase.json'),
      JSON.stringify({ database: { rules: 'database.rules.json' } }),
    );
    writeFileSync(
      join(root, 'database.rules.json'),
      JSON.stringify(
        {
          rules: {
            orgs: {
              $orgId: {
                '.read': 'auth != null',
                members: {
                  '.write': 'auth != null',
                },
              },
            },
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(root, 'src', 'app.ts'),
      `
        import { get, orderByChild, orderByValue, query, ref } from 'firebase/database';
        declare const db: unknown;
        export function listMembers(orgId: string) {
          return Promise.all([
            get(query(ref(db, \`orgs/\${orgId}/members\`), orderByChild('role'))),
            get(query(ref(db, 'ranks/daily'), orderByValue())),
          ]);
        }
      `,
    );

    let stdout = '';
    let stderr = '';
    const parsed = parseArgs(['database', 'indexes', 'generate', 'src']);
    const code = await runDatabaseIndexesGenerate(
      { ...parsed, positional: parsed.positional.slice(2) },
      {
        cwd: root,
        stdout: { write: (s) => { stdout += s; } },
        stderr: { write: (s) => { stderr += s; } },
      },
    );
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('wrote');

    const written = JSON.parse(readFileSync(join(root, 'database.rules.json'), 'utf8')) as {
      rules: Record<string, unknown>;
    };
    const orgs = written.rules.orgs as Record<string, unknown>;
    const wildcardOrg = orgs.$orgId as Record<string, unknown>;
    expect(wildcardOrg['.read']).toBe('auth != null');
    expect((wildcardOrg.members as Record<string, unknown>)['.write']).toBe('auth != null');
    expect((wildcardOrg.members as Record<string, unknown>)['.indexOn']).toEqual(['role']);
    expect(((written.rules.ranks as Record<string, unknown>).daily as Record<string, unknown>)['.indexOn']).toBe('.value');
  });

  test('--check exits 2 with AssuranceDiagnostics on missing or shadowed .indexOn and exits 0 after generation', async () => {
    const root = createTempProject();
    mkdirSync(join(root, 'src'), { recursive: true });
    const rulesFile = join(root, 'database.rules.json');
    const originalRules = JSON.stringify(
      {
        rules: {
          orgs: {
            $orgId: {
              members: {
                '.indexOn': ['role'],
              },
            },
            featured: {
              '.read': true,
            },
          },
        },
      },
      null,
      2,
    );
    writeFileSync(rulesFile, originalRules);
    writeFileSync(
      join(root, 'src', 'app.ts'),
      `
        import { get, orderByChild, query, ref } from 'firebase/database';
        declare const db: unknown;
        export function listOrgRoles(orgId: string) {
          return get(query(ref(db, 'orgs/' + orgId + '/members'), orderByChild('role')));
        }
      `,
    );

    const failing = await runDispatch([
      'database',
      'indexes',
      'generate',
      '--check',
      join(root, 'src'),
      '--rules',
      rulesFile,
      '--json',
    ]);
    expect(failing.code).toBe(2);
    expect(readFileSync(rulesFile, 'utf8')).toBe(originalRules);

    const payload = JSON.parse(failing.stdout) as {
      ok: boolean;
      diagnostics: Array<{ code: string; service: string; certainty: string; ruleSite?: { source: string } }>;
    };
    expect(payload.ok).toBe(false);
    expect(payload.diagnostics).toHaveLength(1);
    expect(payload.diagnostics[0]).toMatchObject({
      code: 'rtdb-missing-index-on',
      service: 'rtdb',
      certainty: 'static-proof',
      ruleSite: { source: '/orgs/featured/members' },
    });

    const generateRes = await runDispatch([
      'database',
      'indexes',
      'generate',
      join(root, 'src'),
      '--rules',
      rulesFile,
    ]);
    expect(generateRes.code).toBe(0);

    const passing = await runDispatch([
      'database',
      'indexes',
      'generate',
      join(root, 'src'),
      '--rules',
      rulesFile,
      '--check',
    ]);
    expect(passing.code).toBe(0);
  });

  test('supports --instance with multi-instance firebase.json database array', async () => {
    const root = createTempProject();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'firebase.json'),
      JSON.stringify({
        database: [
          { instance: 'main-db', rules: 'main.rules.json' },
          { instance: 'audit-db', rules: 'audit.rules.json' },
        ],
      }),
    );
    writeFileSync(join(root, 'main.rules.json'), JSON.stringify({ rules: {} }));
    writeFileSync(join(root, 'audit.rules.json'), JSON.stringify({ rules: {} }));
    writeFileSync(
      join(root, 'src', 'multi.ts'),
      `
        import { get, getDatabase, orderByChild, query, ref } from 'firebase/database';
        declare const app: unknown;
        const mainDb = getDatabase(app, 'https://main-db.firebaseio.com');
        const auditDb = getDatabase(app, 'https://audit-db.firebaseio.com');
        export function runBoth() {
          return Promise.all([
            get(query(ref(mainDb, 'posts'), orderByChild('createdAt'))),
            get(query(ref(auditDb, 'logs'), orderByChild('ts'))),
          ]);
        }
      `,
    );

    let out = '';
    const parsed = parseArgs(['database', 'indexes', 'generate', 'src', '--instance', 'audit-db']);
    const code = await runDatabaseIndexesGenerate(
      { ...parsed, positional: parsed.positional.slice(2) },
      {
        cwd: root,
        stdout: { write: (s) => { out += s; } },
        stderr: { write: () => {} },
      },
    );
    expect(code).toBe(0);
    expect(out).toContain('audit.rules.json');

    const mainRules = JSON.parse(readFileSync(join(root, 'main.rules.json'), 'utf8')) as {
      rules: Record<string, unknown>;
    };
    const auditRules = JSON.parse(readFileSync(join(root, 'audit.rules.json'), 'utf8')) as {
      rules: Record<string, unknown>;
    };
    expect(mainRules.rules).toEqual({});
    expect((auditRules.rules.logs as Record<string, unknown>)['.indexOn']).toEqual(['ts']);
  });

  test('preserves JSONC comments on no-op in-place runs and includes default getDatabase() queries when --rules and --instance name the default instance', async () => {
    const root = createTempProject();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, '.firebaserc'),
      JSON.stringify({ projects: { default: 'demo-proj' } }),
    );
    writeFileSync(
      join(root, 'firebase.json'),
      JSON.stringify({
        database: [{ instance: 'demo-proj-default-rtdb', rules: 'database.rules.json' }],
      }),
    );
    const jsoncRules = `{\n  // Keep this header comment intact\n  "rules": {\n    "posts": {\n      ".read": true,\n      ".indexOn": ["createdAt"]\n    }\n  }\n}\n`;
    writeFileSync(join(root, 'database.rules.json'), jsoncRules);
    writeFileSync(
      join(root, 'src', 'posts.ts'),
      `
        import { get, getDatabase, orderByChild, query, ref } from 'firebase/database';
        const db = getDatabase();
        export const recentPosts = () => get(query(ref(db, 'posts'), orderByChild('createdAt')));
      `,
    );

    const parsed = parseArgs([
      'database',
      'indexes',
      'generate',
      'src',
      '--rules',
      'database.rules.json',
      '--instance',
      'demo-proj-default-rtdb',
    ]);
    const code = await runDatabaseIndexesGenerate(
      { ...parsed, positional: parsed.positional.slice(2) },
      {
        cwd: root,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      },
    );
    expect(code).toBe(0);
    expect(readFileSync(join(root, 'database.rules.json'), 'utf8')).toBe(jsoncRules);

    const outCopy = join(root, 'out.rules.json');
    const parsedOut = parseArgs([
      'database',
      'indexes',
      'generate',
      'src',
      '--rules',
      'database.rules.json',
      '--instance',
      'demo-proj-default-rtdb',
      '--out',
      'out.rules.json',
    ]);
    const codeOut = await runDatabaseIndexesGenerate(
      { ...parsedOut, positional: parsedOut.positional.slice(2) },
      {
        cwd: root,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      },
    );
    expect(codeOut).toBe(0);
    const parsedWritten = JSON.parse(readFileSync(outCopy, 'utf8')) as {
      rules: { posts: { '.indexOn': string[] } };
    };
    expect(parsedWritten.rules.posts['.indexOn']).toEqual(['createdAt']);
  });
});
