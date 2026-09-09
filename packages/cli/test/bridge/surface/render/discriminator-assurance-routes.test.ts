/**
 * The assurance family as the discriminator variant spells it: every action
 * reaches a canonical operation, and the JSON-encoded parameters translate
 * back into the objects the methods take.
 */
import { describe, expect, it } from 'bun:test';

import { ASSURANCE_ROUTES } from '../../../../src/bridge/surface/render/discriminator-assurance-routes.js';
import { CANONICAL_OPERATION_IDS } from '../../../../src/bridge/surface/render/canonical-dispatch.js';

/** One route by the action it answers to. */
function route(action: string) {
  const found = ASSURANCE_ROUTES.find((candidate) => candidate.action === action);
  if (found === undefined) throw new Error(`no assurance route for action '${action}'`);
  return found;
}

describe('the assurance routes', () => {
  it('names only operations the canonical vocabulary carries', () => {
    for (const candidate of ASSURANCE_ROUTES) {
      expect(CANONICAL_OPERATION_IDS).toContain(candidate.operation);
    }
  });

  it('reaches every assurance operation exactly once', () => {
    const reached = ASSURANCE_ROUTES.map((candidate) => candidate.operation);
    expect(new Set(reached).size).toBe(reached.length);
    const assurance = CANONICAL_OPERATION_IDS.filter((id) => id.includes('_assurance_'));
    expect([...reached].sort()).toEqual([...assurance].sort());
  });

  it('keeps the conformance check on the tool whose discriminator already spelled it', () => {
    expect(route('check_conformance').tool).toBe('verify_security_rules');
    expect(route('replay_session').tool).toBe('judge_authorization_risk');
  });

  it('translates a replay call into the method argument names', () => {
    const translated = route('replay_session').translate({
      sessionPath: '.pyric/last-session.json',
      candidateRules: 'rules_version = "2";',
      service: 'database',
    });
    expect(translated).toEqual({
      sessionPath: '.pyric/last-session.json',
      candidateRules: 'rules_version = "2";',
      service: 'database',
    });
  });

  it('parses the JSON-encoded records each campaign action carries', () => {
    expect(
      route('define').translate({ campaignId: 'orders', recordsJson: '[{"id":"one"}]' }),
    ).toEqual({ campaignId: 'orders', invariants: [{ id: 'one' }] });
    expect(
      route('start').translate({ campaignId: 'orders', targetJson: '{"network":"forbid"}' }),
    ).toEqual({ campaignId: 'orders', target: { network: 'forbid' } });
    expect(route('map').translate({ campaignId: 'orders', recordsJson: '[{"id":"anon"}]' })).toEqual(
      { campaignId: 'orders', actors: [{ id: 'anon' }] },
    );
  });

  it('carries the confirmation a hosted run needs rather than supplying one', () => {
    const translated = route('test_rules_hosted').translate({
      candidateRules: 'rules_version = "2";',
      casesJson: '[{"description":"one"}]',
    });
    expect(translated.confirm).toBeUndefined();
    expect(translated.service).toBe('firestore');
    expect(translated.cases).toEqual([{ description: 'one' }]);
  });

  it('names the probe every probe-scoped action acts on', () => {
    for (const action of ['inspect', 'minimize']) {
      expect(route(action).translate({ campaignId: 'orders', probeId: 'probe-1' })).toEqual({
        campaignId: 'orders',
        probeId: 'probe-1',
      });
    }
  });
});
