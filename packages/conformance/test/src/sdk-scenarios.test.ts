import { describe, expect, it } from 'bun:test';
import { loadObservations } from '../../observations/load.ts';
import { loadFirestoreScenarios, loadRtdbScenarios } from '../../src/capture/sdk-scenarios/load-scenarios.ts';
import { replayMismatches } from '../../src/capture/sdk-scenarios/replay-comparison.ts';

describe('SDK behavior scenarios', () => {
  it('each scenario owns a committed observation with the same rowIds and description', async () => {
    const observations = new Map(loadObservations().map((obs) => [obs.name, obs]));
    const scenarios = [...await loadFirestoreScenarios(), ...await loadRtdbScenarios()];
    expect(scenarios.length).toBeGreaterThan(0);
    const drift = scenarios.flatMap(({ observation }) => {
      const committed = observations.get(observation.name);
      if (!committed) return [`${observation.name}: no committed observation`];
      const problems: string[] = [];
      if (JSON.stringify(committed.rowIds) !== JSON.stringify(observation.rowIds)) problems.push(`${observation.name}: rowIds differ`);
      if (committed.raw.description !== observation.description) problems.push(`${observation.name}: description differs`);
      return problems;
    });
    expect(drift).toEqual([]);
  });

  it('a replay passes when pyric matches production or a pin holds both answers', () => {
    const production = { a: 1, b: { code: 'invalid-argument' } };
    const pin = { key: 'b', finding: 'X-1', production: { code: 'invalid-argument' }, pyric: { ok: true } };
    expect(replayMismatches({ production, pyric: { a: 1, b: { ok: true } }, pins: [pin] })).toEqual([]);
  });

  it('a replay fails when an unpinned key differs, a pinned side moves, or a pin names a missing key', () => {
    const production = { a: 1, b: { code: 'invalid-argument' } };
    const pin = { key: 'b', finding: 'X-1', production: { code: 'invalid-argument' }, pyric: { ok: true } };
    expect(replayMismatches({ production, pyric: { a: 2, b: { ok: true } }, pins: [pin] })).toHaveLength(1);
    expect(replayMismatches({ production, pyric: { a: 1, b: { code: 'invalid-argument' } }, pins: [pin] })).toHaveLength(1);
    expect(replayMismatches({ production, pyric: { a: 1, b: {} }, pins: [pin, { ...pin, key: 'c' }] })).toHaveLength(2);
  });

  it('notCompared keys are skipped', () => {
    expect(replayMismatches({ production: { a: 1 }, pyric: { a: 2 }, notCompared: { a: 'did not settle' } })).toEqual([]);
  });
});
