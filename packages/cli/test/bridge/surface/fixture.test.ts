import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { getAdminFirestore, doc, setDoc } from 'pyric/firestore';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';

import {
  applyFixture,
  buildFixture,
  fixturePathWithin,
  readFixtureFile,
  writeFixtureFile,
} from '../../../src/bridge/surface/fixture.js';

function tmpProjectDir(): string {
  return mkdtempSync(join(tmpdir(), 'pyric-fixture-'));
}

describe('fixturePathWithin', () => {
  it('resolves a relative path inside the project directory', () => {
    const result = fixturePathWithin('/project', 'fixtures/a.json');
    expect(result).toEqual({ path: '/project/fixtures/a.json' });
  });

  it('refuses a path that escapes the project directory', () => {
    const result = fixturePathWithin('/project', '../outside.json');
    expect('error' in result).toBe(true);
  });
});

describe('buildFixture / writeFixtureFile / readFixtureFile / applyFixture', () => {
  it('carries documents and users into a fixture and back', async () => {
    const sandbox = initializeSandbox();
    const db = getAdminFirestore(sandbox);
    await setDoc(doc(db, 'rooms/lobby'), { open: true });
    authSandbox.seedUsers(getAuth(sandbox), [
      { uid: 'alice', email: 'alice@example.com', password: 'super-secret', tenantId: 'tenant-a' },
    ]);

    const fixture = await buildFixture(sandbox, false);
    expect(fixture.firestore?.['rooms/lobby']).toEqual({ open: true });
    const alice = fixture.users?.find((user) => user.uid === 'alice');
    expect(alice?.tenantId).toBe('tenant-a');
    expect(alice?.password).toBeUndefined();

    const projectDir = tmpProjectDir();
    const path = join(projectDir, 'fixtures', 'scenario.json');
    writeFixtureFile(path, fixture);
    const read = readFixtureFile(path);
    expect(read).toEqual(fixture);

    const target = initializeSandbox();
    await applyFixture(target, read!);
    const restoredAlice = authSandbox
      .exportUsers(getAuth(target))
      .find((user) => user.uid === 'alice');
    expect(restoredAlice?.tenantId).toBe('tenant-a');
  });

  it('carries the real password only when asked', async () => {
    const sandbox = initializeSandbox();
    authSandbox.seedUsers(getAuth(sandbox), [
      { uid: 'bob', email: 'bob@example.com', password: 'plain-password' },
    ]);

    const redacted = await buildFixture(sandbox, false);
    expect(redacted.users?.find((user) => user.uid === 'bob')?.password).toBeUndefined();

    const withPassword = await buildFixture(sandbox, true);
    expect(withPassword.users?.find((user) => user.uid === 'bob')?.password).toBe(
      'plain-password',
    );
  });

  it('reads back null for a fixture that does not exist', () => {
    const projectDir = tmpProjectDir();
    expect(readFixtureFile(join(projectDir, 'missing.json'))).toBeNull();
  });
});
