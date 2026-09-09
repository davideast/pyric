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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCanIUse } from '../../../src/cli/can-i-use.js';
import {
  ALICE_ACTOR,
  ALICE_NOTE_RULES,
  NO_NOTE_RULES,
  OPEN_ORDER_TARGET,
  OWNER_ONLY_INVARIANT,
  OWNER_WRITE_OBSERVATION,
  PAYLOAD_MUTATION,
  PAYLOAD_PROBE_ID,
  recordNoteSession,
  writeCapture,
} from './assurance-fixture.js';
import { OPEN_ORDER_RULES, OWNER_ORDER_RULES } from '../../fixtures/order-rules.js';
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
  expect(claimed.ok).toBe(true);
});

it('names the first case that changed verdict when the cases diverge', async () => {
  writeCapture(projectDir, '.pyric/last-session.json', await recordNoteSession());

  const diverged = await run('assurance.verifyCases', { candidateRules: NO_NOTE_RULES });
  const decided = diverged.data as {
    diverged: number;
    cases: Array<{ agrees: boolean; method: string; path: string }>;
  };
  const first = decided.cases.find((entry) => !entry.agrees);
  if (first === undefined) throw new Error('no case diverged under rules that deny everything');
  expect(decided.diverged).toBe(decided.cases.length);
  expect(diverged.summary).toBe(
    `${decided.diverged} of ${decided.cases.length} case(s) from '.pyric/last-session.json' changed verdict, starting with ${first.method} ${first.path}.`,
  );
});

/**
 * What `pyric can-i-use <feature>` prints and exits with, from the command's
 * own code path rather than from the registry function underneath it. The
 * method claims to answer what the command answers, so the command is what it
 * is measured against.
 */
function runCanIUseCommand(feature: string): { code: number; printed: string } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = runCanIUse({ subcommand: null, flags: new Map(), positional: [feature] });
    return { code, printed: chunks.join('') };
  } finally {
    process.stdout.write = original;
  }
}

it('answers a feature exactly as pyric can-i-use answers it', async () => {
  const conforming = runCanIUseCommand('getAfter');
  const claimed = await run('assurance.canIUse', { feature: 'getAfter' });
  expect(conforming.code).toBe(0);
  expect(claimed.ok).toBe(true);
  expect(conforming.printed).toContain(claimed.summary);

  const unsupported = runCanIUseCommand('featureThatDoesNotExistAnywhere');
  const missing = await run('assurance.canIUse', { feature: 'featureThatDoesNotExistAnywhere' });
  expect(unsupported.code).toBe(1);
  expect(unsupported.printed).toContain(
    'No conformance feature matched "featureThatDoesNotExistAnywhere".',
  );
  expect(missing.ok).toBe(false);
  expect(missing.summary).toBe(
    "No conformance feature matched 'featureThatDoesNotExistAnywhere'.",
  );

  const misspelt = runCanIUseCommand('getDown');
  const suggested = await run('assurance.canIUse', { feature: 'getDown' });
  expect(misspelt.code).toBe(1);
  expect(misspelt.printed).toContain('storage/getDownloadURL');
  expect(suggested.ok).toBe(false);
  expect(suggested.summary).toContain('storage/getDownloadURL');
  expect((suggested.data as { match: string }).match).toBe('suggestions');
});

it('drives a campaign from attach through export and finds a real counterexample', async () => {
  const attached = await run('assurance.attach', { campaignId: 'live-copy' });
  expect((attached.data as { campaignId: string }).campaignId).toBe('live-copy');

  const started = await run('assurance.start', {
    campaignId: 'orders',
    target: OPEN_ORDER_TARGET,
  });
  expect((started.data as { services: string[] }).services).toEqual(['firestore']);

  const mapped = await run('assurance.map', {
    campaignId: 'orders',
    actors: [ALICE_ACTOR],
    observations: [OWNER_WRITE_OBSERVATION],
  });
  expect(mapped.data as { actors: number; observations: number }).toMatchObject({
    actors: 1,
    observations: 1,
  });

  const defined = await run('assurance.define', {
    campaignId: 'orders',
    invariants: [OWNER_ONLY_INVARIANT],
  });
  expect((defined.data as { invariants: number }).invariants).toBe(1);
  const proposed = await run('assurance.propose', {
    campaignId: 'orders',
    observationId: OWNER_WRITE_OBSERVATION.id,
    invariantId: OWNER_ONLY_INVARIANT.id,
    mutations: [PAYLOAD_MUTATION],
  });
  expect((proposed.data as { probes: Array<{ id: string }> }).probes[0]?.id).toBe(PAYLOAD_PROBE_ID);

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
  const written = join(projectDir, '.pyric/assurance/orders.json');
  expect(existsSync(written)).toBe(true);
  const bundle = JSON.parse(readFileSync(written, 'utf8')) as {
    redactions: string[];
    campaign: { target: { state: { auth?: { users: Array<Record<string, unknown>> } } } };
  };
  expect(bundle.redactions).toContain('campaign.target.state.auth.users[].password');
  expect(bundle.campaign.target.state.auth?.users[0]).not.toHaveProperty('password');
  expect((exported.data as { path: string }).path).toBe('.pyric/assurance/orders.json');
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
