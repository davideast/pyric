/** `pyric verify` checks each RTDB instance a session used against that instance's rules. */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase, ref, set, sandbox as rtdbSandbox } from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';

import { parseArgs } from '../../src/cli/parse-args.js';
import { runVerify } from '../../src/cli/verify.js';
import { buildVerifyFixture, type PyricVerifyFixture } from '../../src/verify/index.js';
import { captureRtdbInstances, defaultInstanceUrl } from '../../src/verify/rtdb-instance-capture.js';

const SIGNED_IN = { rules: { '.read': 'auth != null', '.write': 'auth != null' } };
const READ_ONLY = { rules: { '.read': 'auth != null', '.write': false } };
const SHARD = 'https://shard-00.firebaseio.com';

/** A session on project demo-app that writes to the default instance and to shard-00. */
async function captureSession(options: { databaseUrl?: boolean } = {}): Promise<PyricVerifyFixture> {
  const sandbox = initializeSandbox();
  const main = getDatabase(sandbox);
  rtdbSandbox.setRules(main, SIGNED_IN);
  rtdbSandbox.setRules(getDatabase(sandbox, SHARD), SIGNED_IN);
  const alice = sandbox.withAuth({ uid: 'alice' });
  await set(ref(getDatabase(alice), 'rooms/lobby'), { name: 'default lobby' });
  await set(ref(getDatabase(alice, SHARD), 'rooms/lobby'), { name: 'shard lobby' });
  const defaultName = options.databaseUrl === false ? undefined : 'demo-app-default-rtdb';
  return buildVerifyFixture({
    sandbox,
    rtdbRules: SIGNED_IN,
    rtdbState: rtdbSandbox.snapshotState(main),
    rtdbDatabaseUrl: defaultInstanceUrl(defaultName),
    rtdbInstances: captureRtdbInstances(sandbox, defaultName),
  });
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project directory holding `files` (objects are written as JSON) and the captured session. */
async function project(files: Record<string, unknown>, fixture?: PyricVerifyFixture): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-verify-instances-')));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  writeFileSync(join(dir, 'session.json'), JSON.stringify(fixture ?? await captureSession()));
  return dir;
}

/** Run `pyric verify session.json ...argv` in `dir` and return its exit code and what it printed. */
async function verify(dir: string, argv: string[] = []): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = spyOn(process.stdout, 'write').mockImplementation((chunk) => (out.push(String(chunk)), true));
  const stderr = spyOn(process.stderr, 'write').mockImplementation((chunk) => (err.push(String(chunk)), true));
  const previous = process.cwd();
  process.chdir(dir);
  try {
    const code = await runVerify(parseArgs(['verify', 'session.json', ...argv]));
    return { code, out: out.join(''), err: err.join('') };
  } finally {
    process.chdir(previous);
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

const INSTANCE_ARRAY = {
  database: [
    { instance: 'demo-app-default-rtdb', rules: 'database.rules.json' },
    { instance: 'shard-00', rules: 'shard.rules.json' },
  ],
};

describe('pyric verify with more than one RTDB instance', () => {
  it('checks each instance of a firebase.json instance array against its own rules', async () => {
    const dir = await project({
      'firebase.json': INSTANCE_ARRAY,
      'database.rules.json': SIGNED_IN,
      'shard.rules.json': SIGNED_IN,
    });
    const clean = await verify(dir);
    expect(clean.code).toBe(0);
    expect(clean.out).toContain('all selected services replay cleanly');

    writeFileSync(join(dir, 'shard.rules.json'), JSON.stringify(READ_ONLY));
    const tightened = await verify(dir);
    expect(tightened.code).toBe(1);
    expect(tightened.out).toContain('[rtdb shard-00] now-denied: set /rooms/lobby');
    expect(tightened.out).not.toContain('[rtdb] ');
    expect(tightened.err).toContain('rtdb=database.rules.json, rtdb:shard-00=shard.rules.json');
  });

  it('names the default instance by the project id when the capture records no URL', async () => {
    const dir = await project({
      'firebase.json': INSTANCE_ARRAY,
      '.firebaserc': { projects: { default: 'demo-app' } },
      'database.rules.json': SIGNED_IN,
      'shard.rules.json': SIGNED_IN,
    }, await captureSession({ databaseUrl: false }));
    expect((await verify(dir)).code).toBe(0);
  });

  it('resolves a deploy target through .firebaserc for --project', async () => {
    const dir = await project({
      'firebase.json': { database: [{ target: 'main', rules: 'database.rules.json' }, { target: 'shards', rules: 'shard.rules.json' }] },
      '.firebaserc': {
        projects: { prod: 'demo-app', staging: 'demo-staging' },
        targets: { 'demo-app': { database: { main: ['demo-app-default-rtdb'], shards: ['shard-00'] } } },
      },
      'database.rules.json': SIGNED_IN,
      'shard.rules.json': READ_ONLY,
    });
    const result = await verify(dir, ['--project', 'prod']);
    expect(result.code).toBe(1);
    expect(result.out).toContain('[rtdb shard-00] now-denied');
  });

  it('names a recorded instance whose deploy target did not resolve', async () => {
    const dir = await project({
      'firebase.json': { database: [{ instance: 'demo-app-default-rtdb', rules: 'database.rules.json' }, { target: 'shards', rules: 'shard.rules.json' }] },
      'database.rules.json': SIGNED_IN,
      'shard.rules.json': SIGNED_IN,
    });
    const result = await verify(dir);
    expect(result.code).toBe(2);
    expect(result.err).toContain('missing candidate rtdb rules for instance "shard-00", which the session used.');
    expect(result.err).toContain('firebase.json deploy target "shards" (firebase.json database[1]) did not resolve: no Firebase project is set.');
    expect(result.err).toContain('Pass --rules rtdb:shard-00=<path>');
  });

  it('takes an instance\'s rules from --rules rtdb:<instance>=<path>, by name or URL', async () => {
    const dir = await project({
      'firebase.json': INSTANCE_ARRAY,
      'database.rules.json': SIGNED_IN,
      'shard.rules.json': SIGNED_IN,
      'strict.rules.json': READ_ONLY,
    });
    for (const instance of ['shard-00', SHARD]) {
      const result = await verify(dir, ['--rules', `rtdb:${instance}=strict.rules.json`, '--json']);
      expect(result.code).toBe(1);
      const report = JSON.parse(result.out) as { rulesPaths: Record<string, string> };
      expect(Object.keys(report.rulesPaths).sort()).toEqual(['rtdb', 'rtdb:shard-00']);
      expect(report.rulesPaths['rtdb:shard-00']).toBe(join(dir, 'strict.rules.json'));
    }
  });

  it('maps rtdb:<default instance name> to the default instance', async () => {
    const dir = await project({
      'firebase.json': INSTANCE_ARRAY,
      'database.rules.json': SIGNED_IN,
      'shard.rules.json': SIGNED_IN,
      'strict.rules.json': READ_ONLY,
    });
    const result = await verify(dir, ['--rules', 'rtdb:demo-app-default-rtdb=strict.rules.json']);
    expect(result.code).toBe(1);
    expect(result.out).toContain('[rtdb] now-denied: set /rooms/lobby');
    expect(result.out).not.toContain('[rtdb shard-00]');
  });

  it('refuses rules for an instance the session never used', async () => {
    const dir = await project({ 'firebase.json': INSTANCE_ARRAY, 'database.rules.json': SIGNED_IN, 'shard.rules.json': SIGNED_IN });
    const result = await verify(dir, ['--rules', 'rtdb:shard-01=shard.rules.json']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('--rules rtdb:shard-01: the session never used instance "shard-01". Instances the session used: the default instance, shard-00.');
  });

  it('keeps --rules rtdb=<path> for the default instance', async () => {
    const dir = await project({ 'shard.rules.json': SIGNED_IN, 'strict.rules.json': READ_ONLY });
    const result = await verify(dir, ['--rules', 'rtdb=strict.rules.json', '--rules', 'rtdb:shard-00=shard.rules.json']);
    expect(result.code).toBe(1);
    expect(result.out).toContain('[rtdb] now-denied');
  });

  it('reads database.rules.json for the default instance when firebase.json has no database key', async () => {
    const sandbox = initializeSandbox();
    const main = getDatabase(sandbox);
    rtdbSandbox.setRules(main, SIGNED_IN);
    await set(ref(getDatabase(sandbox.withAuth({ uid: 'alice' })), 'rooms/lobby'), { name: 'lobby' });
    const fixture = buildVerifyFixture({ sandbox, rtdbRules: SIGNED_IN, rtdbState: rtdbSandbox.snapshotState(main) });
    const dir = await project({ 'firebase.json': {}, 'database.rules.json': SIGNED_IN }, fixture);
    expect((await verify(dir)).code).toBe(0);
  });

  it('refuses --rules rtdb=<path> when the session only used named instances, and deduplicates symlinked overrides (AV-VER-7)', async () => {
    const sandbox = initializeSandbox();
    const main = getDatabase(sandbox);
    const shard = getDatabase(sandbox, SHARD);
    rtdbSandbox.setRules(main, SIGNED_IN);
    rtdbSandbox.setRules(shard, SIGNED_IN);
    await set(ref(getDatabase(sandbox.withAuth({ uid: 'alice' }), SHARD), 'rooms/lobby'), { name: 'shard only' });
    const namedOnlyFixture = buildVerifyFixture({
      sandbox,
      rtdbRules: SIGNED_IN,
      rtdbState: rtdbSandbox.snapshotState(main),
      rtdbInstances: captureRtdbInstances(sandbox, 'demo-app-default-rtdb'),
    });

    const dir = await project(
      { 'database.rules.json': SIGNED_IN, 'shard.rules.json': SIGNED_IN },
      namedOnlyFixture,
    );
    const unusedDefault = await verify(dir, [
      '--rules',
      'rtdb=database.rules.json',
      '--rules',
      'rtdb:shard-00=shard.rules.json',
    ]);
    expect(unusedDefault.code).toBe(2);
    expect(unusedDefault.err).toContain('the session never used the default instance');

    const symlinkDir = join(dir, 'linked');
    symlinkSync(dir, symlinkDir);
    const symlinkDup = await verify(dir, [
      '--rules',
      `rtdb:shard-00=${join(dir, 'shard.rules.json')}`,
      '--rules',
      `rtdb:shard-00=${join(symlinkDir, 'shard.rules.json')}`,
    ]);
    expect(symlinkDup.code).toBe(0);
  });
});
