/**
 * Scenario 18: All 9 Stdlib Modules
 *
 * Exercises every stdlib module in a single ruleset: auth, validation, lobby,
 * turns, state, membership, lifecycle, transitions, geometry.
 * Stdlib: auth, validation, lobby, turns, state, membership, lifecycle, transitions, geometry
 *
 * Migrated through `@pyric/sandbox` — operations dispatch through
 * `getFirestore(sandbox)` instead of `LocalEnvironment.execute`.
 *
 * NOTE: Lobby tests are stateful — they share `lobbyRoot` so that 'create',
 * 'join', and 'cancel' operate on a single evolving environment. Forks
 * created via `makeRoot` delegate to the same root environment, so writes
 * persist across runOp calls within the lobby chain.
 */
import { describe, test, expect } from 'bun:test';
import { resolveModules } from 'pyric/rules/node';
import { makeRoot, runOp } from './_helpers.js';

const SOURCE = `import { isAuthenticated, isOwner } from 'auth';
import { hasRequired, hasOnly } from 'validation';
import { validCreate, validJoin, canCancel } from 'lobby';
import { isMyTurn, turnFlipped } from 'turns';
import { isPlaying, moveIncremented, participantsUnchanged } from 'state';
import { hasClaim, isMemberOf } from 'membership';
import { fieldUnchanged } from 'lifecycle';
import { validTransition } from 'transitions';
import { validSimpleMove } from 'geometry';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {

    match /gameConfig/{configId} {
      allow read: if true;
      allow write: if false;
    }

    match /games/{gameId} {
      function config() {
        return get(/databases/$(database)/documents/gameConfig/corridor).data;
      }

      allow read: if isAuthenticated();

      allow create: if validCreate()
          && hasRequired(['host', 'guest', 'status', 'currentTurn', 'moveCount', 'a1', 'b1', 'c1']);

      allow update: if validJoin()
          && fieldUnchanged('currentTurn')
          && fieldUnchanged('moveCount');

      allow delete: if canCancel();

      allow update: if isAuthenticated()
          && request.resource.data.moveType == 'move'
          && isPlaying()
          && isMyTurn()
          && turnFlipped()
          && moveIncremented()
          && participantsUnchanged()
          && validSimpleMove(config());

      allow update: if isAuthenticated()
          && request.resource.data.moveType == 'win'
          && isPlaying()
          && validTransition('status', 'playing', 'won')
          && participantsUnchanged()
          && fieldUnchanged('moveCount');

      allow update: if isAuthenticated()
          && hasClaim('role_admin')
          && request.resource.data.moveType == 'admin_override';
    }

    match /profiles/{userId} {
      allow read: if isAuthenticated();
      allow create: if isOwner(userId)
          && hasRequired(['displayName', 'level'])
          && hasOnly(['displayName', 'level', 'bio']);
      allow update: if isOwner(userId)
          && hasOnly(['displayName', 'level', 'bio']);
      allow delete: if isOwner(userId);
    }

    match /guilds/{guildId} {
      allow read: if isAuthenticated()
          && isMemberOf(resource.data.members);
      allow create: if isAuthenticated()
          && isMemberOf(request.resource.data.members)
          && hasRequired(['name', 'members']);
      allow update: if isAuthenticated()
          && isMemberOf(resource.data.members)
          && hasClaim('role_guild_admin');
      allow delete: if false;
    }
  }
}`;

const resolved = resolveModules(SOURCE);
if (!resolved.success) throw new Error(resolved.error.message);
const RULES = resolved.data.resolved;

const LOBBY_SEED = {
  'gameConfig/corridor': {
    moves: {
      pawn: {
        a1: { b1: true },
        b1: { a1: true, c1: true },
        c1: { b1: true },
      },
    },
  },
  'profiles/alice': { displayName: 'Alice', level: 5, bio: 'Hello' },
  'guilds/g1': { name: 'Alpha Guild', members: { alice: 'admin', bob: 'member' } },
};

const SEED = {
  'gameConfig/corridor': {
    moves: {
      pawn: {
        a1: { b1: true },
        b1: { a1: true, c1: true },
        c1: { b1: true },
      },
    },
  },
  'games/g_play': { host: 'alice', guest: 'bob', status: 'playing', currentTurn: 'host', moveCount: 0, a1: 'pawn', b1: '', c1: 'pawn', moveFrom: '', moveTo: '' },
  'profiles/alice': { displayName: 'Alice', level: 5, bio: 'Hello' },
  'guilds/g1': { name: 'Alpha Guild', members: { alice: 'admin', bob: 'member' } },
};

describe('Scenario 18: All 9 Stdlib Modules', () => {
  // Stateful root for lobby tests — forks share root environment
  const lobbyRoot = makeRoot(RULES, LOBBY_SEED);

  // ═══ LOBBY (stateful) ═══

  test('create game (lobby)', async () => {
    const r = await runOp(lobbyRoot, { method: 'create', path: 'games/g1', auth: { uid: 'alice' }, data: { host: 'alice', guest: '', status: 'waiting', currentTurn: 'host', moveCount: 0, a1: 'pawn', b1: '', c1: 'pawn' } });
    expect(r.allowed).toBe(true);
  });

  test('join game (lobby)', async () => {
    const r = await runOp(lobbyRoot, { method: 'update', path: 'games/g1', auth: { uid: 'bob' }, data: { host: 'alice', guest: 'bob', status: 'playing', currentTurn: 'host', moveCount: 0, a1: 'pawn', b1: '', c1: 'pawn' } });
    expect(r.allowed).toBe(true);
  });

  test('cancel game (lobby on g2)', async () => {
    await runOp(lobbyRoot, { method: 'create', path: 'games/g2', auth: { uid: 'carol' }, data: { host: 'carol', guest: '', status: 'waiting', currentTurn: 'host', moveCount: 0, a1: 'pawn', b1: '', c1: 'pawn' } });
    const r = await runOp(lobbyRoot, { method: 'delete', path: 'games/g2', auth: { uid: 'carol' } });
    expect(r.allowed).toBe(true);
  });

  // ═══ PROFILES ═══

  test('create profile (isOwner)', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'profiles/bob', auth: { uid: 'bob' }, data: { displayName: 'Bob', level: 1 } });
    expect(r.allowed).toBe(true);
  });

  test('update profile (hasOnly)', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'profiles/alice', auth: { uid: 'alice' }, data: { displayName: 'Alice2', level: 6, bio: 'Updated' } });
    expect(r.allowed).toBe(true);
  });

  test('cannot create profile for others', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'profiles/bob', auth: { uid: 'alice' }, data: { displayName: 'Bob', level: 1 } });
    expect(r.allowed).toBe(false);
  });

  // ═══ GUILDS ═══

  test('create guild (isMemberOf)', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'guilds/g2', auth: { uid: 'carol' }, data: { name: 'Beta Guild', members: { carol: 'admin' } } });
    expect(r.allowed).toBe(true);
  });

  test('update guild (hasClaim)', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'guilds/g1', auth: { uid: 'alice', token: { role_guild_admin: true } }, data: { name: 'Alpha Guild Renamed', members: { alice: 'admin', bob: 'member' } } });
    expect(r.allowed).toBe(true);
  });

  test('non-member guild denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'guilds/g1', auth: { uid: 'carol', token: { role_guild_admin: true } }, data: { name: 'Hacked', members: { alice: 'admin', bob: 'member' } } });
    expect(r.allowed).toBe(false);
  });

  // ═══ ADMIN OVERRIDE ═══

  test('admin override (hasClaim)', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'games/g_play', auth: { uid: 'superadmin', token: { role_admin: true } }, data: { host: 'alice', guest: 'bob', status: 'cancelled', currentTurn: 'host', moveCount: 0, a1: 'pawn', b1: '', c1: 'pawn', moveFrom: '', moveTo: '', moveType: 'admin_override' } });
    expect(r.allowed).toBe(true);
  });

  // ═══ MORE DENY ═══

  test('profile extra field denied (hasOnly)', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'profiles/alice', auth: { uid: 'alice' }, data: { displayName: 'Alice', level: 5, bio: 'Hello', secret: 'hack' } });
    expect(r.allowed).toBe(false);
  });

  test('non-admin override denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'games/g_play', auth: { uid: 'nobody' }, data: { host: 'alice', guest: 'bob', status: 'cancelled', currentTurn: 'host', moveCount: 0, a1: 'pawn', b1: '', c1: 'pawn', moveFrom: '', moveTo: '', moveType: 'admin_override' } });
    expect(r.allowed).toBe(false);
  });

  test('unauthenticated guild denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'guilds/g3', auth: null, data: { name: 'Anon Guild', members: { anon: 'admin' } } });
    expect(r.allowed).toBe(false);
  });
});
