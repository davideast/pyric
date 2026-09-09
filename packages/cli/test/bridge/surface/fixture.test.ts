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
  readFixtureFile,
  writeFixtureFile,
} from '../../../src/bridge/surface/fixture.js';

function tmpProjectDir(): string {
  return mkdtempSync(join(tmpdir(), 'pyric-fixture-'));
}

describe('buildFixture / writeFixtureFile / readFixtureFile / applyFixture', () => {
  it('carries documents and users into a fixture and back', async () => {
    const sandbox = initializeSandbox();
    const db = getAdminFirestore(sandbox);
    await setDoc(doc(db, 'rooms/lobby'), { open: true });
    authSandbox.seedUsers(getAuth(sandbox), [
      { uid: 'alice', email: 'alice@example.com', password: 'super-secret', tenantId: 'tenant-a' },
    ]);

    const fixture = await buildFixture(sandbox);
    expect(fixture.firestore?.['rooms/lobby']).toEqual({ open: true });
    const alice = fixture.users?.find((user) => user.uid === 'alice');
    expect(alice?.tenantId).toBe('tenant-a');
    expect(alice?.password).toBe('super-secret');

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

  it('carries the seeded password by default, and leaves it out when asked', async () => {
    const sandbox = initializeSandbox();
    authSandbox.seedUsers(getAuth(sandbox), [
      { uid: 'bob', email: 'bob@example.com', password: 'plain-password' },
    ]);

    const carried = await buildFixture(sandbox);
    expect(carried.users?.find((user) => user.uid === 'bob')?.password).toBe('plain-password');

    const withheld = await buildFixture(sandbox, true);
    expect(withheld.users?.find((user) => user.uid === 'bob')?.password).toBeUndefined();
    expect(JSON.stringify(withheld)).not.toContain('plain-password');
  });

  it('reads back null for a fixture that does not exist', () => {
    const projectDir = tmpProjectDir();
    expect(readFixtureFile(join(projectDir, 'missing.json'))).toBeNull();
  });
});
