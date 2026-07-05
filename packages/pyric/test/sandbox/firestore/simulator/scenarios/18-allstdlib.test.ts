/**
 * Scenario 18: All 9 Stdlib Modules
 *
 * Exercises every stdlib module in a single ruleset: auth, validation, lobby,
 * turns, state, membership, lifecycle, transitions, geometry.
 * Games with lobby/turn/state/geometry, profiles with isOwner/hasOnly,
 * guilds with isMemberOf/hasClaim.
 * Stdlib: auth, validation, lobby, turns, state, membership, lifecycle, transitions, geometry
 *
 * Rules: examples/scenarios/18-allstdlib.rules
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { resolveModules } from 'pyric/rules/node';

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

      // Lobby create
      allow create: if validCreate()
          && hasRequired(['host', 'guest', 'status', 'currentTurn', 'moveCount', 'a1', 'b1', 'c1']);

      // Lobby join
      allow update: if validJoin()
          && fieldUnchanged('currentTurn')
          && fieldUnchanged('moveCount');

      // Cancel
      allow delete: if canCancel();

      // Move with geometry + turns + state
      allow update: if isAuthenticated()
          && request.resource.data.moveType == 'move'
          && isPlaying()
          && isMyTurn()
          && turnFlipped()
          && moveIncremented()
          && participantsUnchanged()
          && validSimpleMove(config());

      // Win claim with transition
      allow update: if isAuthenticated()
          && request.resource.data.moveType == 'win'
          && isPlaying()
          && validTransition('status', 'playing', 'won')
          && participantsUnchanged()
          && fieldUnchanged('moveCount');

      // Admin override
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

describe('Scenario 18: All 9 Stdlib Modules', () => {
  // Stateful env for lobby tests
  const lobbyEnv = new LocalEnvironment();
  lobbyEnv.seed({
    rules: RULES,
    documents: {
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
    },
  });

  function makeEnv() {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES,
      documents: {
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
      },
    });
    return env;
  }

  // ═══ LOBBY (stateful) ═══

  test('create game (lobby)', () => {
    const r = lobbyEnv.execute({ method: 'create', path: 'games/g1', auth: { uid: 'alice' }, data: { host: 'alice', guest: '', status: 'waiting', currentTurn: 'host', moveCount: 0, a1: 'pawn', b1: '', c1: 'pawn' } });
    expect(r.allowed).toBe(true);
  });

  test('join game (lobby)', () => {
    const r = lobbyEnv.execute({ method: 'update', path: 'games/g1', auth: { uid: 'bob' }, data: { host: 'alice', guest: 'bob', status: 'playing', currentTurn: 'host', moveCount: 0, a1: 'pawn', b1: '', c1: 'pawn' } });
    expect(r.allowed).toBe(true);
  });

  test('cancel game (lobby on g2)', () => {
    // Create a second game to cancel (don't destroy g1)
    lobbyEnv.execute({ method: 'create', path: 'games/g2', auth: { uid: 'carol' }, data: { host: 'carol', guest: '', status: 'waiting', currentTurn: 'host', moveCount: 0, a1: 'pawn', b1: '', c1: 'pawn' } });
    const r = lobbyEnv.execute({ method: 'delete', path: 'games/g2', auth: { uid: 'carol' } });
    expect(r.allowed).toBe(true);
  });

  // ═══ PROFILES ═══

  test('create profile (isOwner)', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'profiles/bob', auth: { uid: 'bob' }, data: { displayName: 'Bob', level: 1 } });
    expect(r.allowed).toBe(true);
  });

  test('update profile (hasOnly)', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'profiles/alice', auth: { uid: 'alice' }, data: { displayName: 'Alice2', level: 6, bio: 'Updated' } });
    expect(r.allowed).toBe(true);
  });

  test('cannot create profile for others', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'profiles/bob', auth: { uid: 'alice' }, data: { displayName: 'Bob', level: 1 } });
    expect(r.allowed).toBe(false);
  });

  // ═══ GUILDS ═══

  test('create guild (isMemberOf)', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'guilds/g2', auth: { uid: 'carol' }, data: { name: 'Beta Guild', members: { carol: 'admin' } } });
    expect(r.allowed).toBe(true);
  });

  test('update guild (hasClaim)', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'guilds/g1', auth: { uid: 'alice', token: { role_guild_admin: true } }, data: { name: 'Alpha Guild Renamed', members: { alice: 'admin', bob: 'member' } } });
    expect(r.allowed).toBe(true);
  });

  test('non-member guild denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'guilds/g1', auth: { uid: 'carol', token: { role_guild_admin: true } }, data: { name: 'Hacked', members: { alice: 'admin', bob: 'member' } } });
    expect(r.allowed).toBe(false);
  });

  // ═══ ADMIN OVERRIDE ═══

  test('admin override (hasClaim)', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'games/g_play', auth: { uid: 'superadmin', token: { role_admin: true } }, data: { host: 'alice', guest: 'bob', status: 'cancelled', currentTurn: 'host', moveCount: 0, a1: 'pawn', b1: '', c1: 'pawn', moveFrom: '', moveTo: '', moveType: 'admin_override' } });
    expect(r.allowed).toBe(true);
  });

  // ═══ MORE DENY ═══

  test('profile extra field denied (hasOnly)', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'profiles/alice', auth: { uid: 'alice' }, data: { displayName: 'Alice', level: 5, bio: 'Hello', secret: 'hack' } });
    expect(r.allowed).toBe(false);
  });

  test('non-admin override denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'games/g_play', auth: { uid: 'nobody' }, data: { host: 'alice', guest: 'bob', status: 'cancelled', currentTurn: 'host', moveCount: 0, a1: 'pawn', b1: '', c1: 'pawn', moveFrom: '', moveTo: '', moveType: 'admin_override' } });
    expect(r.allowed).toBe(false);
  });

  test('unauthenticated guild denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'guilds/g3', auth: null, data: { name: 'Anon Guild', members: { anon: 'admin' } } });
    expect(r.allowed).toBe(false);
  });
});
