import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { runAuthorizationCampaign, type AuthorizationCampaignSpec } from '@pyric/cli/assurance';
import { toRuleDecision } from './model.js';
import { explainDenial } from '../rules-debug/model.js';

// Runs the CLI evidence collector, report JSON boundary, and Studio projection together.
test('Assurance preserves primary proof attribution through a serialized report', async () => {
  const operation = {
    service: 'firestore' as const, method: 'list' as const, path: 'meets',
    query: { where: [{ field: 'status', op: '==' as const, value: 'scheduled' }], limit: 100 },
  };
  const spec: AuthorizationCampaignSpec = {
    schema: 'pyric.assurance.campaign.v1', id: 'proof-attribution',
    target: {schema: 'pyric.assurance.target.v1', network: 'forbid',
      rules: {firestore: `rules_version = '2'; service cloud.firestore {
        match /databases/{database}/documents {
          match /meets/{id} {
            allow list: if resource.data.status in ['scheduled'];
            allow read: if false;
          }
        }
      }`}, state: {firestore: {}}},
    actors: [{id: 'visitor', acquisition: {kind: 'anonymous-request'}}],
    invariants: [{id: 'query', service: 'firestore', statement: 'Queries must be authorized.',
      expected: 'DENY', source: 'declared', confidence: 'authoritative'}],
    probes: [{id: 'query', actorId: 'visitor', invariantId: 'query', control: {...operation, query: {...operation.query, limit: 50}},
      mutation: {dimension: 'query', description: 'Exercise the proof limitation.', operation}}],
  };
  const report = await runAuthorizationCampaign(spec);
  const restored: typeof report = JSON.parse(JSON.stringify(report));
  const result = restored.results[0]!;
  const decision = toRuleDecision(result);
  expect(decision?.queryProof?.kind).toBe('unsupported-predicate');
  expect(decision?.queryProof?.failures[0]?.rule?.expression).toContain('status in');
  expect(decision?.evaluatedRule?.expression).toBe('false');
  expect(explainDenial(decision!).headline).toContain('Query proof unsupported');
  expect(explainDenial(decision!).ruleExpression).toContain('status in');
  for (const event of result.mutation.events) delete event.queryProof;
  expect(toRuleDecision(result)?.queryProof).toBeUndefined();
});
