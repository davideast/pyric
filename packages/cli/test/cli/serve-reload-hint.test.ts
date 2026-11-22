import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatPyricCommand } from '../../src/cli/command-hint.js';
import { runDatabaseRulesGenerate } from '../../src/cli/database-rules.js';
import type { ParsedArgs } from '../../src/cli/parse-args.js';
import { startServe } from '../../src/cli/serve.js';

const VERIFY_HINT = `(run \`${formatPyricCommand('verify')}\` to replay the captured session against these rules)`;
/** What a live host's reload line ends with, as the Vite live host's does (`verify-hint.ts`). */
const LIVE_RELOAD = 'for the sandbox. Production keeps its deployed rules.';
const RELOAD_LINE = /rules reloaded .*\(hash (\w+)\)/;

// startServe prepares the SDK bundles and the rules before it returns: 0.2 s
// on an idle machine, 4 to 5.5 s with 48 busy loops sharing two cores, which
// alone used up bun's 5 s default (#1272). A reload logs within 1.1 s of its
// write under that load. Each wait has its own deadline so a missing reload
// fails with the log, and the test's timeout leaves room for startup.
const reloadDeadlineMs = 10_000;
const testTimeoutMs = 30_000;

type Reload = { line: string; hash: string };

function writeCapturedSession(cwd: string): void {
  const pyricDir = join(cwd, '.pyric');
  mkdirSync(pyricDir, { recursive: true });
  writeFileSync(
    join(pyricDir, 'last-session.json'),
    JSON.stringify({
      schemaVersion: 1,
      events: [{ service: 'rtdb', op: 'get', path: '/posts/p1', allowed: true }],
    }),
  );
}

/** A logger that keeps every line, and waits for the next rules reload it logs. */
function createReloadLog() {
  const lines: string[] = [];
  const listeners = new Set<() => void>();
  const record = (msg: string) => {
    lines.push(...msg.split('\n'));
    for (const listener of listeners) listener();
  };
  const logger = { note: record, info: record, warn: record };

  const findReload = (from: number, previousHash: string | null): Reload | null => {
    for (const line of lines.slice(from)) {
      const hash = RELOAD_LINE.exec(line)?.[1];
      const isNewReload = hash !== undefined && hash !== previousHash;
      if (isNewReload) return { line, hash };
    }
    return null;
  };

  /** The first reload logged at or after line `from` whose rules hash differs from `previousHash`. */
  const nextReload = (from: number, previousHash: string | null): Promise<Reload> =>
    new Promise((resolve, reject) => {
      const check = () => {
        const reload = findReload(from, previousHash);
        if (reload === null) return;
        clearTimeout(deadline);
        listeners.delete(check);
        resolve(reload);
      };
      const deadline = setTimeout(() => {
        listeners.delete(check);
        const since = lines.slice(from).join('\n') || '(nothing)';
        reject(
          new Error(
            `no rules reload logged within ${reloadDeadlineMs} ms of the write. Logged since the write:\n${since}`,
          ),
        );
      }, reloadDeadlineMs);
      listeners.add(check);
      check();
    });

  return { logger, nextReload, lines, mark: () => lines.length };
}

describe('pyric sandbox rules hot-reload hint (#1259)', () => {
  it('omits the verify hint without a captured session, then prints it once per service after capture', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pyric-reload-hint-'));
    const dbRulesFile = join(cwd, 'database.rules.json');
    const fsRulesFile = join(cwd, 'firestore.rules');
    writeFileSync(dbRulesFile, JSON.stringify({ rules: { '.read': false } }));
    writeFileSync(
      fsRulesFile,
      "rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /{doc=**} { allow read: if false; } } }",
    );
    const log = createReloadLog();

    const runtime = await startServe({ cwd, port: 0, watch: true, logger: log.logger });
    try {
      // 1. User edit BEFORE any captured session exists -> does not print or spend the hint.
      const beforeNoCapture = log.mark();
      writeFileSync(dbRulesFile, JSON.stringify({ rules: { '.read': true } }));
      const reloadNoCapture = await log.nextReload(beforeNoCapture, null);
      expect(reloadNoCapture.line).not.toContain('verify');

      // 2. Write a non-empty captured session -> next user edit prints the hint once for database.
      writeCapturedSession(cwd);
      const beforeDbFirst = log.mark();
      writeFileSync(dbRulesFile, JSON.stringify({ rules: { '.read': false, '.write': true } }));
      const dbFirst = await log.nextReload(beforeDbFirst, reloadNoCapture.hash);
      expect(dbFirst.line).toContain(VERIFY_HINT);

      // 3. Second user edit to database rules -> already spent for database.
      const beforeDbSecond = log.mark();
      writeFileSync(dbRulesFile, JSON.stringify({ rules: { '.read': true, '.write': true } }));
      const dbSecond = await log.nextReload(beforeDbSecond, dbFirst.hash);
      expect(dbSecond.line).not.toContain(VERIFY_HINT);

      // 4. Rejected Firestore rules edit -> logs rejection WITHOUT spending the Firestore verify hint!
      const beforeFsRejected = log.mark();
      writeFileSync(fsRulesFile, "rules_version = '2'; service cloud.firestore { SYNTAX ERROR ");
      const rejectDeadline = Date.now() + reloadDeadlineMs;
      while (
        !log.lines.slice(beforeFsRejected).some((line) => line.includes('rules NOT reloaded')) &&
        Date.now() < rejectDeadline
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(
        log.lines.slice(beforeFsRejected).some((line) => line.includes('rules NOT reloaded')),
      ).toBe(true);

      // 5. First valid user edit to firestore.rules -> still prints once for Firestore!
      const beforeFsFirst = log.mark();
      writeFileSync(
        fsRulesFile,
        "rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /items/{id} { allow read: if request.auth != null; } } }",
      );
      const fsFirst = await log.nextReload(beforeFsFirst, null);
      expect(fsFirst.line).toContain(VERIFY_HINT);
    } finally {
      await runtime.handle.stop();
    }
  }, testTimeoutMs);

  it('does not spend the verify hint on pyric database rules generate, keeping it for the user edit (#1259)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pyric-generated-reload-hint-'));
    const dbRulesFile = join(cwd, 'database.rules.json');
    writeFileSync(dbRulesFile, JSON.stringify({ rules: { '.read': false } }));
    writeCapturedSession(cwd);
    const log = createReloadLog();

    const runtime = await startServe({ cwd, port: 0, watch: true, logger: log.logger });
    try {
      const beforeGenerated = log.mark();
      const genExit = await runDatabaseRulesGenerate(
        {
          positional: [],
          flags: new Map<string, string | boolean>([['out', 'database.rules.json']]),
        } as unknown as ParsedArgs,
        {
          cwd,
          stdout: { write: () => true } as NodeJS.WriteStream,
          stderr: { write: () => true } as NodeJS.WriteStream,
          loadRulesDocument: async () => ({
            ok: true,
            document: { toJSON: () => ({ rules: { '.read': 'auth != null' } }) } as never,
          }),
        },
      );
      expect(genExit).toBe(0);
      const generatedReload = await log.nextReload(beforeGenerated, null);
      expect(generatedReload.line).not.toContain(VERIFY_HINT);

      const beforeUserEdit = log.mark();
      writeFileSync(
        dbRulesFile,
        JSON.stringify({ rules: { '.read': 'auth != null', '.write': 'auth != null' } }),
      );
      const userReload = await log.nextReload(beforeUserEdit, generatedReload.hash);
      expect(userReload.line).toContain(VERIFY_HINT);
    } finally {
      await runtime.handle.stop();
    }
  }, testTimeoutMs);

  it('on a pyric-live host, says on every reload that production keeps its deployed rules, with no verify hint', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pyric-live-reload-hint-'));
    const rulesFile = join(cwd, 'database.rules.json');
    writeFileSync(rulesFile, JSON.stringify({ rules: { '.read': false } }));
    writeCapturedSession(cwd);
    const log = createReloadLog();
    const liveHost = {
      project: { projectId: 'demo-live-reload', source: 'option' as const },
      writeRefusal: () => new Error('live mode refuses this write'),
    };

    const runtime = await startServe({ cwd, port: 0, watch: true, logger: log.logger, liveHost });
    try {
      const beforeFirst = log.mark();
      writeFileSync(rulesFile, JSON.stringify({ rules: { '.read': true } }));
      const first = await log.nextReload(beforeFirst, null);
      expect(first.line).toContain(LIVE_RELOAD);
      expect(first.line).not.toContain('verify');

      const beforeSecond = log.mark();
      writeFileSync(rulesFile, JSON.stringify({ rules: { '.read': false, '.write': true } }));
      const second = await log.nextReload(beforeSecond, first.hash);
      expect(second.line).toContain(LIVE_RELOAD);
    } finally {
      await runtime.handle.stop();
    }
  }, testTimeoutMs);
});
