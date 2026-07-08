import { describe, expect, it } from 'bun:test';
import { ROUTES } from '../../shell/routes.js';
import { fuzzyIncludes, matchCommands } from './command.js';

describe('home command matcher (navigation only, M4)', () => {
  it('matches tabs by prefix', () => {
    const results = matchCommands('fire', ROUTES);
    expect(results[0]).toMatchObject({ label: 'Go to Firestore', target: { tab: 'firestore' } });
  });

  it('matches tabs by fuzzy subsequence', () => {
    expect(fuzzyIncludes('rtb', 'RTDB')).toBe(true);
    const results = matchCommands('trfc', ROUTES);
    expect(results.some((r) => r.target.tab === 'traffic')).toBe(true);
  });

  it('never returns Settings (M4: no configuration in results)', () => {
    for (const q of ['settings', 'set', 's', 'configure']) {
      expect(matchCommands(q, ROUTES).some((r) => r.target.tab === 'settings')).toBe(false);
    }
  });

  it('builds a Firestore deep link from "<tab> <path>"', () => {
    const results = matchCommands('firestore users/alice', ROUTES);
    expect(results.some((r) => r.target.tab === 'firestore'
      && JSON.stringify(r.target.rest) === JSON.stringify(['users', 'alice']))).toBe(true);
  });

  it('builds a Firestore deep link from a bare slashed path', () => {
    const results = matchCommands('users/alice', ROUTES);
    expect(results[0]).toMatchObject({
      target: { tab: 'firestore', rest: ['users', 'alice'] },
    });
  });

  it('builds an Auth deep link from "auth <uid>"', () => {
    const results = matchCommands('auth u-123', ROUTES);
    expect(results.some((r) => r.target.tab === 'auth'
      && JSON.stringify(r.target.rest) === JSON.stringify(['u-123']))).toBe(true);
  });

  it('routes gs:// paths to Storage', () => {
    const results = matchCommands('gs://bucket/uploads/logo.png', ROUTES);
    expect(results[0]).toMatchObject({
      target: { tab: 'storage', rest: ['uploads', 'logo.png'] },
    });
  });

  it('routes "traffic <id>" to a denial focus', () => {
    const results = matchCommands('traffic evt-9', ROUTES);
    expect(results.some((r) => r.target.tab === 'traffic'
      && r.target.query?.denial === 'evt-9')).toBe(true);
  });

  it('returns nothing for empty input and caps result count', () => {
    expect(matchCommands('', ROUTES)).toEqual([]);
    expect(matchCommands('  ', ROUTES)).toEqual([]);
    expect(matchCommands('t', ROUTES).length).toBeLessThanOrEqual(7);
  });
});
