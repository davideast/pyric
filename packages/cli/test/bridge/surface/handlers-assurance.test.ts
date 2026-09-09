/**
 * The assurance methods, exercised against the same sandbox every other
 * method record is exercised against.
 *
 * Each assertion is on what an engine decided: the verdict a candidate
 * ruleset changes, the classification a probe run reached, the fields the
 * minimizer removed, and the file an export left behind. The campaign is the
 * shared fixture, built so the run loop has a real counterexample to find.
 */
import { afterAll, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { canIUse } from '../../../src/conformance/index.js';
import {
  ALICE_ACTOR,
  ALICE_NOTE_RULES,
  NO_NOTE_RULES,
  OPEN_ORDER_RULES,
  OPEN_ORDER_TARGET,
  OWNER_ONLY_INVARIANT,
  OWNER_ORDER_RULES,
  OWNER_WRITE_OBSERVATION,
  PAYLOAD_MUTATION,
  PAYLOAD_PROBE_ID,
  recordNoteSession,
  writeCapture,
} from './assurance-fixture.js';
import { finishHandlerSuite, projectDir, run } from './handler-harness.js';

afterAll(() => finishHandlerSuite('assurance'));

it('replays a capture, decides its cases, and reads a conformance claim', async () => {
  writeCapture(projectDir, '.pyric/last-session.json', await recordNoteSession());

  const broken = await run('assurance.replaySession', { candidateRules: NO_NOTE_RULES });
  const divergences = (broken.data as { divergences: Array<Record<string, unknown>> }).divergences;
  const welcome = divergences.find((entry) => entry.path === 'notes/welcome');
  expect(welcome?.recorded).toBe('allow');
  expect(welcome?.candidate).toBe('deny');

  const kept = await run('assurance.verifyCases', { candidateRules: ALICE_NOTE_RULES });
  expect((kept.data as { diverged: number }).diverged).toBe(0);

  const claimed = await run('assurance.canIUse', { feature: 'setDoc' });
  expect((claimed.data as { match: string }).match).toBe(canIUse('setDoc').match);
});

it('drives a campaign from attach through export and finds a real counterexample', async () => {
  const attached = await run('assurance.attach', { campaignId: 'live-copy' });
  expect((attached.data as { campaignId: string }).campaignId).toBe('live-copy');

  const started = await run('assurance.start', {
    campaignId: 'orders',
    target: OPEN_ORDER_TARGET,
  });
  expect(started.ok).toBe(true);

  await run('assurance.map', {
    campaignId: 'orders',
    actors: [ALICE_ACTOR],
    observations: [OWNER_WRITE_OBSERVATION],
  });
  await run('assurance.define', { campaignId: 'orders', invariants: [OWNER_ONLY_INVARIANT] });
  const proposed = await run('assurance.propose', {
    campaignId: 'orders',
    observationId: OWNER_WRITE_OBSERVATION.id,
    invariantId: OWNER_ONLY_INVARIANT.id,
    mutations: [PAYLOAD_MUTATION],
  });
  expect(proposed.ok).toBe(true);

  const ran = await run('assurance.run', { campaignId: 'orders' });
  expect((ran.data as { summary: { localCounterexamples: number } }).summary.localCounterexamples)
    .toBe(1);

  const inspected = await run('assurance.inspect', {
    campaignId: 'orders',
    probeId: PAYLOAD_PROBE_ID,
  });
  expect((inspected.data as { result: { classification: string } }).result.classification).toBe(
    'local-counterexample',
  );

  const minimized = await run('assurance.minimize', {
    campaignId: 'orders',
    probeId: PAYLOAD_PROBE_ID,
  });
  const shrunk = minimized.data as { changed: boolean; removedPayloadFields: string[] };
  expect(shrunk.changed).toBe(true);
  expect(shrunk.removedPayloadFields.length).toBeGreaterThan(0);

  const verified = await run('assurance.verify', {
    campaignId: 'orders',
    rules: { firestore: OWNER_ORDER_RULES },
  });
  expect((verified.data as { verified: boolean }).verified).toBe(true);

  const exported = await run('assurance.export', {
    campaignId: 'orders',
    path: '.pyric/assurance/orders.json',
  });
  expect(exported.ok).toBe(true);
  expect(existsSync(join(projectDir, '.pyric/assurance/orders.json'))).toBe(true);
});

it('refuses the hosted rules test on a server that did not opt in to production', async () => {
  const refused = await run('assurance.testRulesHosted', {
    service: 'firestore',
    rules: OPEN_ORDER_RULES,
    cases: [{ description: 'owner reads', expectation: 'ALLOW', method: 'get', path: 'orders/o1' }],
    confirm: true,
  });
  expect(refused.ok).toBe(false);
  expect(refused.summary).toContain('--allow-production');
});
