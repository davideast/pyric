/**
 * Scenario 10: Card Game with Phases
 *
 * 5-phase cyclic game (deal->bid->play->score->deal), bid validation,
 * turn enforcement, host privileges, round tracking.
 * Stdlib: transitions, auth, lifecycle, membership
 *
 * Rules: inline
 *
 * Migrated through `pyric/sandbox` — operations dispatch through
 * `getFirestore(sandbox)` instead of `LocalEnvironment.execute`.
 */
import { describe, test, expect } from 'bun:test';
import { resolveModules } from 'pyric/rules/internal/node';
import { makeRoot, runOp } from './_helpers.js';

const SOURCE = `import { validTransition } from 'transitions';
import { isAuthenticated } from 'auth';
import { fieldUnchanged } from 'lifecycle';
import { isMemberOf } from 'membership';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /cardgames/{gameId} {
      allow read: if true;
      allow create: if isAuthenticated()
          && request.resource.data.host == request.auth.uid
          && request.auth.uid in request.resource.data.players
          && request.resource.data.phase == 'deal'
          && request.resource.data.round == 1
          && request.resource.data.currentBid == 0
          && request.resource.data.currentPlayer == request.resource.data.host;
      allow update: if isAuthenticated()
          && isMemberOf(resource.data.players)
          && fieldUnchanged('players')
          && fieldUnchanged('host')
          && (
            // deal -> bid (host only)
            (validTransition('phase', 'deal', 'bid')
              && request.auth.uid == resource.data.host
              && fieldUnchanged('round')
              && request.resource.data.currentBid == 0)

            // bid -> bid (higher bid, by current player)
            || (resource.data.phase == 'bid' && request.resource.data.phase == 'bid'
              && request.auth.uid == resource.data.currentPlayer
              && request.resource.data.currentBid > resource.data.currentBid
              && fieldUnchanged('round'))

            // bid -> play (current player ends bidding)
            || (validTransition('phase', 'bid', 'play')
              && request.auth.uid == resource.data.currentPlayer
              && fieldUnchanged('round'))

            // play -> play (current player plays a card)
            || (resource.data.phase == 'play' && request.resource.data.phase == 'play'
              && request.auth.uid == resource.data.currentPlayer
              && fieldUnchanged('round'))

            // play -> score (current player ends play)
            || (validTransition('phase', 'play', 'score')
              && request.auth.uid == resource.data.currentPlayer
              && fieldUnchanged('round'))

            // score -> deal (host starts new round, round increments)
            || (validTransition('phase', 'score', 'deal')
              && request.auth.uid == resource.data.host
              && request.resource.data.round == resource.data.round + 1
              && request.resource.data.currentBid == 0)

            // end game (from score, host only)
            || (validTransition('phase', 'score', 'finished')
              && request.auth.uid == resource.data.host
              && fieldUnchanged('round'))
          );
      allow delete: if false;
    }
  }
}`;

const resolved = resolveModules(SOURCE);
if (!resolved.success) throw new Error(resolved.error.message);
const RULES = resolved.data.resolved;

const SEED = {
  'cardgames/g1': { host: 'alice', players: { alice: true, bob: true, carol: true }, phase: 'deal', round: 1, currentBid: 0, currentPlayer: 'alice', lastCard: '' },
  'cardgames/g2': { host: 'alice', players: { alice: true, bob: true }, phase: 'bid', round: 1, currentBid: 5, currentPlayer: 'bob', lastCard: '' },
  'cardgames/g3': { host: 'alice', players: { alice: true, bob: true }, phase: 'play', round: 1, currentBid: 10, currentPlayer: 'alice', lastCard: '' },
  'cardgames/g4': { host: 'alice', players: { alice: true, bob: true }, phase: 'score', round: 2, currentBid: 15, currentPlayer: 'alice', lastCard: '' },
};

describe('Scenario 10: Card Game with Phases', () => {
  test('create game', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'cardgames/g5', auth: { uid: 'alice' }, data: { host: 'alice', players: { alice: true, bob: true }, phase: 'deal', round: 1, currentBid: 0, currentPlayer: 'alice', lastCard: '' } });
    expect(r.allowed).toBe(true);
  });

  test('deal to bid', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'cardgames/g1', auth: { uid: 'alice' }, data: { phase: 'bid', currentBid: 0 } });
    expect(r.allowed).toBe(true);
  });

  test('bid higher', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'cardgames/g2', auth: { uid: 'bob' }, data: { phase: 'bid', currentBid: 10 } });
    expect(r.allowed).toBe(true);
  });

  test('bid to play', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'cardgames/g2', auth: { uid: 'bob' }, data: { phase: 'play' } });
    expect(r.allowed).toBe(true);
  });

  test('play card', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'cardgames/g3', auth: { uid: 'alice' }, data: { phase: 'play', lastCard: 'ace_spades', currentPlayer: 'bob' } });
    expect(r.allowed).toBe(true);
  });

  test('play to score', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'cardgames/g3', auth: { uid: 'alice' }, data: { phase: 'score' } });
    expect(r.allowed).toBe(true);
  });

  test('score to deal (round increments)', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'cardgames/g4', auth: { uid: 'alice' }, data: { phase: 'deal', round: 3, currentBid: 0 } });
    expect(r.allowed).toBe(true);
  });

  test('end game (score to finished)', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'cardgames/g4', auth: { uid: 'alice' }, data: { phase: 'finished' } });
    expect(r.allowed).toBe(true);
  });

  test('bid not higher denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'cardgames/g2', auth: { uid: 'bob' }, data: { phase: 'bid', currentBid: 3 } });
    expect(r.allowed).toBe(false);
  });

  test('non-current player denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'cardgames/g2', auth: { uid: 'alice' }, data: { phase: 'bid', currentBid: 10 } });
    expect(r.allowed).toBe(false);
  });

  test('skip phases denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'cardgames/g1', auth: { uid: 'alice' }, data: { phase: 'play' } });
    expect(r.allowed).toBe(false);
  });

  test('non-player denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'cardgames/g1', auth: { uid: 'dave' }, data: { phase: 'bid', currentBid: 0 } });
    expect(r.allowed).toBe(false);
  });

  test('tamper players denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'cardgames/g1', auth: { uid: 'alice' }, data: { phase: 'bid', currentBid: 0, players: { alice: true, bob: true, carol: true, dave: true } } });
    expect(r.allowed).toBe(false);
  });

  test('tamper round denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'cardgames/g1', auth: { uid: 'alice' }, data: { phase: 'bid', currentBid: 0, round: 5 } });
    expect(r.allowed).toBe(false);
  });

  test('non-host score to deal denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'cardgames/g4', auth: { uid: 'bob' }, data: { phase: 'deal', round: 3, currentBid: 0 } });
    expect(r.allowed).toBe(false);
  });

  test('unauthenticated denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'cardgames/g1', auth: null, data: { phase: 'bid', currentBid: 0 } });
    expect(r.allowed).toBe(false);
  });
});
