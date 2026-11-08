import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ContractValidationError, SCENARIO_SCHEMA } from '../../skills/improve-firebase/scripts/lib/contracts.mjs';
import { computeStageTimeline } from '../../skills/improve-firebase/scripts/lib/render-timeline.mjs';
import { IsolatedSandbox } from '../../skills/improve-firebase/scripts/lib/sandbox-client.mjs';
import { EvidenceRecordError, recordEvidence } from '../../skills/improve-firebase/scripts/record.mjs';
import { BehaviorRecordError, recordBehaviorEvidence } from '../../skills/improve-firebase/scripts/record-behavior.mjs';

function makeTempDir(prefix = 'pyric-rtdb-e2e-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return filePath;
}

function assertNoRenderedMediaAndFailedGate(outDir, probeId, expectedGate) {
  const bundleDir = path.join(outDir, probeId);
  assert.equal(
    fs.existsSync(path.join(bundleDir, 'video.mp4')),
    false,
    `video.mp4 must not exist when ${expectedGate} fails`,
  );
  assert.equal(
    fs.existsSync(path.join(bundleDir, 'preview.gif')),
    false,
    `preview.gif must not exist when ${expectedGate} fails`,
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'not-reproduced');
  assert.equal(manifest.failedGate, expectedGate);
  return manifest;
}

test('R1 & seed hygiene e2e: dual-service sandboxes enforce RTDB seed envelopes, top-level /data is preserved, and relative scenario paths + recordBehaviorEvidence validate G1', async (t) => {
  const dir = makeTempDir('pyric-r1-e2e-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const rtdbRulesPath = writeJson(path.join(dir, 'database.rules.json'), {
    rules: {
      '.read': 'auth != null',
      '.write': 'auth != null',
    },
  });
  const fsRulesPath = path.join(dir, 'firestore.rules');
  fs.writeFileSync(
    fsRulesPath,
    'rules_version = \'2\';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} { allow read, write: if request.auth != null; }\n  }\n}\n',
    'utf8',
  );

  // Dual Firestore + RTDB firebase.json must still reject bare seeds and top-level { users: ... } RTDB trees
  const dualFirebaseJson = writeJson(path.join(dir, 'firebase.dual.json'), {
    firestore: { rules: 'firestore.rules' },
    database: { rules: 'database.rules.json' },
  });
  const bareUsersSeedPath = writeJson(path.join(dir, 'bare-users.seed.json'), {
    users: { alice: { bio: 'Staff engineer' } },
  });

  await assert.rejects(
    async () => {
      const sb = await IsolatedSandbox.start({
        projectDir: dir,
        firebaseConfigPath: dualFirebaseJson,
        seedDir: bareUsersSeedPath,
      });
      await sb.dispose();
    },
    (err) => err instanceof ContractValidationError && /"database"/.test(err.message),
  );

  // Snapshot seeding via _applySnapshotState must NOT unwrap a legitimate top-level /data RTDB path
  const validDualSeedPath = writeJson(path.join(dir, 'valid-data-node.seed.json'), {
    database: {
      data: {
        items: {
          item_1: { ownerUid: 'alice', title: 'Top-level /data node' },
        },
      },
    },
  });
  const sb = await IsolatedSandbox.start({
    projectDir: dir,
    firebaseConfigPath: dualFirebaseJson,
  });
  try {
    await sb._applySnapshotState(JSON.parse(fs.readFileSync(validDualSeedPath, 'utf8')));
    const atDataPath = await sb.readState('database', '/data/items/item_1');
    const unwrappedRoot = await sb.readState('database', '/items/item_1');
    assert.deepEqual(atDataPath, { ownerUid: 'alice', title: 'Top-level /data node' });
    assert.equal(unwrappedRoot, null, '_applySnapshotState must not unwrap top-level /data to /');
  } finally {
    await sb.dispose();
  }

  // Relative seedFile + rules.database resolved against scenarioPath even when projectDir differs
  const scenarioSubdir = path.join(dir, 'nested', 'scenarios');
  const unrelatedProjectDir = makeTempDir('pyric-unrelated-proj-');
  t.after(() => fs.rmSync(unrelatedProjectDir, { recursive: true, force: true }));

  writeJson(path.join(scenarioSubdir, 'vuln.rules.json'), {
    rules: {
      items: {
        $id: {
          '.read': 'auth != null',
          '.write': 'auth != null',
        },
      },
    },
  });
  const cliFixedRules = writeJson(path.join(scenarioSubdir, 'fixed.rules.json'), {
    rules: {
      items: {
        $id: {
          '.read': 'auth != null',
          '.write': "auth != null && data.child('ownerUid').val() === auth.uid",
        },
      },
    },
  });
  writeJson(path.join(scenarioSubdir, 'rel.seed.json'), {
    database: {
      items: {
        item_1: { ownerUid: 'alice', title: 'Relative seed' },
      },
    },
  });
  const relScenarioPath = writeJson(path.join(scenarioSubdir, 'rel.scenario.json'), {
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'camp-rel', probe: 'probe-rel-seed' },
    rules: { database: './vuln.rules.json' },
    seedFile: './rel.seed.json',
    actors: {
      owner: { uid: 'alice', name: 'Alice' },
      peer: { uid: 'eve', name: 'Eve' },
    },
    controlOperation: {
      service: 'database',
      method: 'set',
      path: '/items/item_1',
      uid: 'alice',
      data: { ownerUid: 'alice', title: 'Relative seed' },
    },
    reproOperation: {
      service: 'database',
      method: 'set',
      path: '/items/item_1',
      uid: 'eve',
      data: { ownerUid: 'eve', title: 'Tampered' },
    },
    copy: {
      title: 'Relative seed and rules.database check',
      summary: 'Eve overwrites /items/item_1.',
      why: 'Write rule lacked ownerUid check.',
    },
  });

  const relRes = await recordEvidence({
    scenarioPath: relScenarioPath,
    outDir: path.join(dir, 'out-rel'),
    projectDir: unrelatedProjectDir,
    fixRules: { rtdb: cliFixedRules },
    render: false,
  });
  assert.equal(relRes.status, 'reproduced');

  // recordBehaviorEvidence resolves relative dist/rules/seed against scenarioPath and enforces G1 seed envelope
  const behaviorDir = path.join(dir, 'behavior-case');
  fs.mkdirSync(path.join(behaviorDir, 'dist-before'), { recursive: true });
  fs.mkdirSync(path.join(behaviorDir, 'dist-after'), { recursive: true });
  fs.writeFileSync(path.join(behaviorDir, 'dist-before', 'index.html'), '<!doctype html><title>Before</title>', 'utf8');
  fs.writeFileSync(path.join(behaviorDir, 'dist-after', 'index.html'), '<!doctype html><title>After</title>', 'utf8');
  writeJson(path.join(behaviorDir, 'database.rules.json'), {
    rules: { '.read': 'auth != null', '.write': 'auth != null' },
  });
  writeJson(path.join(behaviorDir, 'bare.seed.json'), {
    presence: { alice_1: { uid: 'alice' } },
  });
  const behaviorScenarioPath = writeJson(path.join(behaviorDir, 'behavior.scenario.json'), {
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'camp-beh', probe: 'probe-beh-bare-seed' },
    app: { dist: './dist-before' },
    rules: { rtdb: './database.rules.json' },
    seedFile: './bare.seed.json',
    actors: {
      owner: { uid: 'alice', name: 'Alice' },
      peer: { uid: 'bob', name: 'Bob' },
    },
    behavior: {
      fixApp: { dist: './dist-after' },
      action: { kind: 'sign-out', actor: 'owner', menuItemText: 'Sign out' },
      check: { kind: 'presence-entry', path: '/presence', uid: 'alice', waitMs: 500 },
    },
    copy: {
      title: 'Stale presence after sign-out',
      summary: 'Presence entry lingers after sign-out.',
      why: 'Sign-out runs before presence cleanup.',
    },
  });

  const behaviorOutDir = path.join(dir, 'out-behavior');
  await assert.rejects(
    () =>
      recordBehaviorEvidence({
        scenarioPath: behaviorScenarioPath,
        outDir: behaviorOutDir,
        render: false,
      }),
    (err) => err instanceof BehaviorRecordError && err.code === 'GATE_G1_FAILED' && /"database"/.test(err.message),
  );
  assertNoRenderedMediaAndFailedGate(behaviorOutDir, 'probe-beh-bare-seed', 'G1');
});

test('Update & multi-instance e2e: database.update with nested null delete passes G1-G6 and multi-instance RTDB threads instance through G1-G5', async (t) => {
  const dir = makeTempDir('pyric-update-multi-e2e-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 1. database.update control + repro (including nested null child deletion) rendered end-to-end
  const vulnRulesPath = writeJson(path.join(dir, 'update.vuln.rules.json'), {
    rules: {
      orgs: {
        $orgId: {
          items: {
            $itemId: {
              '.read': 'auth != null',
              '.write': 'auth != null',
            },
          },
        },
      },
    },
  });
  const fixRulesPath = writeJson(path.join(dir, 'update.fixed.rules.json'), {
    rules: {
      orgs: {
        $orgId: {
          items: {
            $itemId: {
              '.read': 'auth != null',
              '.write': "auth != null && data.child('ownerUid').val() === auth.uid",
            },
          },
        },
      },
    },
  });
  const updateSeedPath = writeJson(path.join(dir, 'update.seed.json'), {
    database: {
      orgs: {
        org_1: {
          items: {
            item_1: {
              ownerUid: 'alice',
              title: 'Quarterly roadmap',
              note: 'Internal draft note',
            },
          },
        },
      },
    },
  });
  const updateScenarioPath = writeJson(path.join(dir, 'update.scenario.json'), {
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'camp-update', probe: 'probe-partial-update' },
    rules: { rtdb: vulnRulesPath },
    seedFile: updateSeedPath,
    actors: {
      owner: { uid: 'alice', name: 'Alice' },
      peer: { uid: 'eve', name: 'Eve' },
    },
    controlOperation: {
      service: 'database',
      method: 'update',
      path: '/orgs/org_1/items/item_1',
      uid: 'alice',
      data: { title: 'Quarterly roadmap' },
    },
    reproOperation: {
      service: 'database',
      method: 'update',
      path: '/orgs/org_1/items/item_1',
      uid: 'eve',
      data: { title: 'Tampered roadmap', note: null },
    },
    fixRules: { rtdb: fixRulesPath },
    copy: {
      severity: 'HIGH',
      title: 'Any signed-in user can partially update org items',
      summary: 'Eve updates /orgs/org_1/items/item_1 to overwrite title and delete note.',
      why: 'Write rule on /orgs/$orgId/items/$itemId only checked auth != null.',
    },
  });

  const updateOutDir = path.join(dir, 'out-update');
  const updateRes = await recordEvidence({
    scenarioPath: updateScenarioPath,
    outDir: updateOutDir,
    projectDir: dir,
    render: true,
    formats: ['mp4'],
  });
  assert.equal(updateRes.status, 'reproduced');
  assert.deepEqual(updateRes.gates, {
    g1: true,
    g2: true,
    g3: true,
    g4: true,
    g5: true,
    g6: true,
  });
  const updateEvidence = JSON.parse(fs.readFileSync(path.join(updateRes.bundleDir, 'evidence.json'), 'utf8'));
  assert.deepEqual(updateEvidence.before, {
    ownerUid: 'alice',
    title: 'Quarterly roadmap',
    note: 'Internal draft note',
  });
  assert.deepEqual(updateEvidence.after, {
    ownerUid: 'alice',
    title: 'Tampered roadmap',
  });
  assert.ok(fs.statSync(path.join(updateRes.bundleDir, 'video.mp4')).size > 0);

  // 2. Multi-instance RTDB scenario (`databases` seed + `instance: "shard-b"`)
  const multiSeedPath = writeJson(path.join(dir, 'multi.seed.json'), {
    databases: {
      'shard-b': {
        orgs: {
          org_1: {
            items: {
              item_1: { ownerUid: 'alice', title: 'Shard B item' },
            },
          },
        },
      },
    },
  });
  const multiScenarioPath = writeJson(path.join(dir, 'multi.scenario.json'), {
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'camp-multi', probe: 'probe-shard-b-write' },
    rules: { rtdb: vulnRulesPath },
    seedFile: multiSeedPath,
    actors: {
      owner: { uid: 'alice', name: 'Alice' },
      peer: { uid: 'eve', name: 'Eve' },
    },
    controlOperation: {
      service: 'database',
      method: 'set',
      instance: 'shard-b',
      path: '/orgs/org_1/items/item_1',
      uid: 'alice',
      data: { ownerUid: 'alice', title: 'Shard B item' },
    },
    reproOperation: {
      service: 'database',
      method: 'set',
      instance: 'shard-b',
      path: '/orgs/org_1/items/item_1',
      uid: 'eve',
      data: { ownerUid: 'eve', title: 'Hijacked shard B item' },
    },
    fixRules: { rtdb: fixRulesPath },
    copy: {
      title: 'Cross-user write on secondary RTDB instance',
      summary: 'Eve overwrites /orgs/org_1/items/item_1 on instance shard-b.',
      why: 'Secondary instance rules allowed any signed-in user to write.',
    },
  });

  const multiRes = await recordEvidence({
    scenarioPath: multiScenarioPath,
    outDir: path.join(dir, 'out-multi'),
    projectDir: dir,
    render: false,
  });
  assert.equal(multiRes.status, 'reproduced');
  assert.equal(multiRes.gates.g5, true);
});

test('R4 & R5 e2e: admin state snapshots capture non-readable paths and pre-G5 reset deletes created keys and restores owner-unwritable paths', async (t) => {
  const dir = makeTempDir('pyric-r4-r5-e2e-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // R4: non-readable path (.read: false)
  const blindVulnRules = writeJson(path.join(dir, 'blind.vuln.rules.json'), {
    rules: {
      orgs: { $orgId: { items: { $itemId: { '.read': 'auth != null', '.write': 'auth != null' } } } },
      items: { $id: { '.read': false, '.write': 'auth != null' } },
    },
  });
  const blindFixRules = writeJson(path.join(dir, 'blind.fixed.rules.json'), {
    rules: {
      orgs: {
        $orgId: {
          items: {
            $itemId: {
              '.read': 'auth != null',
              '.write': "auth != null && (!data.exists() || data.child('ownerUid').val() === auth.uid)",
            },
          },
        },
      },
      items: { $id: { '.read': false, '.write': false } },
    },
  });
  const blindSeed = writeJson(path.join(dir, 'blind.seed.json'), {
    database: {
      orgs: { org_1: { items: { item_1: { ownerUid: 'alice', title: 'Alice item' } } } },
      items: { item_secret: { ownerUid: 'system', status: 'active' } },
    },
  });
  const blindScenario = writeJson(path.join(dir, 'blind.scenario.json'), {
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'camp-r4', probe: 'probe-blind-item-write' },
    rules: { rtdb: blindVulnRules },
    seedFile: blindSeed,
    actors: { owner: { uid: 'alice', name: 'Alice' }, peer: { uid: 'eve', name: 'Eve' } },
    controlOperation: {
      service: 'database',
      method: 'set',
      path: '/orgs/org_1/items/item_1',
      uid: 'alice',
      data: { ownerUid: 'alice', title: 'Alice item' },
    },
    reproOperation: {
      service: 'database',
      method: 'set',
      path: '/items/item_secret',
      uid: 'eve',
      data: { ownerUid: 'eve', status: 'tampered' },
    },
    fixRules: { rtdb: blindFixRules },
    copy: {
      title: 'Blind write to non-readable item path',
      summary: 'Eve overwrites /items/item_secret.',
      why: 'Write rule on /items/$id allowed any signed-in user.',
    },
  });

  const r4Res = await recordEvidence({
    scenarioPath: blindScenario,
    outDir: path.join(dir, 'out-r4'),
    projectDir: dir,
    render: false,
  });
  assert.equal(r4Res.status, 'reproduced');
  assert.equal(r4Res.gates.g5, true);
  const r4Ev = JSON.parse(fs.readFileSync(path.join(r4Res.bundleDir, 'evidence.json'), 'utf8'));
  assert.deepEqual(r4Ev.before, { ownerUid: 'system', status: 'active' });
  assert.deepEqual(r4Ev.after, { ownerUid: 'eve', status: 'tampered' });

  // R5: new-key create (`baselineSnapshot === null`) must be deleted before G5 so update-if-exists fix fails G5 unless fixed properly
  const createVulnRules = writeJson(path.join(dir, 'create.vuln.rules.json'), {
    rules: {
      orgs: {
        $orgId: {
          members: { $uid: { '.read': 'auth != null' } },
          items: { $itemId: { '.read': 'auth != null', '.write': 'auth != null' } },
        },
      },
    },
  });
  const createFixRules = writeJson(path.join(dir, 'create.fixed.rules.json'), {
    rules: {
      orgs: {
        $orgId: {
          members: { $uid: { '.read': 'auth != null' } },
          items: {
            $itemId: {
              '.read': 'auth != null',
              '.write': "auth != null && root.child('orgs').child($orgId).child('members').child(auth.uid).val() === true",
            },
          },
        },
      },
    },
  });
  const createSeed = writeJson(path.join(dir, 'create.seed.json'), {
    database: {
      orgs: {
        org_1: {
          members: { alice: true },
          items: { item_alice: { ownerUid: 'alice', title: 'Alice item' } },
        },
      },
    },
  });
  const createScenario = writeJson(path.join(dir, 'create.scenario.json'), {
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'camp-r5', probe: 'probe-new-key-create' },
    rules: { rtdb: createVulnRules },
    seedFile: createSeed,
    actors: { owner: { uid: 'alice', name: 'Alice' }, peer: { uid: 'eve', name: 'Eve' } },
    controlOperation: {
      service: 'database',
      method: 'set',
      path: '/orgs/org_1/items/item_alice',
      uid: 'alice',
      data: { ownerUid: 'alice', title: 'Alice item' },
    },
    reproOperation: {
      service: 'database',
      method: 'set',
      path: '/orgs/org_1/items/item_eve',
      uid: 'eve',
      data: { ownerUid: 'eve', title: 'Injected item' },
    },
    fixRules: { rtdb: createFixRules },
    copy: {
      title: 'Non-member creates org item',
      summary: 'Eve creates /orgs/org_1/items/item_eve without org membership.',
      why: 'Write rule did not check org membership.',
    },
  });

  const r5Res = await recordEvidence({
    scenarioPath: createScenario,
    outDir: path.join(dir, 'out-r5'),
    projectDir: dir,
    render: false,
  });
  assert.equal(r5Res.status, 'reproduced');
  assert.equal(r5Res.gates.g5, true);
  const r5Events = JSON.parse(fs.readFileSync(path.join(r5Res.bundleDir, 'events.json'), 'utf8'));
  const r5FixEvent = r5Events.find((ev) => ev.phase === 'fix');
  assert.equal(r5FixEvent.stateBefore, null, 'Created key must be deleted before G5 runs');
  assert.equal(r5FixEvent.stateAfter, null);
});

test('Hard-gate no-video proofs (render: true): G2, G5 (still-allowed, broken-control, non-rule ERROR), and G6 failures leave zero video/gif and write not-reproduced manifest', async (t) => {
  const dir = makeTempDir('pyric-hard-gates-e2e-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const seedPath = writeJson(path.join(dir, 'seed.json'), {
    database: {
      items: {
        item_1: { ownerUid: 'alice', title: 'Protected' },
      },
    },
  });

  const openRulesPath = writeJson(path.join(dir, 'open.rules.json'), {
    rules: { items: { $id: { '.read': 'auth != null', '.write': 'auth != null' } } },
  });
  const lockedRulesPath = writeJson(path.join(dir, 'locked.rules.json'), {
    rules: { items: { $id: { '.read': false, '.write': false } } },
  });
  const ownerOnlyRulesPath = writeJson(path.join(dir, 'owner.rules.json'), {
    rules: {
      items: {
        $id: {
          '.read': 'auth != null',
          '.write': "auth != null && (!data.exists() || data.child('ownerUid').val() === auth.uid)",
        },
      },
    },
  });

  // 1. G2 failure (owner control denied) with render: true
  const g2Out = path.join(dir, 'out-g2');
  const g2Scenario = writeJson(path.join(dir, 'g2.scenario.json'), {
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'camp-gates', probe: 'probe-g2-denied-control' },
    rules: { rtdb: lockedRulesPath },
    seedFile: seedPath,
    actors: { owner: { uid: 'alice', name: 'Alice' }, peer: { uid: 'eve', name: 'Eve' } },
    controlOperation: {
      service: 'database',
      method: 'set',
      path: '/items/item_1',
      uid: 'alice',
      data: { ownerUid: 'alice', title: 'Updated' },
    },
    reproOperation: {
      service: 'database',
      method: 'set',
      path: '/items/item_1',
      uid: 'eve',
      data: { ownerUid: 'eve', title: 'Hijacked' },
    },
    copy: { title: 'Denied control', summary: 'Control fails.', why: 'Locked.' },
  });
  await assert.rejects(
    () => recordEvidence({ scenarioPath: g2Scenario, outDir: g2Out, projectDir: dir, render: true, formats: ['mp4', 'gif'] }),
    (err) => err instanceof EvidenceRecordError && err.code === 'GATE_G2_FAILED',
  );
  assertNoRenderedMediaAndFailedGate(g2Out, 'probe-g2-denied-control', 'G2');

  // 2. G5 failure: fix still ALLOWs peer with render: true
  const g5AllowOut = path.join(dir, 'out-g5-allow');
  const g5AllowScenario = writeJson(path.join(dir, 'g5-allow.scenario.json'), {
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'camp-gates', probe: 'probe-g5-still-allowed' },
    rules: { rtdb: openRulesPath },
    seedFile: seedPath,
    actors: { owner: { uid: 'alice', name: 'Alice' }, peer: { uid: 'eve', name: 'Eve' } },
    controlOperation: {
      service: 'database',
      method: 'set',
      path: '/items/item_1',
      uid: 'alice',
      data: { ownerUid: 'alice', title: 'Updated' },
    },
    reproOperation: {
      service: 'database',
      method: 'set',
      path: '/items/item_1',
      uid: 'eve',
      data: { ownerUid: 'eve', title: 'Hijacked' },
    },
    fixRules: { rtdb: openRulesPath },
    copy: { title: 'Unfixed rules', summary: 'Eve still writes.', why: 'Still open.' },
  });
  await assert.rejects(
    () => recordEvidence({ scenarioPath: g5AllowScenario, outDir: g5AllowOut, projectDir: dir, render: true, formats: ['mp4', 'gif'] }),
    (err) => err instanceof EvidenceRecordError && err.code === 'GATE_G5_FAILED',
  );
  assertNoRenderedMediaAndFailedGate(g5AllowOut, 'probe-g5-still-allowed', 'G5');

  // 3. G5 failure: broken control (fix blocks legitimate owner too) with render: true
  const g5BrokenControlOut = path.join(dir, 'out-g5-broken-control');
  const g5BrokenControlScenario = writeJson(path.join(dir, 'g5-broken-control.scenario.json'), {
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'camp-gates', probe: 'probe-g5-broken-control' },
    rules: { rtdb: openRulesPath },
    seedFile: seedPath,
    actors: { owner: { uid: 'alice', name: 'Alice' }, peer: { uid: 'eve', name: 'Eve' } },
    controlOperation: {
      service: 'database',
      method: 'set',
      path: '/items/item_1',
      uid: 'alice',
      data: { ownerUid: 'alice', title: 'Updated' },
    },
    reproOperation: {
      service: 'database',
      method: 'set',
      path: '/items/item_1',
      uid: 'eve',
      data: { ownerUid: 'eve', title: 'Hijacked' },
    },
    fixRules: { rtdb: lockedRulesPath },
    copy: { title: 'Over-broad fix', summary: 'Fix blocks owner too.', why: 'Locked everything.' },
  });
  await assert.rejects(
    () =>
      recordEvidence({
        scenarioPath: g5BrokenControlScenario,
        outDir: g5BrokenControlOut,
        projectDir: dir,
        render: true,
        formats: ['mp4', 'gif'],
      }),
    (err) => err instanceof EvidenceRecordError && err.code === 'GATE_G5_FAILED',
  );
  assertNoRenderedMediaAndFailedGate(g5BrokenControlOut, 'probe-g5-broken-control', 'G5');

  // 4. G5 failure: non-rule ERROR in fix repro (e.g. invalid RTDB update key containing '/') must NOT pass G5 as DENY
  const g5NonRuleErrOut = path.join(dir, 'out-g5-non-rule-err');
  const g5NonRuleErrScenario = writeJson(path.join(dir, 'g5-non-rule-err.scenario.json'), {
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'camp-gates', probe: 'probe-g5-non-rule-error' },
    rules: { rtdb: openRulesPath },
    seedFile: seedPath,
    actors: { owner: { uid: 'alice', name: 'Alice' }, peer: { uid: 'eve', name: 'Eve' } },
    controlOperation: {
      service: 'database',
      method: 'set',
      path: '/items/item_1',
      uid: 'alice',
      data: { ownerUid: 'alice', title: 'Updated' },
    },
    steps: [
      {
        actor: 'peer',
        kind: 'sdk',
        operation: {
          service: 'database',
          method: 'set',
          path: '/items/item_1',
          uid: 'eve',
          data: { ownerUid: 'eve', title: 'Hijacked via step' },
        },
      },
    ],
    // In G5, reproOperation runs against still-open rules with an invalid RTDB key containing '.' -> non-rule bridge ERROR
    reproOperation: {
      service: 'database',
      method: 'set',
      path: '/items/item_1',
      uid: 'eve',
      data: { 'bad.key': 'must-not-count-as-rule-deny' },
    },
    fixRules: { rtdb: openRulesPath },
    copy: { title: 'Malformed G5 update', summary: 'G5 hits HTTP 400.', why: 'Non-rule error must fail G5.' },
  });
  await assert.rejects(
    () =>
      recordEvidence({
        scenarioPath: g5NonRuleErrScenario,
        outDir: g5NonRuleErrOut,
        projectDir: dir,
        render: true,
        formats: ['mp4', 'gif'],
      }),
    (err) => err instanceof EvidenceRecordError && err.code === 'GATE_G5_FAILED',
  );
  assertNoRenderedMediaAndFailedGate(g5NonRuleErrOut, 'probe-g5-non-rule-error', 'G5');

  // 5. G6 failure: contradictory slide copy on a new-key create finding must fail hard, remove video.mp4/preview.gif, and write failedGate: 'G6'
  const g6Out = path.join(dir, 'out-g6-copy-contradiction');
  const g6Scenario = writeJson(path.join(dir, 'g6.scenario.json'), {
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'camp-gates', probe: 'probe-g6-contradiction' },
    rules: { rtdb: openRulesPath },
    seedFile: seedPath,
    actors: { owner: { uid: 'alice', name: 'Alice' }, peer: { uid: 'eve', name: 'Eve' } },
    controlOperation: {
      service: 'database',
      method: 'set',
      path: '/items/item_1',
      uid: 'alice',
      data: { ownerUid: 'alice', title: 'Alice item' },
    },
    reproOperation: {
      service: 'database',
      method: 'set',
      path: '/items/item_created_by_eve',
      uid: 'eve',
      data: { ownerUid: 'eve', title: 'New item' },
    },
    fixRules: {
      rtdb: writeJson(path.join(dir, 'no-new.rules.json'), {
        rules: {
          items: {
            $id: {
              '.read': 'auth != null',
              '.write': "auth != null && data.exists() && data.child('ownerUid').val() === auth.uid",
            },
          },
        },
      }),
    },
    copy: {
      title: 'Unauthorized item creation',
      summary: 'Eve creates /items/item_created_by_eve.',
      why: 'Write rule allowed creating arbitrary items.',
      // Deliberately contradicts stateBefore === null (`create`, not `overwrite existing`)
      attackContext: "Eve calls the SDK to overwrite Alice's existing item.",
    },
  });
  await assert.rejects(
    () =>
      recordEvidence({
        scenarioPath: g6Scenario,
        outDir: g6Out,
        projectDir: dir,
        render: true,
        formats: ['mp4', 'gif'],
      }),
    (err) => err instanceof EvidenceRecordError && err.code === 'GATE_G6_FAILED',
  );
  const g6Manifest = assertNoRenderedMediaAndFailedGate(g6Out, 'probe-g6-contradiction', 'G6');
  assert.equal(g6Manifest.gates.g6, false);
});

test('R6 e2e: read finding with a write controlOperation passes G1-G6 and describes owner write on Slides 2/8 while keeping repro/fix read-accurate', async (t) => {
  const dir = makeTempDir('pyric-r6-read-write-ctrl-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const vulnRulesPath = writeJson(path.join(dir, 'database.vuln.rules.json'), {
    rules: {
      users: {
        '.read': 'auth != null',
        $uid: {
          '.write': 'auth != null && auth.uid === $uid',
        },
      },
    },
  });
  const fixedRulesPath = writeJson(path.join(dir, 'database.fixed.rules.json'), {
    rules: {
      users: {
        $uid: {
          '.read': 'auth != null && auth.uid === $uid',
          '.write': 'auth != null && auth.uid === $uid',
        },
      },
    },
  });
  const seedPath = writeJson(path.join(dir, 'seed.json'), {
    database: {
      users: {
        alice: {
          profile: {
            ownerUid: 'alice',
            plan: 'enterprise',
            recoveryPin: '4821',
          },
        },
      },
    },
  });
  const scenarioPath = writeJson(path.join(dir, 'read.scenario.json'), {
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'camp-rtdb-r6', probe: 'probe-cross-user-profile-read' },
    rules: { rtdb: vulnRulesPath },
    seedFile: seedPath,
    actors: {
      owner: { uid: 'alice', name: 'Alice' },
      peer: { uid: 'eve', name: 'Eve' },
    },
    controlOperation: {
      service: 'database',
      method: 'set',
      path: '/users/alice/profile',
      uid: 'alice',
      data: {
        ownerUid: 'alice',
        plan: 'enterprise',
        recoveryPin: '4821',
      },
    },
    reproOperation: {
      service: 'database',
      method: 'get',
      path: '/users/alice/profile',
      uid: 'eve',
    },
    fixRules: { rtdb: fixedRulesPath },
    copy: {
      severity: 'HIGH',
      title: 'Any signed-in user can read private user profiles',
      summary: 'Eve reads Alice private profile record directly from /users/alice/profile.',
      why: 'The .read rule sits at /users and checks auth != null without verifying $uid ownership.',
    },
  });

  const outDir = path.join(dir, 'out');
  const res = await recordEvidence({
    scenarioPath,
    outDir,
    projectDir: dir,
    render: true,
    formats: ['mp4'],
  });

  assert.equal(res.status, 'reproduced');
  assert.deepEqual(res.gates, {
    g1: true,
    g2: true,
    g3: true,
    g4: true,
    g5: true,
    g6: true,
  });
  assert.ok(fs.statSync(path.join(res.bundleDir, 'video.mp4')).size > 0);

  const recordedScenario = JSON.parse(fs.readFileSync(path.join(res.bundleDir, 'scenario.json'), 'utf8'));
  const recordedEvents = JSON.parse(fs.readFileSync(path.join(res.bundleDir, 'events.json'), 'utf8'));
  const recordedEvidence = JSON.parse(fs.readFileSync(path.join(res.bundleDir, 'evidence.json'), 'utf8'));
  const shareMd = fs.readFileSync(path.join(res.bundleDir, 'share.md'), 'utf8');

  const timeline = computeStageTimeline({
    scenario: recordedScenario,
    events: recordedEvents,
    evidence: recordedEvidence,
  });
  const slides = timeline.presentation.slides;
  assert.match(slides.find((s) => s.id === 'attach-demo').subtitle, /\bwrite\b/i);
  assert.equal(slides.find((s) => s.id === 'fix-video').titleBefore, 'Owner write');
  assert.equal(slides.find((s) => s.id === 'fix-video').titleAfter, 'Unauthorized read blocked');
  assert.doesNotMatch(slides.find((s) => s.id === 'problem-slide').subtitle, /overwrite|write/i);
  assert.doesNotMatch(shareMd, /overwrite|mutation/i);
  assert.equal(/\u2014/.test(JSON.stringify({ slides, beats: timeline.beats })), false);
});
