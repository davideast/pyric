import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServe } from '../../src/cli/serve.js';

const VERIFY_HINT = '(run `pyric verify` to replay the captured session against these rules)';
const RELOAD_LINE = /rules reloaded .*\(hash (\w+)\)/;

// startServe prepares the SDK bundles and the rules before it returns: 0.2 s
// on an idle machine, 4 to 5.5 s with 48 busy loops sharing two cores, which
// alone used up bun's 5 s default (#1272). A reload logs within 1.1 s of its
// write under that load. Each wait has its own deadline so a missing reload
// fails with the log, and the test's timeout leaves room for startup.
const reloadDeadlineMs = 10_000;
const testTimeoutMs = 30_000;

type Reload = { line: string; hash: string };

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
        reject(new Error(`no rules reload logged within ${reloadDeadlineMs} ms of the write. Logged since the write:\n${since}`));
      }, reloadDeadlineMs);
      listeners.add(check);
      check();
    });

  return { logger, nextReload, mark: () => lines.length };
}

describe('pyric sandbox rules hot-reload hint', () => {
  it('prints the verify hint once per session', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pyric-reload-hint-'));
    const rulesFile = join(cwd, 'database.rules.json');
    writeFileSync(rulesFile, JSON.stringify({ rules: { '.read': false } }));
    const log = createReloadLog();

    const runtime = await startServe({ cwd, port: 0, watch: true, logger: log.logger });
    try {
      const beforeFirst = log.mark();
      writeFileSync(rulesFile, JSON.stringify({ rules: { '.read': true } }));
      const first = await log.nextReload(beforeFirst, null);
      expect(first.line).toContain(VERIFY_HINT);

      const beforeSecond = log.mark();
      writeFileSync(rulesFile, JSON.stringify({ rules: { '.read': false, '.write': true } }));
      const second = await log.nextReload(beforeSecond, first.hash);
      expect(second.line).not.toContain(VERIFY_HINT);
    } finally {
      await runtime.handle.stop();
    }
  }, testTimeoutMs);
});
