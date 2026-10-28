/**
 * `pyric verify --engine staging` against a real Realtime Database instance:
 * the built `pyric` command runs as a process in a project directory, so
 * production's rules engine decides every operation.
 *
 * Skipped unless the environment names an enrolled staging instance and
 * credentials reach it (a service account, ADC, or `firebase login`):
 *
 *   PYRIC_STAGING_LIVE=1 PYRIC_STAGING_PROJECT=<project> PYRIC_STAGING_RTDB=<instance or URL> \
 *     bun test packages/cli/test/verify/staging/staging-live.test.ts
 *
 * Build the CLI first (`bun run build:cli`). The instance must be enrolled
 * (`pyric verify staging init`) and is left as it was found, which the last
 * test reads back.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  equalTo,
  get,
  getAdminDatabase,
  getDatabase,
  onDisconnect,
  onValue,
  orderByChild,
  query,
  ref,
  set,
  update,
  sandbox as rtdbSandbox,
} from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';

import { buildVerifyFixture } from '../../../src/verify/index.js';
import { markedProject } from '../../../src/verify/staging/engine.js';
import { RtdbRestClient } from '../../../src/verify/staging/rest.js';
import { stagingTargetFrom, stagingToken } from '../../../src/verify/staging/target.js';

const live = process.env.PYRIC_STAGING_LIVE === '1' && !!process.env.PYRIC_STAGING_PROJECT && !!process.env.PYRIC_STAGING_RTDB;
const CLI = resolve(import.meta.dir, '../../../dist/cli/index.js');

const PASSWORD_ONLY = "auth != null && auth.uid === $uid && auth.token.firebase.sign_in_provider == 'password'";
const RULES = {
  rules: {
    profiles: { $uid: { '.read': 'auth != null && auth.uid === $uid', '.write': PASSWORD_ONLY } },
    presence: { $uid: { '.write': 'auth != null && auth.uid === $uid' } },
    items: { '.read': "query.orderByChild == 'owner' && query.equalTo == auth.uid", '.indexOn': ['owner'] },
  },
};

async function project(): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-staging-live-')));
  const sandbox = initializeSandbox();
  rtdbSandbox.setRules(getDatabase(sandbox), RULES);
  rtdbSandbox.setData(getAdminDatabase(sandbox), { '/profiles/bob': { name: 'Bob' }, '/items/a': { owner: 'alice' } });
  const db = getDatabase(sandbox.withAuth({ uid: 'alice', token: { email: 'alice@example.com', firebase: { sign_in_provider: 'password' } } }));
  await set(ref(db, 'profiles/alice'), { name: 'me' });
  await get(ref(db, 'profiles/alice'));
  const off = onValue(ref(db, 'profiles/alice'), () => {});
  await new Promise((r) => setTimeout(r, 0));
  off();
  await get(query(ref(db, 'items'), orderByChild('owner'), equalTo('alice')));
  await onDisconnect(ref(db, 'presence/alice')).set('offline');
  await set(ref(db, 'profiles/bob/name'), 'mallory').catch(() => {});
  await update(ref(db), { 'profiles/alice/name': 'again', 'profiles/bob/name': 'mallory' }).catch(() => {});
  mkdirSync(join(dir, '.pyric'));
  writeFileSync(join(dir, '.pyric', 'last-session.json'), JSON.stringify(buildVerifyFixture({
    sandbox, rtdbRules: RULES, rtdbState: rtdbSandbox.snapshotState(getAdminDatabase(sandbox)),
  })));
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ database: { rules: 'database.rules.json' } }));
  writeFileSync(join(dir, 'database.rules.json'), JSON.stringify(RULES));
  writeFileSync(join(dir, 'pyric.json'), JSON.stringify({
    verify: { staging: { project: process.env.PYRIC_STAGING_PROJECT, rtdb: process.env.PYRIC_STAGING_RTDB } },
  }));
  const withRules = (name: string, rules: unknown) => writeFileSync(join(dir, name), JSON.stringify(rules));
  withRules('open.rules.json', { rules: { '.read': 'auth != null', '.write': true, items: { '.indexOn': ['owner'] } } });
  withRules('tight.rules.json', { rules: { ...RULES.rules, profiles: { $uid: { '.write': PASSWORD_ONLY } }, presence: { '.write': false } } });
  withRules('google-only.rules.json', {
    rules: { ...RULES.rules, profiles: { $uid: { ...RULES.rules.profiles.$uid, '.write': PASSWORD_ONLY.replace("'password'", "'google.com'") } } },
  });
  withRules('no-index.rules.json', { rules: { ...RULES.rules, items: { '.read': true } } });
  return dir;
}

function pyric(dir: string, args: string[]): { code: number; output: string } {
  const result = spawnSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf8' });
  return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

describe.skipIf(!live)('pyric verify --engine staging on a real instance', () => {
  let dir: string;
  const both = ['verify', '--engine', 'sandbox', '--engine', 'staging'];

  it('replays the session cleanly under the rules it ran with', async () => {
    dir = await project();
    const { code, output } = pyric(dir, both);
    expect(output).toContain('all selected services replay cleanly');
    expect(code).toBe(0);
  }, 120_000);

  it('reports what open rules allow, from both engines', () => {
    const { code, output } = pyric(dir, [...both, '--rules', 'rtdb=open.rules.json']);
    expect(code).toBe(1);
    for (const engine of ['sandbox', 'staging']) {
      expect(output).toContain(`[rtdb ${engine}] now-allowed: set /profiles/bob/name`);
      expect(output).toContain(`[rtdb ${engine}] now-allowed: update /profiles/bob/name`);
    }
    expect(output).not.toContain('engine-drift');
  }, 120_000);

  it('reports the reads and the registration tight rules deny, from both engines', () => {
    const { code, output } = pyric(dir, [...both, '--rules', 'rtdb=tight.rules.json']);
    expect(code).toBe(1);
    for (const engine of ['sandbox', 'staging']) {
      expect(output).toContain(`[rtdb ${engine}] now-denied: get /profiles/alice`);
      expect(output).toContain(`[rtdb ${engine}] now-denied: listen /profiles/alice`);
      expect(output).toContain(`[rtdb ${engine}] now-denied: onDisconnect.set /presence/alice`);
    }
  }, 120_000);

  it('passes the captured sign-in provider through: rules for google.com deny the password user\'s writes', () => {
    const { code, output } = pyric(dir, [...both, '--rules', 'rtdb=google-only.rules.json']);
    expect(code).toBe(1);
    for (const engine of ['sandbox', 'staging']) {
      expect(output).toContain(`[rtdb ${engine}] now-denied: set /profiles/alice`);
    }
    expect(output).not.toContain('engine-drift');
  }, 120_000);

  it('reports a query production cannot serve without an index as unsupported', () => {
    const { output } = pyric(dir, ['verify', '--engine', 'staging', '--rules', 'rtdb=no-index.rules.json']);
    expect(output).toMatch(/\[rtdb\] unsupported: get \/items: production answered HTTP 400: .*[Ii]ndex/);
  }, 120_000);

  it('seeds the priority a rewound write restores, so production and the sandbox agree on a priority rule', async () => {
    const PRIORITY_GATED = { rules: { doc: { '.read': true, '.write': 'data.getPriority() == 5' } } };
    const priorityDir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-staging-live-priority-')));
    const sandbox = initializeSandbox();
    rtdbSandbox.setRules(getDatabase(sandbox), PRIORITY_GATED);
    rtdbSandbox.setData(getAdminDatabase(sandbox), { '/doc': { a: 1, '.priority': 5 } } as never);
    await set(ref(getDatabase(sandbox.withAuth({ uid: 'alice' })), 'doc'), { a: 2 });
    mkdirSync(join(priorityDir, '.pyric'));
    writeFileSync(join(priorityDir, '.pyric', 'last-session.json'), JSON.stringify(buildVerifyFixture({
      sandbox, rtdbRules: PRIORITY_GATED, rtdbState: rtdbSandbox.snapshotState(getAdminDatabase(sandbox)),
    })));
    writeFileSync(join(priorityDir, 'firebase.json'), JSON.stringify({ database: { rules: 'database.rules.json' } }));
    writeFileSync(join(priorityDir, 'database.rules.json'), JSON.stringify(PRIORITY_GATED));
    writeFileSync(join(priorityDir, 'pyric.json'), JSON.stringify({
      verify: { staging: { project: process.env.PYRIC_STAGING_PROJECT, rtdb: process.env.PYRIC_STAGING_RTDB } },
    }));
    const { code, output } = pyric(priorityDir, both);
    expect(output).toContain('all selected services replay cleanly');
    expect(output).not.toContain('engine-drift');
    expect(code).toBe(0);
  }, 120_000);

  it('leaves the instance enrolled and empty', async () => {
    const target = stagingTargetFrom({ verify: { staging: { project: process.env.PYRIC_STAGING_PROJECT, rtdb: process.env.PYRIC_STAGING_RTDB } } });
    const { token } = await stagingToken(target.projectId);
    const client = new RtdbRestClient(target.databaseUrl, token);
    expect(markedProject(await client.getRulesText())).toBe(target.projectId);
    expect((await client.get('/', { shallow: true })).body).toBeNull();
  }, 60_000);
});
