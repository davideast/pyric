import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getAdminFirestore,
  collection,
  query,
  where,
  getDocs,
  doc,
  setDoc,
  getDoc,
  Timestamp,
  GeoPoint,
  Bytes,
} from 'pyric/firestore';
import { getAdminDatabase, ref as dbRef, get as dbGet, setWithPriority } from 'pyric/database';
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

  it('preserves Firestore rich types, RTDB .priority, and Auth user metadata across buildFixture -> applyFixture', async () => {
    const source = initializeSandbox();
    const db1 = getAdminFirestore(source);
    await setDoc(doc(db1, 'items/i1'), {
      title: 'hello',
      ts: new Timestamp(1700000000, 123000000),
      geo: new GeoPoint(37.7749, -122.4194),
      bin: Bytes.fromUint8Array(new Uint8Array([1, 2, 3, 4])),
      ref: doc(db1, 'users/alice'),
    });

    const rdb1 = getAdminDatabase(source);
    await setWithPriority(dbRef(rdb1, 'ranked/item1'), { score: 10 }, 42);

    authSandbox.seedUsers(getAuth(source), [
      {
        uid: 'u1',
        email: 'alice@example.com',
        password: 'password123',
        emailVerified: true,
        displayName: 'Alice',
        photoUrl: 'https://example.com/a.png',
        phoneNumber: '+15555550100',
        disabled: true,
        customClaims: { role: 'admin' },
      },
    ]);

    const fixture = JSON.parse(JSON.stringify(await buildFixture(source)));
    const target = initializeSandbox();
    await applyFixture(target, fixture);

    const db2 = getAdminFirestore(target);
    const snap = await getDoc(doc(db2, 'items/i1'));
    const data = snap.data()!;
    expect(data.ts).toBeInstanceOf(Timestamp);
    expect((data.ts as Timestamp).seconds).toBe(1700000000);
    expect((data.ts as Timestamp).nanoseconds).toBe(123000000);
    expect(data.geo).toBeInstanceOf(GeoPoint);
    expect(data.bin).toBeInstanceOf(Bytes);
    expect((data.ref as { path?: string }).path).toBe('users/alice');

    const qSnap = await getDocs(
      query(collection(db2, 'items'), where('ts', '==', new Timestamp(1700000000, 123000000))),
    );
    expect(qSnap.docs.length).toBe(1);

    const rsnap = await dbGet(dbRef(getAdminDatabase(target), 'ranked/item1'));
    expect(rsnap.priority).toBe(42);

    const u1 = authSandbox.exportUsers(getAuth(target)).find((u) => u.uid === 'u1');
    expect(u1?.emailVerified).toBe(true);
    expect(u1?.displayName).toBe('Alice');
    expect(u1?.photoUrl).toBe('https://example.com/a.png');
    expect(u1?.phoneNumber).toBe('+15555550100');
    expect(u1?.disabled).toBe(true);
    expect(u1?.customClaims).toEqual({ role: 'admin' });
  });
});
