import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assessFixAssurance,
  assuranceTargetHash,
  buildScenarioFromAssurance,
  extractInlineTarget,
  materializeInlineTarget,
  parseCampaignExport,
  selectControlObservation,
  selectProbeFromExport,
  stableStringify,
} from '../skills/improve-firebase/scripts/lib/from-assurance.mjs';
import { prepareIsolatedSandboxInputs } from '../skills/improve-firebase/scripts/record.mjs';

// A trimmed copy of a real `firebase_assurance_export` bundle (Spaces chat-overwrite campaign).
// Rules are cut down to the chat subtree and sandbox events are dropped; target hashes were
// recomputed for the trimmed target so verification matching still works.
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const REAL_EXPORT = path.join(FIXTURES, 'assurance-export-real.json');
const FIXED_RULES = path.join(FIXTURES, 'assurance-export-real.fixed.rules.json');
const FIXED_ROOTONLY_RULES = path.join(FIXTURES, 'assurance-export-real.fixed-rootonly.rules.json');
const PROBE = 'bob-overwrites-alice-message';
const M1 = '/spaces_app/spaces/s1/chatHistory/pub/m1/content';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const loadExport = () => parseCampaignExport(readJson(REAL_EXPORT));

test('parseCampaignExport reads the real nested export shape (report.results)', () => {
  const raw = readJson(REAL_EXPORT);
  assert.equal(Array.isArray(raw.probes), false, 'real exports have no top-level probes[]');

  const campaign = parseCampaignExport(raw);
  assert.equal(campaign.schema, 'pyric.assurance.export.v1');
  assert.equal(campaign.campaignId, 'spaces-chat-assurance');
  assert.deepEqual(
    campaign.probes.map((p) => p.probeId),
    ['bob-overwrites-alice-message', 'alice-overwrites-bob-message'],
  );
  assert.deepEqual(campaign.target, { rulesHash: raw.report.targetHash });
  // Context later stages need survives normalization.
  assert.equal(campaign.campaign.id, 'spaces-chat-assurance');
  assert.equal(campaign.observations.length, 2);
  assert.equal(campaign.verifications.length, 2);
  // The fixture's hashes are consistent with the runner's hashing.
  assert.equal(assuranceTargetHash(campaign.campaign.target), raw.report.targetHash);
});

test('selectProbeFromExport finds real probes by id and lists them when ambiguous or missing', () => {
  const campaign = loadExport();
  assert.equal(selectProbeFromExport(campaign, PROBE).probeId, PROBE);
  assert.throws(() => selectProbeFromExport(campaign), /Multiple probes present.*bob-overwrites-alice-message/);
  assert.throws(() => selectProbeFromExport(campaign, 'nope'), /not found in campaign "spaces-chat-assurance"/);
});

test('buildScenarioFromAssurance on the real export: victim control from observations, honest copy', () => {
  const campaign = loadExport();
  const probe = selectProbeFromExport(campaign, PROBE);
  const plan = buildScenarioFromAssurance({ campaignExport: campaign, probe });

  assert.equal(plan.exploitOperation.service, 'database');
  assert.equal(plan.exploitOperation.method, 'set');
  assert.equal(plan.exploitOperation.path, M1);

  // The probe's own control is Bob writing his own m2; the victim's control must be Alice's
  // observed write on the mutated path, run as Alice.
  assert.equal(probe.control.operation.path.endsWith('/m2/content'), true);
  assert.deepEqual(plan.controlOperation, {
    service: 'database',
    method: 'set',
    path: M1,
    data: { text: 'Hello from Alice (edited)' },
    uid: 'alice',
  });
  assert.deepEqual(plan.controlSource, {
    kind: 'observation',
    observationId: 'alice-edits-own-message',
    actorId: 'alice',
    uid: 'alice',
  });

  // Actors come from actorEvidence.uid (attacker) and the observation (victim), unlabeled.
  assert.deepEqual(
    { uid: plan.scenario.actors.victim.uid, name: plan.scenario.actors.victim.name },
    { uid: 'alice', name: 'Alice' },
  );
  assert.deepEqual(
    { uid: plan.scenario.actors.attacker.uid, name: plan.scenario.actors.attacker.name },
    { uid: 'bob', name: 'Bob' },
  );

  // Copy falls back to what the export states; no severity is invented.
  const { copy } = plan.scenario;
  assert.equal(copy.severity, 'UNRATED');
  assert.equal(copy.title, 'Bob overwrites alice message');
  assert.equal(copy.why, probe.invariant.statement);
  assert.equal(copy.exploit, probe.mutationSpec.description);
  assert.equal(copy.baseline, 'Alice edits the text of her own chat message m1');

  // stateDiff in real exports is { changed, before, after } for the mutated path.
  assert.deepEqual(plan.initialSeedValue, { text: 'Hello from Alice' });
  assert.equal(plan.scenario.finding.campaign, 'spaces-chat-assurance');
  assert.equal(plan.scenario.finding.targetHash, campaign.report.targetHash);
});

test('scenario overrides still win over export-derived control and copy', () => {
  const campaign = loadExport();
  const probe = selectProbeFromExport(campaign, PROBE);
  const plan = buildScenarioFromAssurance({
    campaignExport: campaign,
    probe,
    scenarioOverride: {
      controlOperation: { service: 'rtdb', method: 'set', path: M1, data: { text: 'Hello from Alice' } },
      copy: { severity: 'high', title: 'Any member can rewrite your chat messages' },
    },
  });
  assert.equal(plan.controlSource.kind, 'override');
  assert.deepEqual(plan.controlOperation.data, { text: 'Hello from Alice' });
  assert.equal(plan.scenario.copy.severity, 'HIGH');
  assert.equal(plan.scenario.copy.title, 'Any member can rewrite your chat messages');
});

test('selectControlObservation picks the victim, skips the attacker, denials, and unrelated paths', () => {
  const campaign = loadExport();
  const probe = selectProbeFromExport(campaign, PROBE);
  const exploitOperation = { service: 'database', method: 'set', path: M1 };

  // An explicit victim that never acted has no observation, so the old probe control is used.
  assert.equal(
    selectControlObservation({ campaignExport: campaign, probe, exploitOperation, victimUid: 'carol' }),
    null,
  );
  const fallback = buildScenarioFromAssurance({
    campaignExport: campaign,
    probe,
    scenarioOverride: { actors: { victim: { uid: 'carol', name: 'Carol' } } },
  });
  assert.equal(fallback.controlSource.kind, 'probe-control');

  const sibling = '/spaces_app/spaces/s1/chatHistory/pub/m9';
  const variant = {
    ...campaign,
    observations: [
      // the probe's own actor: never the victim's control
      { id: 'bob-own', actorId: 'bob', result: 'ALLOW', operation: { service: 'rtdb', method: 'set', path: M1, data: 1 } },
      // a denial is not a known-good write
      { id: 'alice-denied', actorId: 'alice', result: 'DENY', operation: { service: 'rtdb', method: 'set', path: M1, data: 2 } },
      // unrelated subtree
      { id: 'alice-elsewhere', actorId: 'alice', result: 'ALLOW', operation: { service: 'rtdb', method: 'set', path: '/spaces_app/userinfo/alice/displayName', data: 3 } },
      // sibling of the mutated parent: accepted when nothing exact exists
      { id: 'alice-sibling', actorId: 'alice', result: 'ALLOW', operation: { service: 'rtdb', method: 'set', path: '/spaces_app/spaces/s1/chatHistory/pub/m1/meta', data: 4 } },
      { id: 'alice-far', actorId: 'alice', result: 'ALLOW', operation: { service: 'rtdb', method: 'set', path: sibling, data: 5 } },
    ],
  };
  const picked = selectControlObservation({ campaignExport: variant, probe, exploitOperation });
  assert.equal(picked.observationId, 'alice-sibling');
  assert.equal(picked.operation.uid, 'alice');

  assert.equal(
    selectControlObservation({ campaignExport: { ...campaign, observations: undefined }, probe, exploitOperation }),
    null,
  );
});

test('extractInlineTarget and materializeInlineTarget write the campaign rules and state', (t) => {
  const campaign = loadExport();
  const inline = extractInlineTarget(campaign);
  assert.ok(inline.rtdbRules?.rules, 'inline rtdb rules is the whole { rules } document');
  assert.ok(inline.rtdbState?.spaces_app, 'inline rtdb state is the database tree');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyric-inline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const written = materializeInlineTarget(campaign, dir);
  assert.deepEqual(readJson(written.rtdbRulesPath), inline.rtdbRules);
  assert.deepEqual(readJson(written.seedPath), { database: inline.rtdbState });
  assert.equal(written.firestoreRulesPath, null);

  assert.deepEqual(extractInlineTarget({ probes: [] }), {
    rtdbRules: null,
    rtdbState: null,
    firestoreRules: null,
    storageRules: null,
  });
});

test('prepareIsolatedSandboxInputs uses inline campaign rules/state unless the scenario supplies them', (t) => {
  const campaign = loadExport();
  const exploitOperation = { service: 'database', method: 'set', path: M1 };
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyric-inline-project-'));
  const scratch = [];
  t.after(() => {
    for (const d of [projectDir, ...scratch]) fs.rmSync(d, { recursive: true, force: true });
  });
  const prepare = (rawScenario, seedDir = null) => {
    const out = prepareIsolatedSandboxInputs({
      projectDir,
      firebaseConfigPath: null,
      scenario: {},
      rawScenario,
      campaignExport: campaign,
      exploitOperation,
      initialSeedValue: { text: 'Hello from Alice' },
      seedDir,
      useInlineTarget: true,
    });
    scratch.push(out.scratchCfgDir);
    return out;
  };

  // Nothing supplied: the sandbox loads exactly what the campaign ran against.
  const inline = prepare({});
  const cfg = readJson(inline.firebaseConfigPath);
  assert.deepEqual(readJson(cfg.database.rules), campaign.campaign.target.rules.rtdb);
  assert.deepEqual(readJson(inline.seedDir), { database: campaign.campaign.target.state.rtdb });
  assert.equal(inline.initialRuleFile, cfg.database.rules);
  assert.deepEqual(inline.inputs, { rules: 'campaign-inline', seed: 'campaign-inline' });
  assert.deepEqual(inline.warnings, []);

  // Scenario paths win; differences from the campaign become warnings, not failures.
  const otherRules = path.join(projectDir, 'other.rules.json');
  const otherSeed = path.join(projectDir, 'other.seed.json');
  fs.writeFileSync(otherRules, JSON.stringify({ rules: { '.read': true, '.write': true } }));
  fs.writeFileSync(otherSeed, JSON.stringify({ database: { spaces_app: {} } }));
  const supplied = prepare({ rules: { rtdb: otherRules }, seedFile: otherSeed });
  assert.equal(readJson(supplied.firebaseConfigPath).database.rules, otherRules);
  assert.equal(supplied.seedDir, otherSeed);
  assert.deepEqual(supplied.inputs, { rules: 'scenario', seed: 'scenario' });
  assert.deepEqual(
    supplied.warnings.map((w) => w.code).sort(),
    ['RULES_DIFFER_FROM_CAMPAIGN', 'SEED_DIFFERS_FROM_CAMPAIGN'],
  );

  // A seed identical to the campaign state does not warn; the CLI seed wins over the scenario.
  const sameSeed = path.join(projectDir, 'same.seed.json');
  fs.writeFileSync(sameSeed, JSON.stringify({ database: campaign.campaign.target.state.rtdb }));
  const cli = prepare({ seedFile: otherSeed }, sameSeed);
  assert.equal(cli.seedDir, sameSeed);
  assert.equal(cli.inputs.seed, 'cli');
  assert.deepEqual(cli.warnings, []);
});

test('assessFixAssurance matches verifications by target hash and reports engine gaps', () => {
  const campaign = loadExport();
  const probe = selectProbeFromExport(campaign, PROBE);

  const gap = assessFixAssurance({
    campaignExport: campaign,
    probe,
    fixRules: { rtdbRules: readJson(FIXED_RULES) },
    method: 'set',
  });
  assert.equal(gap.verified, false);
  assert.equal(gap.reason, 'engine-gap');
  assert.equal(gap.verificationId, 'fixed-speaker-check');
  assert.equal(gap.classification, 'engine-gap');
  assert.match(gap.detail, /cannot prove/);
  assert.equal(
    gap.note,
    'Assurance could not confirm this fix (engine gap). The sandbox recording shows the write denied.',
  );
  assert.equal(/[·•]/.test(gap.note), false);

  const verified = assessFixAssurance({
    campaignExport: campaign,
    probe,
    fixRules: { rtdbRules: readJson(FIXED_ROOTONLY_RULES) },
    method: 'set',
  });
  assert.equal(verified.verified, true);
  assert.equal(verified.reason, 'verified');
  assert.equal(verified.verificationId, 'fixed-rootonly');
  assert.equal(verified.note, undefined, 'a verified fix carries no note');

  const unrelated = assessFixAssurance({
    campaignExport: campaign,
    probe,
    fixRules: { rtdbRules: { rules: { '.read': false, '.write': false } } },
    method: 'set',
  });
  assert.equal(unrelated.verified, false);
  assert.equal(unrelated.reason, 'no-verification');
  assert.equal(unrelated.note, 'Assurance has not verified this fix. The sandbox recording shows the write denied.');

  const none = assessFixAssurance({
    campaignExport: { ...campaign, verifications: undefined },
    probe,
    fixRules: { rtdbRules: readJson(FIXED_ROOTONLY_RULES) },
    method: 'get',
  });
  assert.equal(none.reason, 'no-verification');
  assert.match(none.note, /shows the read denied\.$/);

  // Key order in the rules file does not change the match.
  const reordered = JSON.parse(stableStringify(readJson(FIXED_ROOTONLY_RULES)));
  assert.equal(
    assessFixAssurance({ campaignExport: campaign, probe, fixRules: { rtdbRules: reordered } }).verified,
    true,
  );
});
