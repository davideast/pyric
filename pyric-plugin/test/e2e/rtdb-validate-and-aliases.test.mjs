import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SCENARIO_SCHEMA } from '../../skills/improve-firebase/scripts/lib/contracts.mjs';
import { checkCopyAgainstEvents } from '../../skills/improve-firebase/scripts/lib/gates.mjs';
import { computeStageTimeline } from '../../skills/improve-firebase/scripts/lib/render-timeline.mjs';
import { recordEvidence } from '../../skills/improve-firebase/scripts/record.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return filePath;
}

test('Service-alias e2e: standalone rules scenario with steps[].operation.service = "rtdb" and step.phase preservation passes Gates G1-G6', async (t) => {
  const dir = makeTempDir('pyric-step-service-alias-e2e-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const currentRulesPath = writeJson(path.join(dir, 'rules.current.json'), {
    rules: {
      items: {
        $itemId: {
          '.read': 'auth != null',
          '.write': 'auth != null',
        },
      },
    },
  });
  const fixedRulesPath = writeJson(path.join(dir, 'rules.fixed.json'), {
    rules: {
      items: {
        $itemId: {
          '.read': 'auth != null',
          '.write': "auth != null && (!data.exists() || data.child('ownerUid').val() === auth.uid)",
        },
      },
    },
  });
  const seedPath = writeJson(path.join(dir, 'seed.json'), {
    database: {
      items: {
        item1: {
          ownerUid: 'alice',
          name: 'Original',
        },
      },
    },
  });
  const scenarioPath = writeJson(path.join(dir, 'scenario.json'), {
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'camp-service-alias', probe: 'probe-rtdb-step-alias' },
    rules: { rtdb: currentRulesPath },
    seedFile: seedPath,
    actors: {
      owner: { uid: 'alice', name: 'Alice' },
      peer: { uid: 'bob', name: 'Bob' },
    },
    controlOperation: {
      service: 'rtdb',
      method: 'set',
      path: '/items/item1',
      uid: 'alice',
      data: { ownerUid: 'alice', name: 'Original' },
    },
    reproOperation: {
      service: 'rtdb',
      method: 'set',
      path: '/items/item1',
      uid: 'bob',
      data: { ownerUid: 'alice', name: 'Overwritten' },
    },
    steps: [
      {
        kind: 'sdk',
        phase: 'hook',
        actor: 'owner',
        operation: {
          service: 'rtdb',
          method: 'get',
          path: '/items/item1',
        },
      },
      {
        kind: 'sdk',
        actor: 'peer',
        operation: {
          service: 'rtdb',
          method: 'set',
          path: '/items/item1',
          data: { ownerUid: 'alice', name: 'Overwritten' },
        },
      },
    ],
    fixRules: { rtdb: fixedRulesPath },
    copy: {
      severity: 'HIGH',
      title: 'Any signed-in user can overwrite items',
      summary: 'Bob overwrites /items/item1 via the Realtime Database SDK.',
      why: 'The .write rule at /items/$itemId only checks auth != null.',
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
  assert.match(res.provenanceText, /database\.set \/items\/item1/);
  assert.ok(fs.statSync(path.join(res.bundleDir, 'video.mp4')).size > 0);

  const recordedScenario = JSON.parse(fs.readFileSync(path.join(res.bundleDir, 'scenario.json'), 'utf8'));
  const recordedEvents = JSON.parse(fs.readFileSync(path.join(res.bundleDir, 'events.json'), 'utf8'));
  const recordedEvidence = JSON.parse(fs.readFileSync(path.join(res.bundleDir, 'evidence.json'), 'utf8'));
  assert.ok(recordedEvents.every((ev) => ev.service === 'database'));
  assert.ok(recordedEvents.some((ev) => ev.phase === 'hook' && ev.method === 'get'));
  assert.ok(recordedEvents.some((ev) => ev.phase === 'repro' && ev.method === 'set'));

  const timeline = computeStageTimeline({
    scenario: recordedScenario,
    events: recordedEvents,
    evidence: recordedEvidence,
  });
  const copyCheck = checkCopyAgainstEvents({
    copy: recordedScenario.copy,
    slides: timeline.presentation.slides,
    beats: timeline.beats,
    provenanceText: res.provenanceText,
    reproEvent: recordedEvents.find((ev) => ev.phase === 'repro'),
    fixEvent: recordedEvents.find((ev) => ev.phase === 'fix'),
  });
  assert.equal(copyCheck.pass, true, copyCheck.reasons.join('; '));
});

test('RTDB multi-level .validate e2e: unchanged parent .validate with newly added child .validate passes Gates G1-G6 and focuses child scope', async (t) => {
  const dir = makeTempDir('pyric-validate-label-e2e-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const currentRulesPath = writeJson(path.join(dir, 'rules.current.json'), {
    rules: {
      items: {
        $itemId: {
          '.read': 'auth != null',
          '.write': 'auth != null',
          '.validate': "newData.hasChildren(['ownerUid', 'name'])",
        },
      },
    },
  });
  const fixedRulesPath = writeJson(path.join(dir, 'rules.fixed.json'), {
    rules: {
      items: {
        $itemId: {
          '.read': 'auth != null',
          '.write': 'auth != null',
          '.validate': "newData.hasChildren(['ownerUid', 'name'])",
          ownerUid: {
            '.validate': 'newData.val() === auth.uid',
          },
        },
      },
    },
  });
  const seedPath = writeJson(path.join(dir, 'seed.json'), {
    database: {
      items: {
        item1: {
          ownerUid: 'alice',
          name: 'Original',
        },
      },
    },
  });
  const scenarioPath = writeJson(path.join(dir, 'scenario.json'), {
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'camp-validate-e2e', probe: 'probe-validate-owner-binding' },
    rules: { rtdb: currentRulesPath },
    seedFile: seedPath,
    actors: {
      owner: { uid: 'alice', name: 'Alice' },
      peer: { uid: 'bob', name: 'Bob' },
    },
    controlOperation: {
      service: 'database',
      method: 'set',
      path: '/items/item1',
      uid: 'alice',
      data: { ownerUid: 'alice', name: 'Original' },
    },
    reproOperation: {
      service: 'database',
      method: 'set',
      path: '/items/item1',
      uid: 'bob',
      data: { ownerUid: 'alice', name: 'Forged as Alice' },
    },
    fixRules: { rtdb: fixedRulesPath },
    copy: {
      severity: 'HIGH',
      title: 'Peer spoofs ownerUid when writing an item',
      summary: 'Bob writes /items/item1 claiming ownerUid alice.',
      why: 'The .write rule allows authenticated writes and no child .validate rule binds ownerUid to auth.uid.',
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

  const recordedScenario = JSON.parse(fs.readFileSync(path.join(res.bundleDir, 'scenario.json'), 'utf8'));
  const recordedEvents = JSON.parse(fs.readFileSync(path.join(res.bundleDir, 'events.json'), 'utf8'));
  const recordedEvidence = JSON.parse(fs.readFileSync(path.join(res.bundleDir, 'evidence.json'), 'utf8'));

  assert.equal(recordedEvidence.ruleClause, '.validate');
  assert.equal(recordedEvidence.matchedRule, 'items/$itemId/ownerUid: ".validate": true');
  assert.equal(
    recordedEvidence.fixRules.after,
    'items/$itemId/ownerUid: ".validate": "newData.val() === auth.uid"',
  );

  const timeline = computeStageTimeline({
    scenario: recordedScenario,
    events: recordedEvents,
    evidence: recordedEvidence,
  });
  const slides = timeline.presentation.slides;
  assert.equal(
    slides.find((s) => s.id === 'problem-video').subtitle,
    'Allowed by .validate at /items/$itemId/ownerUid',
  );
  assert.equal(
    slides.find((s) => s.id === 'fix-video').subtitle,
    'Blocked by .validate at /items/$itemId/ownerUid',
  );
  assert.equal(
    slides.find((s) => s.id === 'fix-slide').title,
    'Updating .validate at /items/$itemId/ownerUid',
  );
  assert.equal(slides.find((s) => s.id === 'fix-slide').beforeDiffTree[0].ruleKey, '.validate');
  assert.equal(slides.find((s) => s.id === 'fix-slide').afterDiffTree[0].ruleKey, '.validate');
});

test('Cloud Storage alias e2e: standalone rules scenario with rules.storage and service = "cloud-storage" passes Gates G1-G6', async (t) => {
  const dir = makeTempDir('pyric-storage-alias-e2e-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const currentStorageRulesPath = path.join(dir, 'storage.current.rules');
  fs.writeFileSync(
    currentStorageRulesPath,
    [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /items/{userId}/{fileName} {',
      '      allow read, write: if request.auth != null;',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  const fixedStorageRulesPath = path.join(dir, 'storage.fixed.rules');
  fs.writeFileSync(
    fixedStorageRulesPath,
    [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /items/{userId}/{fileName} {',
      '      allow read: if request.auth != null;',
      '      allow write: if request.auth != null && request.auth.uid == userId;',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  const scenarioPath = writeJson(path.join(dir, 'scenario.json'), {
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'camp-storage-alias', probe: 'probe-storage-overwrite' },
    rules: { storage: currentStorageRulesPath },
    actors: {
      owner: { uid: 'alice', name: 'Alice' },
      peer: { uid: 'bob', name: 'Bob' },
    },
    controlOperation: {
      service: 'cloud-storage',
      method: 'uploadBytes',
      path: '/items/alice/doc.txt',
      uid: 'alice',
      data: 'Original content',
    },
    steps: [
      {
        kind: 'sdk',
        actor: 'peer',
        operation: {
          service: 'cloud-storage',
          method: 'uploadBytes',
          path: '/items/alice/doc.txt',
          data: 'Overwritten by Bob',
        },
      },
    ],
    fixRules: { storage: fixedStorageRulesPath },
    copy: {
      severity: 'HIGH',
      title: 'Cross-user object upload in Cloud Storage',
      summary: 'Bob uploads /items/alice/doc.txt via the Cloud Storage SDK.',
      why: 'The storage write rule under /items/{userId}/{fileName} only checks request.auth != null.',
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
  assert.match(res.provenanceText, /storage\.uploadBytes \/items\/alice\/doc\.txt/);
  assert.ok(fs.statSync(path.join(res.bundleDir, 'video.mp4')).size > 0);

  const recordedEvents = JSON.parse(fs.readFileSync(path.join(res.bundleDir, 'events.json'), 'utf8'));
  assert.ok(recordedEvents.every((ev) => ev.service === 'storage'));
});
