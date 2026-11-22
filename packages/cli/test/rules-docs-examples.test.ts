/**
 * Regression coverage for #1351 (FS2-CON-8): extracts and runs the TypeScript
 * code blocks from the three Rules documentation guides (`rules-standard-library.md`,
 * `simulate-and-lint.md`, and `read-a-denial.md`) and checks that each block
 * runs against the current public API and prints what the page documents.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveModules } from 'pyric/rules/internal/node';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const SECURE_DOCS = join(REPO_ROOT, 'packages/site-docs/src/content/secure');

interface FenceBlock {
  lang: string;
  source: string;
}

function extractFences(markdownPath: string): FenceBlock[] {
  const lines = readFileSync(markdownPath, 'utf8').split('\n');
  const out: FenceBlock[] = [];
  let current: { lang: string; body: string[] } | null = null;
  for (const line of lines) {
    if (current === null) {
      const match = /^```([A-Za-z0-9_-]*)\s*$/.exec(line);
      if (match) {
        current = { lang: match[1]!.toLowerCase(), body: [] };
      }
      continue;
    }
    if (/^```\s*$/.test(line)) {
      out.push({ lang: current.lang, source: current.body.join('\n') });
      current = null;
      continue;
    }
    current.body.push(line);
  }
  return out;
}

function resolveWorkspaceSpecifiers(source: string): string {
  return source.replace(
    /from\s+(['"])(pyric(?:\/[^'"]+)?)\1/g,
    (_full, quote: string, specifier: string) => {
      const resolvedUrl = import.meta.resolve(specifier);
      return `from ${quote}${resolvedUrl}${quote}`;
    },
  );
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function freshScratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-rules-docs-'));
  tempDirs.push(dir);
  return dir;
}

let moduleSeq = 0;
async function runSnippetInCwd(
  cwd: string,
  tsSource: string,
): Promise<{ logs: unknown[][]; exitCode: number | null }> {
  moduleSeq += 1;
  const runnerPath = join(cwd, `doc-snippet-${process.pid}-${moduleSeq}.ts`);
  const logs: unknown[][] = [];
  let exitCode: number | null = null;
  const prevCwd = process.cwd();
  const prevLog = console.log;
  const prevWarn = console.warn;
  const prevExit = process.exit;

  writeFileSync(runnerPath, resolveWorkspaceSpecifiers(tsSource), 'utf8');
  try {
    process.chdir(cwd);
    console.log = (...args: unknown[]) => {
      logs.push(args);
    };
    console.warn = () => {};
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`__DOC_EXIT_${exitCode}__`);
    }) as typeof process.exit;

    try {
      await import(pathToFileURL(runnerPath).href);
    } catch (err) {
      if (!(err instanceof Error && err.message.startsWith('__DOC_EXIT_'))) {
        throw err;
      }
    }
  } finally {
    process.exit = prevExit;
    console.warn = prevWarn;
    console.log = prevLog;
    process.chdir(prevCwd);
    rmSync(runnerPath, { force: true });
  }
  return { logs, exitCode };
}

describe('Rules documentation examples execute as written (#1351)', () => {
  test('rules-standard-library.md resolves its posts ruleset and simulates the cooldown update cleanly', async () => {
    const fences = extractFences(join(SECURE_DOCS, 'rules-standard-library.md'));
    const rulesFences = fences.filter((fence) => fence.lang === 'rules');
    const tsFences = fences.filter((fence) => fence.lang === 'ts');
    expect(tsFences).toHaveLength(1);

    const resolved = resolveModules(rulesFences[0]!.source, { targetService: 'cloud.firestore' });
    expect(resolved.success).toBe(true);
    if (!resolved.success) return;

    const dir = freshScratchDir();
    writeFileSync(join(dir, 'firestore.rules'), resolved.data.resolved, 'utf8');

    const { exitCode } = await runSnippetInCwd(dir, tsFences[0]!.source);
    expect(exitCode).toBeNull();
  });

  test('simulate-and-lint.md runs every TypeScript example and prints the documented traces', async () => {
    const fences = extractFences(join(SECURE_DOCS, 'simulate-and-lint.md'));
    const tsFences = fences.filter((fence) => fence.lang === 'ts');
    const plainFences = fences.filter((fence) => fence.lang === '');
    expect(tsFences).toHaveLength(9);

    const dir = freshScratchDir();
    writeFileSync(
      join(dir, 'database.rules.json'),
      JSON.stringify({
        rules: {
          '.read': false,
          '.write': false,
          rooms: {
            $roomId: {
              chat: {
                '.read':
                  "auth != null && root.child('rooms').child($roomId).child('members').child(auth.uid).val() === true",
              },
            },
          },
        },
      }),
      'utf8',
    );
    writeFileSync(
      join(dir, 'firebase.json'),
      JSON.stringify({
        database: [
          { instance: 'demo-app-default-rtdb', rules: 'database.rules.json' },
          { instance: 'demo-app-shard-1', rules: 'database.rules.json' },
        ],
      }),
      'utf8',
    );

    // Blocks 1, 2 & 3: Firestore simulate + explainCase + lint(source) + error gate
    const firestoreImports = [
      `import { explainCase, firestoreRules, lint } from 'pyric/rules';`,
      tsFences[0]!.source.replace(/^import .*\n/gm, ''),
      tsFences[1]!.source.replace(/^import .*\n/gm, ''),
      tsFences[2]!.source
        .replace(/\bconst errors =/, 'const lintErrors =')
        .replace(/\berrors\.length\b/, 'lintErrors.length'),
    ].join('\n');
    const fsRun = await runSnippetInCwd(dir, firestoreImports);
    expect(fsRun.exitCode).toBeNull();
    expect(String(fsRun.logs[0]?.[0])).toBe(plainFences[0]!.source);

    // Block 4: Storage rules simulate
    const storageRun = await runSnippetInCwd(
      dir,
      `${tsFences[3]!.source}\nif (result.passed !== 1 || result.failed !== 0) process.exit(1);\n`,
    );
    expect(storageRun.exitCode).toBeNull();

    // Block 5: rtdbRules from database.rules.json
    const rtdbFileRun = await runSnippetInCwd(dir, tsFences[4]!.source);
    expect(rtdbFileRun.exitCode).toBeNull();

    // Blocks 6 & 7: RTDB simulate + trace printout
    const rtdbTraceRun = await runSnippetInCwd(
      dir,
      `${tsFences[5]!.source}\n${tsFences[6]!.source}\n`,
    );
    expect(rtdbTraceRun.exitCode).toBeNull();
    expect(rtdbTraceRun.logs.map((row) => String(row[0])).join('\n')).toBe(plainFences[3]!.source);

    // Blocks 8 & 9: rtdbRules.fromFirebaseJson + rules.lint()
    const rtdbInstancesRun = await runSnippetInCwd(
      dir,
      `${tsFences[7]!.source}\n${tsFences[8]!.source}\nif (cases[0]?.passed !== true) process.exit(1);\n`,
    );
    expect(rtdbInstancesRun.exitCode).toBeNull();
  });

  test('read-a-denial.md runs its standalone and context-backed TypeScript examples cleanly', async () => {
    const fences = extractFences(join(SECURE_DOCS, 'read-a-denial.md'));
    const tsFences = fences.filter((fence) => fence.lang === 'ts');
    const plainFences = fences.filter((fence) => fence.lang === '');
    expect(tsFences).toHaveLength(5);

    const dir = freshScratchDir();

    // Block 1: Firestore sandbox.onEvent denial listener
    const fsEventRun = await runSnippetInCwd(
      dir,
      [
        `import { initializeSandbox } from 'pyric/sandbox';`,
        `import { setRules } from 'pyric/sandbox/firestore';`,
        `import { doc, getDoc, getFirestore } from 'pyric/firestore';`,
        `const sandbox = initializeSandbox();`,
        `setRules(sandbox, "rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /notes/{id} { allow read: if false; } } }");`,
        tsFences[0]!.source,
        `await getDoc(doc(getFirestore(sandbox), 'notes/n1')).catch(() => {});`,
      ].join('\n'),
    );
    expect(fsEventRun.exitCode).toBeNull();
    expect(fsEventRun.logs).toHaveLength(1);
    expect(fsEventRun.logs[0]?.[0]).toBe('get');
    expect(fsEventRun.logs[0]?.[1]).toBe('notes/n1');

    // Blocks 2 & 3: RTDB denial event + denialContext on rejected get()
    const rtdbDenialRun = await runSnippetInCwd(
      dir,
      [
        `import { initializeSandbox, type RtdbDenialContext } from 'pyric/sandbox';`,
        `import { get, getDatabase, ref, sandbox as databaseSandbox } from 'pyric/database';`,
        `const sandbox = initializeSandbox();`,
        `const adminDb = getDatabase(sandbox);`,
        `databaseSandbox.setRules(adminDb, { rules: { '.read': false, records: { $recordId: { '.read': "auth != null && data.child('ownerId').val() === auth.uid" } } } });`,
        `databaseSandbox.setData(adminDb, { records: { r1: { ownerId: 'alice' } } });`,
        `const mallory = getDatabase(sandbox.withAuth({ uid: 'mallory' }));`,
        tsFences[1]!.source,
        tsFences[2]!.source
          .replace(/^import type .*\n/gm, '')
          .replace(
            /const \{ matchedPath, reason, rtdbTrace \} = [^;]+;/,
            '$&\n  if (typeof matchedPath !== "string" || typeof reason !== "string" || !Array.isArray(rtdbTrace)) process.exit(1);',
          ),
      ].join('\n'),
    );
    expect(rtdbDenialRun.exitCode).toBeNull();
    const eventLines = rtdbDenialRun.logs.slice(0, 3).map((row) => row.join(' ')).join('\n');
    expect(eventLines).toBe(plainFences[0]!.source);

    // Block 4: Index error vs listener warning (standalone)
    const indexRun = await runSnippetInCwd(dir, tsFences[3]!.source);
    expect(indexRun.exitCode).toBeNull();
    expect(String(indexRun.logs[0]?.[0])).toContain(
      'Index not defined, add ".indexOn": "budget", for path "/projects", to the rules',
    );
    expect(indexRun.logs[1]?.[0]).toEqual({ a: { budget: 5 } });

    // Block 5: lint(newSource) (standalone)
    const lintRun = await runSnippetInCwd(dir, tsFences[4]!.source);
    expect(lintRun.exitCode).toBeNull();
    const errorCodes = lintRun.logs[0]?.[0] as string[];
    expect(Array.isArray(errorCodes)).toBe(true);
    expect(errorCodes.length).toBeGreaterThan(0);
  });
});
