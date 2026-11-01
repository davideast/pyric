// The token file's refusals and the env fallback, with a made-up token in
// temporary files. No refusal, notice or kept file may hold the value.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBrief } from './brief.ts';
import { keep, tokenFoundIn } from './builder-run.ts';
import { OAUTH_TOKEN_ENV } from './builder-command.ts';
import { harnessToken, readTokenFile, tokenFromText } from './harness-token.ts';
import { builderRunDirsAt } from './round-paths.ts';
import { runRecord } from './run-record.ts';
import { createRunDirs } from './scratch.ts';
import { filesContaining, REDACTED } from './token-scan.ts';

const FAKE_TOKEN = 'made-up-token-file-value-for-the-harness-test';
const ENV_TOKEN = 'made-up-env-value-for-the-harness-test';
const UID = process.getuid?.() ?? -1;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'builders-token-file-'));
}

function tokenFile(content: string, mode = 0o600): string {
  const path = join(scratch(), 'oauth-token');
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
  return path;
}

/** The problem `readTokenFile` gives, checked to hold no token value. */
function refusal(path: string, uid = UID): string {
  const read = readTokenFile(path, uid);
  if (read.ok) throw new Error(`expected ${path} to be refused`);
  expect(read.problem).not.toContain(FAKE_TOKEN);
  return read.problem;
}

describe('readTokenFile', () => {
  test('reads one line, with or without its newline, at 0600 or stricter', () => {
    expect(readTokenFile(tokenFile(`${FAKE_TOKEN}\n`))).toEqual({ ok: true, token: FAKE_TOKEN });
    expect(readTokenFile(tokenFile(FAKE_TOKEN, 0o400))).toEqual({ ok: true, token: FAKE_TOKEN });
  });

  test('refuses a file that does not exist', () => {
    const path = join(scratch(), 'missing');
    expect(refusal(path)).toBe(`the token file ${path} does not exist`);
  });

  test('refuses a symbolic link, even to a good file', () => {
    const target = tokenFile(`${FAKE_TOKEN}\n`);
    const link = join(scratch(), 'link');
    symlinkSync(target, link);
    expect(refusal(link)).toBe(`the token file ${link} is a symbolic link: name the file itself`);
  });

  test('refuses a directory and a FIFO, which are not regular files', () => {
    const dir = join(scratch(), 'dir');
    mkdirSync(dir, { mode: 0o700 });
    expect(refusal(dir)).toBe(`the token file ${dir} is not a regular file`);
    const fifo = join(scratch(), 'fifo');
    const made = spawnSync('mkfifo', ['-m', '600', fifo]);
    if (made.status === 0) expect(refusal(fifo)).toBe(`the token file ${fifo} is not a regular file`);
  });

  test('refuses a file the current user does not own', () => {
    const path = tokenFile(`${FAKE_TOKEN}\n`);
    expect(refusal(path, UID + 1)).toBe(`the token file ${path} is not owned by the current user`);
  });

  test('refuses any group or other access', () => {
    for (const mode of [0o640, 0o604, 0o660, 0o644, 0o601]) {
      const path = tokenFile(`${FAKE_TOKEN}\n`, mode);
      expect(refusal(path)).toBe(`the token file ${path} allows group or other access (mode 0${mode.toString(8)}): run \`chmod 600 ${path}\``);
    }
  });

  test('refuses an empty file, a blank line, and more than one line', () => {
    for (const content of ['', '\n', '   \n', `${FAKE_TOKEN}\n${FAKE_TOKEN}\n`, `${FAKE_TOKEN}\n\n`, `\n${FAKE_TOKEN}`, `${FAKE_TOKEN}\r\n`]) {
      const path = tokenFile(content);
      expect(refusal(path)).toBe(`the token file ${path} must hold exactly one non-empty line`);
    }
  });
});

describe('tokenFromText', () => {
  test('takes one line, trimmed, and nothing else', () => {
    expect(tokenFromText(`  ${FAKE_TOKEN}  \n`)).toBe(FAKE_TOKEN);
    expect(tokenFromText('a\nb')).toBeUndefined();
  });
});

describe('harnessToken', () => {
  test('falls back to the environment when no file is named', () => {
    expect(harnessToken(undefined, { [OAUTH_TOKEN_ENV]: ENV_TOKEN })).toEqual({ token: ENV_TOKEN, scanned: [ENV_TOKEN], problems: [], notices: [] });
    expect(harnessToken(undefined, { [OAUTH_TOKEN_ENV]: '' })).toEqual({ token: undefined, scanned: [], problems: [], notices: [] });
  });

  test('the file wins over the environment, and says so without either value', () => {
    const read = harnessToken(tokenFile(`${FAKE_TOKEN}\n`), { [OAUTH_TOKEN_ENV]: ENV_TOKEN });
    expect(read.token).toBe(FAKE_TOKEN);
    expect(read.scanned).toEqual([FAKE_TOKEN, ENV_TOKEN]);
    expect(read.notices).toEqual([`--token-file wins over ${OAUTH_TOKEN_ENV}, which is also set; the harness uses the file's token`]);
    expect(JSON.stringify({ problems: read.problems, notices: read.notices })).not.toMatch(/made-up/);
  });

  test('a refused file gives no token, and never the environment’s in its place', () => {
    const path = tokenFile(`${FAKE_TOKEN}\n`, 0o644);
    const read = harnessToken(path, { [OAUTH_TOKEN_ENV]: ENV_TOKEN });
    expect(read.token).toBeUndefined();
    expect(read.problems).toHaveLength(1);
    expect(JSON.stringify({ problems: read.problems, notices: read.notices })).not.toMatch(/made-up/);
  });
});

describe('keep, with a token read from a file', () => {
  test('no kept file holds the file’s token or the environment’s it won over, wherever the run wrote them', async () => {
    const read = harnessToken(tokenFile(`${FAKE_TOKEN}\n`), { [OAUTH_TOKEN_ENV]: ENV_TOKEN });
    if (read.token === undefined) throw new Error(read.problems.join('\n'));
    const root = scratch();
    const dirs = builderRunDirsAt(join(root, 'run'));
    createRunDirs(dirs.root);
    const briefJson = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'briefs', 'brief-1.json'), 'utf8')) as Record<string, unknown>;
    const brief = parseBrief({ ...briefJson, appIdea: `an app that prints ${read.token}` });
    if (!brief.ok) throw new Error(brief.errors.join('\n'));
    writeFileSync(dirs.briefJson, JSON.stringify(brief.value));
    writeFileSync(dirs.networkLog, `{"line":"${read.token}"}\n`);
    writeFileSync(join(dirs.logs, 'builder.log'), `said ${read.token}\n`);
    writeFileSync(join(dirs.logs, 'env.log'), `env ${ENV_TOKEN}\n`);
    writeFileSync(join(dirs.app, 'leak.txt'), read.token);
    const found = tokenFoundIn(dirs, read.scanned);
    expect(found).toEqual(['app/leak.txt', 'brief.json', 'logs/builder.log', 'logs/env.log', 'network.jsonl']);
    const time = new Date('2026-10-30T00:00:00.000Z');
    const record = runRecord({
      identity: { run: 'fake-1-haiku', round: 'fake', brief: 'fake-1', model: 'haiku', builder: 'script', maxBudgetUsd: 1, wallClockMinutes: 10 },
      brief: brief.value,
      provenance: { commit: 'abc', dirty: false, tarballs: {} },
      startedAt: time,
      endedAt: time,
      exit: null,
      report: { state: 'invalid', report: null, errors: [`the report quoted ${read.token} and ${ENV_TOKEN}`] },
      record: [],
      channel: [],
      usage: null,
      tokenFoundIn: found,
    });
    const dataDir = join(root, 'data');
    await keep(record, dirs, dataDir, read.scanned);
    expect(filesContaining(dataDir, FAKE_TOKEN)).toEqual([]);
    expect(filesContaining(dataDir, ENV_TOKEN)).toEqual([]);
    expect(readFileSync(join(dataDir, 'logs', 'env.log'), 'utf8')).toBe(`env ${REDACTED}\n`);
    expect(readFileSync(join(dataDir, 'report.json'), 'utf8')).toContain(REDACTED);
    expect(readFileSync(join(dataDir, 'logs', 'builder.log'), 'utf8')).toBe(`said ${REDACTED}\n`);
  });
});
