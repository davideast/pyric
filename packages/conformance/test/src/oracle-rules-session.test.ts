import { describe, expect, test } from 'bun:test';
import {
  OracleRulesSession,
  firestoreOracleTarget,
  runWithOracleRulesRestored,
  storageOracleTarget,
} from '../../src/oracle-rules-session.ts';

const PROJECT = 'oracle-test';
const BUCKET = 'oracle-test.firebasestorage.app';

const FIRESTORE_ORIGINAL = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read: if request.auth != null;
    }
  }
}
`;

const STORAGE_ORIGINAL = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}
`;

type Release = { name: string; rulesetName: string };

interface Fake {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  releases: Map<string, string>;
  rulesets: Map<string, string>;
  calls: string[];
  /** Make a matching request fail with this status until cleared. */
  failures: Array<{ method: string; urlIncludes: string; status: number; remaining: number }>;
  /** When set, a release PATCH answers 200 but leaves the release unchanged. */
  ignoreRestorePatches: { value: boolean };
}

/**
 * An in-memory Firebase Rules API: releases map a name to a ruleset name,
 * rulesets hold one source file each.
 */
function fakeRulesApi(initial: Record<string, string>): Fake {
  const releases = new Map<string, string>();
  const rulesets = new Map<string, string>();
  const calls: string[] = [];
  const failures: Fake['failures'] = [];
  const ignoreRestorePatches = { value: false };
  let counter = 0;
  const api = 'https://firebaserules.googleapis.com/v1/';
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  for (const [release, source] of Object.entries(initial)) {
    const rulesetName = `projects/${PROJECT}/rulesets/original-${counter++}`;
    rulesets.set(rulesetName, source);
    releases.set(`projects/${PROJECT}/releases/${release}`, rulesetName);
  }

  const handler = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url.replace(api, '')}`);
    const failure = failures.find(
      (f) => f.method === method && url.includes(f.urlIncludes) && f.remaining > 0,
    );
    if (failure) {
      failure.remaining -= 1;
      return json(failure.status, { error: { message: 'injected failure' } });
    }
    const path = url.replace(api, '');
    if (method === 'POST' && path === `projects/${PROJECT}/rulesets`) {
      const body = JSON.parse(String(init.body)) as { source: { files: { content: string }[] } };
      const name = `projects/${PROJECT}/rulesets/created-${counter++}`;
      rulesets.set(name, body.source.files[0]!.content);
      return json(200, { name });
    }
    if (method === 'POST' && path === `projects/${PROJECT}/releases`) {
      const body = JSON.parse(String(init.body)) as Release;
      releases.set(body.name, body.rulesetName);
      return json(200, body);
    }
    if (path.startsWith(`projects/${PROJECT}/releases/`)) {
      const name = decodeURIComponent(path);
      if (method === 'GET') {
        const rulesetName = releases.get(name);
        return rulesetName ? json(200, { name, rulesetName }) : json(404, { error: { message: 'not found' } });
      }
      if (method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { release: Release };
        if (!releases.has(name)) return json(404, { error: { message: 'not found' } });
        if (ignoreRestorePatches.value) return json(200, { name, rulesetName: releases.get(name) });
        releases.set(name, body.release.rulesetName);
        return json(200, { name, rulesetName: body.release.rulesetName });
      }
      if (method === 'DELETE') {
        releases.delete(name);
        return json(200, {});
      }
    }
    if (method === 'GET' && rulesets.has(path)) {
      return json(200, { name: path, source: { files: [{ name: 'x.rules', content: rulesets.get(path) }] } });
    }
    return json(404, { error: { message: `unhandled ${method} ${path}` } });
  };
  return { fetch: handler, releases, rulesets, calls, failures, ignoreRestorePatches };
}

function liveSource(fake: Fake, release: string): string | undefined {
  const rulesetName = fake.releases.get(`projects/${PROJECT}/releases/${release}`);
  return rulesetName ? fake.rulesets.get(rulesetName) : undefined;
}

function session(fake: Fake): OracleRulesSession {
  return new OracleRulesSession({ projectId: PROJECT, accessToken: async () => 'test-token', fetch: fake.fetch });
}

describe('OracleRulesSession', () => {
  test('a Firestore merge is undone: the release points back at the original ruleset', async () => {
    const fake = fakeRulesApi({ 'cloud.firestore': FIRESTORE_ORIGINAL });
    const originalRuleset = fake.releases.get(`projects/${PROJECT}/releases/cloud.firestore`);
    const s = session(fake);

    expect(await s.deploy(firestoreOracleTarget())).toBe('merged');
    expect(liveSource(fake, 'cloud.firestore')).toContain('pyric_oracle');
    expect(fake.releases.get(`projects/${PROJECT}/releases/cloud.firestore`)).not.toBe(originalRuleset);

    await s.restoreAll();
    expect(fake.releases.get(`projects/${PROJECT}/releases/cloud.firestore`)).toBe(originalRuleset);
    expect(liveSource(fake, 'cloud.firestore')).toBe(FIRESTORE_ORIGINAL);
  });

  test('a per-bucket Storage merge is undone', async () => {
    const release = `firebase.storage/${BUCKET}`;
    const fake = fakeRulesApi({ [release]: STORAGE_ORIGINAL });
    const originalRuleset = fake.releases.get(`projects/${PROJECT}/releases/${release}`);
    const s = session(fake);

    expect(await s.deploy(storageOracleTarget(BUCKET))).toBe('merged');
    expect(liveSource(fake, release)).toContain('pyric_oracle');

    await s.restoreAll();
    expect(fake.releases.get(`projects/${PROJECT}/releases/${release}`)).toBe(originalRuleset);
    expect(liveSource(fake, release)).toBe(STORAGE_ORIGINAL);
  });

  test('a release with the harness block already present is left alone and nothing is written', async () => {
    const merged = fakeRulesApi({ 'cloud.firestore': FIRESTORE_ORIGINAL });
    await session(merged).deploy(firestoreOracleTarget());
    // A second session sees the merged rules as its baseline.
    const second = session(merged);
    const before = merged.calls.length;
    expect(await second.deploy(firestoreOracleTarget())).toBe('already-configured');
    await second.restoreAll();
    const writes = merged.calls.slice(before).filter((c) => !c.startsWith('GET'));
    expect(writes).toEqual([]);
  });

  test('a project with no release gets a fresh one, and restore deletes it', async () => {
    const fake = fakeRulesApi({});
    const s = session(fake);

    expect(await s.deploy(firestoreOracleTarget())).toBe('fresh');
    expect(liveSource(fake, 'cloud.firestore')).toContain('pyric_oracle');

    await s.restoreAll();
    expect(fake.releases.has(`projects/${PROJECT}/releases/cloud.firestore`)).toBe(false);
  });

  test('the original rules come back when the run body throws, and the body error is kept', async () => {
    const fake = fakeRulesApi({ 'cloud.firestore': FIRESTORE_ORIGINAL });
    const s = session(fake);
    await s.deploy(firestoreOracleTarget());

    const failure = new Error('probe exploded');
    const error = await runWithOracleRulesRestored(s, async () => {
      throw failure;
    }).catch((e: unknown) => e);

    expect(error).toBe(failure);
    expect(liveSource(fake, 'cloud.firestore')).toBe(FIRESTORE_ORIGINAL);
  });

  test('the original rules come back when the run body succeeds', async () => {
    const fake = fakeRulesApi({ 'cloud.firestore': FIRESTORE_ORIGINAL });
    const s = session(fake);
    await s.deploy(firestoreOracleTarget());

    const result = await runWithOracleRulesRestored(s, async () => 'done');

    expect(result).toBe('done');
    expect(liveSource(fake, 'cloud.firestore')).toBe(FIRESTORE_ORIGINAL);
  });

  test('a deploy that fails after creating the ruleset still restores the release', async () => {
    const fake = fakeRulesApi({ 'cloud.firestore': FIRESTORE_ORIGINAL });
    const originalRuleset = fake.releases.get(`projects/${PROJECT}/releases/cloud.firestore`);
    const s = session(fake);
    fake.failures.push({ method: 'PATCH', urlIncludes: 'releases/cloud.firestore', status: 500, remaining: 1 });

    await expect(s.deploy(firestoreOracleTarget())).rejects.toThrow('activate Firestore oracle ruleset');
    await s.restoreAll();
    expect(fake.releases.get(`projects/${PROJECT}/releases/cloud.firestore`)).toBe(originalRuleset);
  });

  test('a restore that cannot be completed fails with a message naming the release and the original ruleset', async () => {
    const fake = fakeRulesApi({ 'cloud.firestore': FIRESTORE_ORIGINAL });
    const originalRuleset = fake.releases.get(`projects/${PROJECT}/releases/cloud.firestore`)!;
    const s = session(fake);
    await s.deploy(firestoreOracleTarget());
    fake.failures.push({ method: 'PATCH', urlIncludes: 'releases/cloud.firestore', status: 503, remaining: 99 });

    const error = (await s.restoreAll().catch((e: unknown) => e)) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('ORACLE RULES RESTORE FAILED');
    expect(error.message).toContain(`projects/${PROJECT}/releases/cloud.firestore`);
    expect(error.message).toContain(originalRuleset);
    expect(liveSource(fake, 'cloud.firestore')).toContain('pyric_oracle');
  });

  test('a restore the API accepts but that leaves the release elsewhere fails verification', async () => {
    const fake = fakeRulesApi({ 'cloud.firestore': FIRESTORE_ORIGINAL });
    const s = session(fake);
    await s.deploy(firestoreOracleTarget());
    fake.ignoreRestorePatches.value = true;

    const error = (await s.restoreAll().catch((e: unknown) => e)) as Error;

    expect(error.message).toContain('ORACLE RULES RESTORE FAILED');
    expect(error.message).toContain('does not point to');
  });

  test('every release is attempted even when the first restore fails, and all failures are reported', async () => {
    const release = `firebase.storage/${BUCKET}`;
    const fake = fakeRulesApi({ 'cloud.firestore': FIRESTORE_ORIGINAL, [release]: STORAGE_ORIGINAL });
    const storageOriginal = fake.releases.get(`projects/${PROJECT}/releases/${release}`);
    const s = session(fake);
    await s.deploy(firestoreOracleTarget());
    await s.deploy(storageOracleTarget(BUCKET));
    fake.failures.push({ method: 'PATCH', urlIncludes: 'releases/cloud.firestore', status: 503, remaining: 99 });

    const error = (await s.restoreAll().catch((e: unknown) => e)) as Error;

    expect(error.message).toContain('Firestore');
    expect(fake.releases.get(`projects/${PROJECT}/releases/${release}`)).toBe(storageOriginal);
  });

  test('a restore failure after a body failure reports both', async () => {
    const fake = fakeRulesApi({ 'cloud.firestore': FIRESTORE_ORIGINAL });
    const s = session(fake);
    await s.deploy(firestoreOracleTarget());
    fake.failures.push({ method: 'PATCH', urlIncludes: 'releases/cloud.firestore', status: 503, remaining: 99 });

    const error = (await runWithOracleRulesRestored(s, async () => {
      throw new Error('probe exploded');
    }).catch((e: unknown) => e)) as AggregateError;

    expect(error).toBeInstanceOf(AggregateError);
    expect(error.message).toContain('ORACLE RULES RESTORE FAILED');
    expect(error.errors.map((e: Error) => e.message).join('\n')).toContain('probe exploded');
  });

  test('the merged sources place the block at the top of the service match, as the harness always has', async () => {
    const fake = fakeRulesApi({
      'cloud.firestore': FIRESTORE_ORIGINAL,
      [`firebase.storage/${BUCKET}`]: STORAGE_ORIGINAL,
    });
    const s = session(fake);
    await s.deploy(firestoreOracleTarget());
    await s.deploy(storageOracleTarget(BUCKET));

    expect(liveSource(fake, 'cloud.firestore')).toContain(
      'match /databases/{database}/documents {\n' +
      '      // @pyric/oracle - read/write under pyric_oracle/* for the conformance oracle harness\n' +
      '      match /pyric_oracle/{run}/{anything=**} {\n' +
      '        allow read, write: if request.auth != null;\n' +
      '      }\n\n' +
      '    match /users/{uid} {',
    );
    expect(liveSource(fake, `firebase.storage/${BUCKET}`)).toContain(
      'match /b/{bucket}/o {\n' +
      '    // @pyric/oracle/storage - read/write under pyric_oracle/* for the conformance oracle harness\n' +
      '    match /pyric_oracle/{run}/{allPaths=**} {\n' +
      '      allow read, write: if request.auth != null;\n' +
      '    }\n\n' +
      '    match /{allPaths=**} {',
    );
  });

  test('a rules source without the service match is refused before anything is written', async () => {
    const fake = fakeRulesApi({ 'cloud.firestore': 'rules_version = \'2\';\nservice cloud.firestore {}\n' });
    const s = session(fake);

    await expect(s.deploy(firestoreOracleTarget())).rejects.toThrow('cannot locate');
    expect(fake.calls.filter((c) => c.startsWith('POST') || c.startsWith('PATCH'))).toEqual([]);
    await s.restoreAll();
    expect(fake.calls.filter((c) => c.startsWith('PATCH'))).toEqual([]);
  });

  test('the restore requests a fresh access token', async () => {
    const fake = fakeRulesApi({ 'cloud.firestore': FIRESTORE_ORIGINAL });
    let tokens = 0;
    const s = new OracleRulesSession({
      projectId: PROJECT,
      accessToken: async () => `token-${++tokens}`,
      fetch: fake.fetch,
    });
    await s.deploy(firestoreOracleTarget());
    await s.restoreAll();
    expect(tokens).toBe(2);
  });

  test('a restore that cannot obtain a token fails loudly', async () => {
    const fake = fakeRulesApi({ 'cloud.firestore': FIRESTORE_ORIGINAL });
    let tokens = 0;
    const s = new OracleRulesSession({
      projectId: PROJECT,
      accessToken: async () => {
        if (++tokens > 1) throw new Error('token exchange failed: 500');
        return 'token';
      },
      fetch: fake.fetch,
    });
    await s.deploy(firestoreOracleTarget());

    const error = (await s.restoreAll().catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('ORACLE RULES RESTORE FAILED');
    expect(error.message).toContain('token exchange failed');
  });

  test('restoreAll is idempotent: a second call makes no requests', async () => {
    const fake = fakeRulesApi({ 'cloud.firestore': FIRESTORE_ORIGINAL });
    const s = session(fake);
    await s.deploy(firestoreOracleTarget());
    await s.restoreAll();
    const count = fake.calls.length;
    await s.restoreAll();
    expect(fake.calls.length).toBe(count);
  });
});
