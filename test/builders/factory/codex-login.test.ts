// The Codex login's refusals, its expiry, and the token scan's reach into
// it, all with made-up tokens in temporary files. No problem may hold a
// token's value.
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expiryProblem, jwtExpiry, readCodexLogin } from './codex-login.ts';
import { scannedSecrets, secretHits } from './codex-scan.ts';
import { fakeAuth, fakeJwt, fakeLogin } from './fake-login.ts';

const UID = process.getuid?.() ?? -1;

function authFile(content: string, mode = 0o600): string {
  const path = join(mkdtempSync(join(tmpdir(), 'factory-login-')), 'auth.json');
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
  return path;
}

/** The problem the login read gives, checked to hold no token. */
function refusal(path: string, uid = UID): string {
  const read = readCodexLogin(path, uid);
  if (read.ok) throw new Error(`expected ${path} to be refused`);
  const auth = fakeAuth();
  for (const secret of [auth.access, auth.refresh, auth.id, 'made-up']) expect(read.problem).not.toContain(secret);
  return read.problem;
}

describe('readCodexLogin', () => {
  test('reads a ChatGPT login: the access token, the account, every token for the scan, and the expiry', () => {
    const expiresAt = new Date('2026-11-08T08:43:01Z');
    const auth = fakeAuth(expiresAt);
    const read = readCodexLogin(authFile(auth.json));
    if (!read.ok) throw new Error(read.problem);
    expect(read.login.accessToken).toBe(auth.access);
    expect(read.login.accountId).toBe('made-up-account-id');
    expect(read.login.secrets).toEqual([auth.access, auth.refresh, auth.id]);
    expect(read.login.expiresAt?.toISOString()).toBe('2026-11-08T08:43:01.000Z');
  });

  test('refuses a file others can read, a link, someone else’s file, and a missing one, naming the rule', () => {
    expect(refusal(authFile(fakeAuth().json, 0o644))).toContain('allows group or other access (mode 0644)');
    const target = authFile(fakeAuth().json);
    const link = join(mkdtempSync(join(tmpdir(), 'factory-login-')), 'auth.json');
    symlinkSync(target, link);
    expect(refusal(link)).toContain('is a symbolic link');
    expect(refusal(target, UID + 1)).toContain('is not owned by the current user');
    expect(refusal(join(tmpdir(), 'no-such-login', 'auth.json'))).toContain('does not exist');
  });

  test('refuses an API-key login, a login missing a token, and a file that is not JSON', () => {
    expect(refusal(authFile(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'made-up' })))).toContain('holds no ChatGPT login');
    const partial = JSON.parse(fakeAuth().json);
    delete partial.tokens.refresh_token;
    expect(refusal(authFile(JSON.stringify(partial)))).toContain('holds no ChatGPT login');
    expect(refusal(authFile('{ made-up'))).toContain('is not JSON');
  });
});

describe('expiry', () => {
  test('reads a JWT’s exp, and null for a token that is not one', () => {
    expect(jwtExpiry(fakeJwt('a', new Date('2030-01-01T00:00:00Z')))?.toISOString()).toBe('2030-01-01T00:00:00.000Z');
    expect(jwtExpiry('not-a-jwt')).toBeNull();
    expect(jwtExpiry('a.!!!.c')).toBeNull();
  });

  test('stops using an access token five minutes before it lapses, saying how to refresh it', () => {
    const now = new Date('2026-11-08T08:00:00Z');
    expect(expiryProblem(fakeLogin(new Date('2026-11-08T09:00:00Z')), now)).toBeUndefined();
    const problem = expiryProblem(fakeLogin(new Date('2026-11-08T08:04:00Z')), now);
    expect(problem).toContain('lapses at 2026-11-08T08:04:00.000Z');
    expect(problem).toContain('codex login');
  });
});

describe('the token scan, extended to the login', () => {
  test('looks for the harness’s secrets and every token of the login, without repeats', () => {
    const login = fakeLogin();
    expect(scannedSecrets(['harness-made-up', login.accessToken], { ok: true, login })).toEqual(['harness-made-up', ...login.secrets]);
    expect(scannedSecrets(['harness-made-up'], { ok: false, problem: 'no login' })).toEqual(['harness-made-up']);
  });

  test('finds each of the login’s tokens in what a session wrote, naming files relative to the run', () => {
    const run = mkdtempSync(join(tmpdir(), 'factory-scan-'));
    const login = fakeLogin();
    mkdirSync(join(run, 'app', 'src'), { recursive: true });
    mkdirSync(join(run, 'homes', 'builder-1', '.codex'), { recursive: true });
    writeFileSync(join(run, 'app', 'src', 'leak.ts'), `const t = '${login.secrets[1]}';`);
    writeFileSync(join(run, 'homes', 'builder-1', '.codex', 'session.jsonl'), `{"text":"${login.secrets[0]}"}`);
    writeFileSync(join(run, 'app', 'clean.ts'), 'nothing here');
    const hits = secretHits(run, [join(run, 'app'), join(run, 'homes')], login.secrets);
    expect(hits).toEqual(['app/src/leak.ts', 'homes/builder-1/.codex/session.jsonl']);
    expect(hits.join('\n')).not.toContain(login.secrets[0] ?? '');
  });
});
