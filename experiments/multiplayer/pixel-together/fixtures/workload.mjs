import { readFileSync } from 'node:fs';
export const workload = {
  revision: 4,
  actors: ['alice', 'bob', 'outsider', null],
  fixture: {
    'boards/main': { grid: ['white', 'white'] },
    'pairedBoards/main/colorClaims/red': { uid: null, epoch: 0 },
    'pairedBoards/main/colorClaims/blue': { uid: null, epoch: 0 },
    'pairedBoards/main/memberClaims/alice': { color: null, epoch: 0 },
    'pairedBoards/main/memberClaims/bob': { color: null, epoch: 0 },
  },
  schedule: 'both read initial; alice commits cell 0 red; bob commits cell 1 blue; retry reads latest',
  claimsSchedule: 'both read vacant red; alice claims; bob retries; non-owner draw and release denied; owner release; bob claims; former owner draw denied',
  assertionsRevision: 4,
  pairedSchedules: ['same user races red versus blue', 'two users race red', 'direct incomplete or mismatched batches', 'blocked and successful switches, release and reacquisition, stale payloads'],
  contentionSchedules: ['bob reads released red, alice reacquires, bob retries', 'drawing reads claim then ownership transfers before commit', 'stale release after different UID reacquires', 'same UID concurrently acquires red and blue', 'both read absent pixel; red commits, blue retries and commits; listeners settle'],
  extendedSchedules: ['same cell: alice red acknowledged before bob blue', 'ABA: alice claim, release, same UID reclaim, deliver old write', 'resubscribe: detach listener, commit blue, attach listener again'],
};
export const rules = readFileSync(new URL('../architecture/firestore.rules', import.meta.url), 'utf8');
