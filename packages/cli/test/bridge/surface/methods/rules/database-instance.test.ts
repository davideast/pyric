import { describe, expect, test } from 'bun:test';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import { getAdminDatabase } from 'pyric/database';
import { callMethod } from '../../../../../src/bridge/surface/method-call.js';
import { methodByKey } from '../../../../../src/bridge/surface/methods/registry.js';
import { createSurfaceContext } from '../../../../../src/bridge/surface/context.js';

const NAMED_RULES = JSON.stringify({
  rules: {
    rooms: {
      $roomId: {
        '.read':
          'auth != null && root.child("rooms").child($roomId).child("members").child(auth.uid).exists()',
        '.write':
          'auth != null && root.child("rooms").child($roomId).child("members").child(auth.uid).child("role").val() === "admin"',
        title: {
          '.validate': 'newData.isString() && newData.val().length <= 100',
        },
        members: {
          $uid: {
            role: {
              '.validate': 'newData.val() === "admin" || newData.val() === "member"',
            },
            $other: { '.validate': false },
          },
        },
        $other: { '.validate': false },
      },
    },
  },
});

const DEFAULT_RULES = JSON.stringify({
  rules: {
    users: {
      $uid: {
        '.read': 'auth != null && auth.uid === $uid',
        '.write': 'auth != null && auth.uid === $uid',
      },
    },
  },
});

describe('multi-instance RTDB rules surface (set, lint, simulate, explainDenial)', () => {
  test('installs, lints, simulates, and explains denials independently across default and named RTDB instances', async () => {
    const sandbox = createSandboxRoot({ projectId: 'demo-rooms' });
    const ctx = createSurfaceContext(sandbox, process.cwd());

    // Seed auth users
    await callMethod(methodByKey('auth.createUser'), { uid: 'alice', email: 'alice@example.com' }, ctx);
    await callMethod(methodByKey('auth.createUser'), { uid: 'bob', email: 'bob@example.com' }, ctx);

    // Install rules on a brand-new empty instance BEFORE any data exists on demo-rooms-named
    const installNamed = await callMethod(
      methodByKey('rules.set'),
      { service: 'database', instance: 'demo-rooms-named', rules: NAMED_RULES },
      ctx,
    );
    expect(installNamed.ok).toBe(true);
    expect(installNamed.summary).toContain('demo-rooms-named');

    // Install completely separate rules on default RTDB instance
    const installDefault = await callMethod(
      methodByKey('rules.set'),
      { service: 'database', rules: DEFAULT_RULES },
      ctx,
    );
    expect(installDefault.ok).toBe(true);
    expect(installDefault.summary).toBe('Database rules installed.');

    // Write room data onto demo-rooms-named via surface `database.set`
    const writeMember = await callMethod(
      methodByKey('database.set'),
      { instance: 'demo-rooms-named', path: 'rooms/room-1/members/alice', value: { role: 'admin' } },
      ctx,
    );
    expect(writeMember.ok).toBe(true);
    const writeTitle = await callMethod(
      methodByKey('database.set'),
      { instance: 'demo-rooms-named', path: 'rooms/room-1/title', value: 'Reading Room' },
      ctx,
    );
    expect(writeTitle.ok).toBe(true);

    // Lint against demo-rooms-named
    const lintNamed = await callMethod(
      methodByKey('rules.lint'),
      { service: 'database', instance: 'demo-rooms-named' },
      ctx,
    );
    expect(lintNamed).toEqual({ ok: true, summary: expect.stringContaining('demo-rooms-named'), data: { issues: expect.any(Array) } });

    // Simulate Alice (authorized member) vs Bob (non-member) reading rooms/room-1 on demo-rooms-named
    const aliceSim = await callMethod(
      methodByKey('rules.simulate'),
      {
        service: 'database',
        instance: 'demo-rooms-named',
        operation: 'read',
        path: 'rooms/room-1',
        uid: 'alice',
      },
      ctx,
    );
    expect(aliceSim.ok).toBe(true);
    expect((aliceSim.data as { allowed?: boolean }).allowed).toBe(true);

    const bobSim = await callMethod(
      methodByKey('rules.simulate'),
      {
        service: 'database',
        instance: 'demo-rooms-named',
        operation: 'read',
        path: 'rooms/room-1',
        uid: 'bob',
      },
      ctx,
    );
    expect(bobSim.ok).toBe(true);
    expect((bobSim.data as { allowed?: boolean }).allowed).toBe(false);

    // Explain Bob's denial on demo-rooms-named
    const bobExplain = await callMethod(
      methodByKey('rules.explainDenial'),
      {
        service: 'database',
        instance: 'demo-rooms-named',
        operation: 'read',
        path: 'rooms/room-1',
        uid: 'bob',
      },
      ctx,
    );
    expect(bobExplain.ok).toBe(true);
    expect(bobExplain.summary).toContain('demo-rooms-named');
    expect((bobExplain.data as { allowed?: boolean }).allowed).toBe(false);

    // Rejects `instance` cleanly when passed for non-database services (`firestore`, `storage`)
    const invalidFirestoreInstance = await callMethod(
      methodByKey('rules.set'),
      {
        service: 'firestore',
        instance: 'demo-rooms-named',
        rules:
          "rules_version = '2'; service cloud.firestore { match /databases/{d}/documents { match /{p=**} { allow read: if false; } } }",
      },
      ctx,
    );
    expect(invalidFirestoreInstance.ok).toBe(false);
    expect(invalidFirestoreInstance.summary).toContain('Realtime Database rules');
  });
});
