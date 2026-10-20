import { describe, expect, test } from 'bun:test';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import { getAdminDatabase } from 'pyric/database';
import { callMethod } from '../../../../../src/bridge/surface/method-call.js';
import { methodByKey } from '../../../../../src/bridge/surface/methods/registry.js';
import { createSurfaceContext } from '../../../../../src/bridge/surface/context.js';

const SHARD_RULES = JSON.stringify({
  rules: {
    spaces: {
      $spaceId: {
        '.read':
          'auth != null && root.child("spaces").child($spaceId).child("members").child(auth.uid).exists()',
        '.write':
          'auth != null && root.child("spaces").child($spaceId).child("members").child(auth.uid).child("role").val() === "admin"',
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
  test('installs, lints, simulates, and explains denials independently across default and named RTDB shards', async () => {
    const sandbox = createSandboxRoot({ projectId: 'digchatapp' });
    const ctx = createSurfaceContext(sandbox, process.cwd());

    // Seed auth users
    await callMethod(methodByKey('auth.createUser'), { uid: 'alice', email: 'alice@example.com' }, ctx);
    await callMethod(methodByKey('auth.createUser'), { uid: 'bob', email: 'bob@example.com' }, ctx);

    // Install rules on brand-new empty shard BEFORE any data exists on digchatapp-shard-0
    const installShard = await callMethod(
      methodByKey('rules.set'),
      { service: 'database', instance: 'digchatapp-shard-0', rules: SHARD_RULES },
      ctx,
    );
    expect(installShard.ok).toBe(true);
    expect(installShard.summary).toContain('digchatapp-shard-0');

    // Install completely separate rules on default RTDB instance
    const installDefault = await callMethod(
      methodByKey('rules.set'),
      { service: 'database', rules: DEFAULT_RULES },
      ctx,
    );
    expect(installDefault.ok).toBe(true);
    expect(installDefault.summary).toBe('Database rules installed.');

    // Write space data onto digchatapp-shard-0 via surface `database.set`
    const writeMember = await callMethod(
      methodByKey('database.set'),
      { instance: 'digchatapp-shard-0', path: 'spaces/space-1/members/alice', value: { role: 'admin' } },
      ctx,
    );
    expect(writeMember.ok).toBe(true);
    const writeTitle = await callMethod(
      methodByKey('database.set'),
      { instance: 'digchatapp-shard-0', path: 'spaces/space-1/title', value: 'Botanical Solarium' },
      ctx,
    );
    expect(writeTitle.ok).toBe(true);

    // Lint against digchatapp-shard-0
    const lintShard = await callMethod(
      methodByKey('rules.lint'),
      { service: 'database', instance: 'digchatapp-shard-0' },
      ctx,
    );
    expect(lintShard).toEqual({ ok: true, summary: expect.stringContaining('digchatapp-shard-0'), data: { issues: expect.any(Array) } });

    // Simulate Alice (authorized member) vs Bob (non-member) reading spaces/space-1 on digchatapp-shard-0
    const aliceSim = await callMethod(
      methodByKey('rules.simulate'),
      {
        service: 'database',
        instance: 'digchatapp-shard-0',
        operation: 'read',
        path: 'spaces/space-1',
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
        instance: 'digchatapp-shard-0',
        operation: 'read',
        path: 'spaces/space-1',
        uid: 'bob',
      },
      ctx,
    );
    expect(bobSim.ok).toBe(true);
    expect((bobSim.data as { allowed?: boolean }).allowed).toBe(false);

    // Explain Bob's denial on digchatapp-shard-0
    const bobExplain = await callMethod(
      methodByKey('rules.explainDenial'),
      {
        service: 'database',
        instance: 'digchatapp-shard-0',
        operation: 'read',
        path: 'spaces/space-1',
        uid: 'bob',
      },
      ctx,
    );
    expect(bobExplain.ok).toBe(true);
    expect(bobExplain.summary).toContain('digchatapp-shard-0');
    expect((bobExplain.data as { allowed?: boolean }).allowed).toBe(false);

    // Rejects `instance` cleanly when passed for non-database services (`firestore`, `storage`)
    const invalidFirestoreInstance = await callMethod(
      methodByKey('rules.set'),
      {
        service: 'firestore',
        instance: 'digchatapp-shard-0',
        rules:
          "rules_version = '2'; service cloud.firestore { match /databases/{d}/documents { match /{p=**} { allow read: if false; } } }",
      },
      ctx,
    );
    expect(invalidFirestoreInstance.ok).toBe(false);
    expect(invalidFirestoreInstance.summary).toContain('Realtime Database rules');
  });
});
