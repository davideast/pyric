import { readFileSync } from 'node:fs';
export const workload = {
  revision: 2,
  actors: ['alice', 'bob', 'outsider', null],
  fixture: { 'boards/main': { grid: ['white', 'white'] } },
  schedule: 'both read initial; alice commits cell 0 red; bob commits cell 1 blue; retry reads latest',
  claimsSchedule: 'both read vacant red; alice claims; bob retries; non-owner draw and release denied; owner release; bob claims; former owner draw denied',
  assertionsRevision: 2,
  extendedSchedules: ['same cell: alice red acknowledged before bob blue', 'ABA: alice claim, release, same UID reclaim, deliver old write', 'resubscribe: detach listener, commit blue, attach listener again'],
};
export const rules = readFileSync(new URL('../architecture/firestore.rules', import.meta.url), 'utf8');
