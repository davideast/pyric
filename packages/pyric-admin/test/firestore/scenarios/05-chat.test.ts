/**
 * Scenario 5: Chat Rooms with Moderation
 *
 * Room membership via members map, banned users blocked, moderator delete
 * powers, author-only edits with immutable authorId.
 * Stdlib: membership, auth, lifecycle
 *
 * Rules: examples/scenarios/05-chat.rules
 *
 * Migrated through `@pyric/sandbox` — operations dispatch through
 * `getFirestore(sandbox)` instead of `LocalEnvironment.execute`.
 */
import { describe, test, expect } from 'bun:test';
import { resolveModules } from 'pyric/rules/node';
import { makeRoot, runOp } from './_helpers.js';

const SOURCE = `import { isMemberOf, hasRole } from 'membership';
import { isAuthenticated } from 'auth';
import { fieldUnchanged } from 'lifecycle';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      allow read: if isAuthenticated()
          && isMemberOf(resource.data.members);
      allow create: if isAuthenticated()
          && request.resource.data.createdBy == request.auth.uid
          && request.auth.uid in request.resource.data.members;
      allow update: if isAuthenticated()
          && hasRole(resource.data.members, 'moderator');
      allow delete: if false;

      match /messages/{messageId} {
        allow read: if isAuthenticated()
            && isMemberOf(get(/databases/$(database)/documents/rooms/$(roomId)).data.members);
        allow create: if isAuthenticated()
            && isMemberOf(get(/databases/$(database)/documents/rooms/$(roomId)).data.members)
            && get(/databases/$(database)/documents/rooms/$(roomId)).data.members[request.auth.uid] != 'banned'
            && request.resource.data.authorId == request.auth.uid
            && request.resource.data.body.size() > 0;
        allow update: if isAuthenticated()
            && resource.data.authorId == request.auth.uid
            && fieldUnchanged('authorId')
            && request.resource.data.body.size() > 0;
        allow delete: if isAuthenticated()
            && (resource.data.authorId == request.auth.uid
                || hasRole(get(/databases/$(database)/documents/rooms/$(roomId)).data.members, 'moderator'));
      }
    }
  }
}`;

const resolved = resolveModules(SOURCE);
if (!resolved.success) throw new Error(resolved.error.message);
const RULES = resolved.data.resolved;

const SEED = {
  'rooms/r1': { name: 'General', createdBy: 'alice', members: { alice: 'moderator', bob: 'member', carol: 'member', banned1: 'banned' } },
  'rooms/r1/messages/m1': { authorId: 'bob', body: 'Hello everyone!' },
  'rooms/r1/messages/m2': { authorId: 'carol', body: 'Hi Bob!' },
};

describe('Scenario 5: Chat Rooms with Moderation', () => {
  test('member sends message', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'rooms/r1/messages/m3', auth: { uid: 'bob' }, data: { authorId: 'bob', body: 'New message' } });
    expect(r.allowed).toBe(true);
  });

  test('author edits own message', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'rooms/r1/messages/m1', auth: { uid: 'bob' }, data: { authorId: 'bob', body: 'Edited message' } });
    expect(r.allowed).toBe(true);
  });

  test('author deletes own message', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'delete', path: 'rooms/r1/messages/m1', auth: { uid: 'bob' } });
    expect(r.allowed).toBe(true);
  });

  test('moderator deletes any message', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'delete', path: 'rooms/r1/messages/m1', auth: { uid: 'alice' } });
    expect(r.allowed).toBe(true);
  });

  test('create room', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'rooms/r2', auth: { uid: 'dave' }, data: { name: 'Dev Chat', createdBy: 'dave', members: { dave: 'moderator' } } });
    expect(r.allowed).toBe(true);
  });

  test('non-member blocked', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'rooms/r1/messages/m4', auth: { uid: 'stranger' }, data: { authorId: 'stranger', body: 'Intruder' } });
    expect(r.allowed).toBe(false);
  });

  test('banned user blocked', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'rooms/r1/messages/m5', auth: { uid: 'banned1' }, data: { authorId: 'banned1', body: 'Spam' } });
    expect(r.allowed).toBe(false);
  });

  test('empty message blocked', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'rooms/r1/messages/m6', auth: { uid: 'bob' }, data: { authorId: 'bob', body: '' } });
    expect(r.allowed).toBe(false);
  });

  test('non-author cannot edit', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'rooms/r1/messages/m1', auth: { uid: 'carol' }, data: { authorId: 'bob', body: 'Hijacked' } });
    expect(r.allowed).toBe(false);
  });

  test('non-author non-mod cannot delete', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'delete', path: 'rooms/r1/messages/m1', auth: { uid: 'carol' } });
    expect(r.allowed).toBe(false);
  });

  test('spoof authorId denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'rooms/r1/messages/m7', auth: { uid: 'bob' }, data: { authorId: 'alice', body: 'Impersonation' } });
    expect(r.allowed).toBe(false);
  });

  test('tamper authorId denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'rooms/r1/messages/m1', auth: { uid: 'bob' }, data: { authorId: 'carol', body: 'Hello everyone!' } });
    expect(r.allowed).toBe(false);
  });

  test('unauthenticated denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'rooms/r1/messages/m8', auth: null, data: { authorId: 'anon', body: 'Anonymous' } });
    expect(r.allowed).toBe(false);
  });
});
