import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildLockedProvenanceText,
  buildStagePayload,
  ContractValidationError,
  SCENARIO_SCHEMA,
  validateScenario,
} from '../../skills/improve-firebase/scripts/lib/contracts.mjs';
import {
  checkCopyAgainstEvents,
  evaluateGateG1,
  evaluateGateG3,
  evaluateGateG4,
  evaluateGateG5,
  evaluateGateG6,
} from '../../skills/improve-firebase/scripts/lib/gates.mjs';
import { buildScenarioFromAssurance } from '../../skills/improve-firebase/scripts/lib/from-assurance.mjs';
import { extractFocusedRuleSnippet } from '../../skills/improve-firebase/scripts/lib/op-snippet.mjs';
import { computeStageTimeline } from '../../skills/improve-firebase/scripts/lib/render-timeline.mjs';
import { loadPlaywright, resolveChromiumExecutable } from '../../skills/improve-firebase/scripts/lib/runtime.mjs';

function makeTempDir(prefix = 'pyric-rtdb-unit-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return filePath;
}

test('R1 unit: evaluateGateG1 rejects bare RTDB seeds and top-level users trees without a database envelope', (t) => {
  const dir = makeTempDir('pyric-r1-unit-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const probe = {
    id: 'probe-orgs-item-write',
    classification: 'confirmed',
    invariant: 'Only item owner may modify /orgs/$orgId/items/$itemId',
    mutationSpec: {
      operation: {
        service: 'database',
        method: 'set',
        path: '/orgs/org_1/items/item_1',
      },
    },
  };

  const bareSeedPath = writeJson(path.join(dir, 'bare.seed.json'), {
    orgs: { org_1: { items: { item_1: { ownerUid: 'alice', title: 'Roadmap' } } } },
  });
  const usersOnlyBarePath = writeJson(path.join(dir, 'users-only.seed.json'), {
    users: { alice: { profile: { plan: 'pro' } } },
  });
  const mixedBarePath = writeJson(path.join(dir, 'users-orgs.seed.json'), {
    users: { alice: { displayName: 'Alice' } },
    orgs: { org_1: { items: { item_1: { ownerUid: 'alice' } } } },
  });

  for (const candidate of [bareSeedPath, usersOnlyBarePath, mixedBarePath]) {
    const g1 = evaluateGateG1(probe, {
      seedPath: candidate,
      requireRtdbSeedEnvelope: true,
    });
    assert.equal(g1.pass, false, `Expected ${path.basename(candidate)} to fail G1`);
    assert.match(g1.reasons.join(' '), /"database"/);
  }

  for (const [name, envelope] of [
    ['database', { database: { orgs: { org_1: {} } } }],
    ['databases', { databases: { 'shard-b': { orgs: { org_1: {} } } } }],
    ['rtdb', { rtdb: { orgs: { org_1: {} } } }],
  ]) {
    const validPath = writeJson(path.join(dir, `${name}.seed.json`), envelope);
    const g1 = evaluateGateG1(probe, {
      seedPath: validPath,
      requireRtdbSeedEnvelope: true,
    });
    assert.equal(g1.pass, true, `Expected ${name} envelope to pass G1`);
  }
});

test('R2 unit: validateScenario and buildScenarioFromAssurance reject write ops without data, preserve primitive payloads, alias copy.repro, and retain op.instance', () => {
  const baseSpec = {
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'camp-rtdb-op', probe: 'probe-item-write' },
    actors: {
      owner: { uid: 'alice', name: 'Alice' },
      peer: { uid: 'eve', name: 'Eve' },
    },
    copy: {
      title: 'Cross-user item write',
      repro: 'Eve writes to Alice item via copy.repro alias',
      why: 'Missing owner check',
    },
  };

  for (const method of ['set', 'update', 'push']) {
    assert.throws(
      () =>
        validateScenario({
          ...baseSpec,
          reproOperation: {
            service: 'database',
            method,
            path: '/items/item_1',
            uid: 'eve',
          },
        }),
      (err) => err instanceof ContractValidationError && new RegExp(`reproOperation.*${method}.*data`, 'i').test(err.message),
    );

    assert.throws(
      () =>
        validateScenario({
          ...baseSpec,
          controlOperation: {
            service: 'database',
            method,
            path: '/items/item_1',
            uid: 'alice',
          },
          reproOperation: {
            service: 'database',
            method: 'remove',
            path: '/items/item_1',
            uid: 'eve',
          },
        }),
      (err) => err instanceof ContractValidationError && new RegExp(`controlOperation.*${method}.*data`, 'i').test(err.message),
    );
  }

  for (const primitive of [false, 0, '']) {
    const validated = validateScenario({
      ...baseSpec,
      controlOperation: {
        service: 'database',
        method: 'set',
        path: '/items/item_1/archived',
        uid: 'alice',
        instance: 'shard-b',
        data: primitive,
      },
      reproOperation: {
        service: 'database',
        method: 'set',
        path: '/items/item_1/archived',
        uid: 'eve',
        instance: 'shard-b',
        data: primitive,
      },
    });
    assert.equal(validated.copy.summary, 'Eve writes to Alice item via copy.repro alias');
    assert.equal(validated.reproOperation.data, primitive);
    assert.equal(validated.controlOperation.data, primitive);
    assert.equal(validated.reproOperation.instance, 'shard-b');
    assert.equal(validated.controlOperation.instance, 'shard-b');
  }

  // Export-derived write operations without data must also fail validation
  assert.throws(
    () =>
      buildScenarioFromAssurance({
        campaignExport: { campaignId: 'camp-export-missing-data', target: { service: 'database' } },
        probe: {
          probeId: 'probe-missing-write-data',
          classification: 'confirmed',
          actorEvidence: { ownerUid: 'alice', peerUid: 'eve' },
          mutationSpec: {
            operation: {
              service: 'database',
              method: 'set',
              path: '/items/item_1',
            },
          },
        },
      }),
    (err) => err instanceof ContractValidationError && /reproOperation.*set.*data/i.test(err.message),
  );

  // Export-derived operations must retain multi-instance `instance`
  const multiInstPlan = buildScenarioFromAssurance({
    campaignExport: {
      campaignId: 'camp-multi-inst',
      target: { service: 'database' },
      observations: [
        {
          id: 'obs-alice',
          actorId: 'alice',
          uid: 'alice',
          result: 'ALLOW',
          operation: {
            service: 'rtdb',
            method: 'update',
            path: '/items/item_1',
            instance: 'shard-b',
            values: { title: 'Alice update' },
          },
        },
      ],
    },
    probe: {
      probeId: 'probe-shard-update',
      classification: 'confirmed',
      actorEvidence: { uid: 'eve', ownerUid: 'alice' },
      mutationSpec: {
        operation: {
          service: 'rtdb',
          method: 'update',
          path: '/items/item_1',
          instance: 'shard-b',
          values: { title: 'Eve tamper', note: null },
        },
      },
    },
  });
  assert.equal(multiInstPlan.reproOperation.instance, 'shard-b');
  assert.deepEqual(multiInstPlan.reproOperation.data, { title: 'Eve tamper', note: null });
  assert.equal(multiInstPlan.controlOperation.instance, 'shard-b');
  assert.deepEqual(multiInstPlan.controlOperation.data, { title: 'Alice update' });
});

test('R3 unit: computeStageTimeline and split-actors stage render string, boolean, number, and null leaves cleanly', async (t) => {
  const stageHtmlPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../../skills/improve-firebase/assets/stages/split-actors.html',
  );
  const { chromium } = await loadPlaywright({
    projectDir: path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..'),
  });
  const executablePath = resolveChromiumExecutable(chromium);
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());

  const leafCases = [
    {
      name: 'plain-string',
      targetPath: '/users/alice/bio',
      before: 'Staff engineer',
      after: 'https://malicious.example/phish',
      expectedBeforeText: '"Staff engineer"',
      expectedAfterText: '"https://malicious.example/phish"',
    },
    {
      name: 'boolean-true-to-false',
      targetPath: '/items/item_1/archived',
      before: true,
      after: false,
      expectedBeforeText: 'true',
      expectedAfterText: 'false',
    },
    {
      name: 'number-zero',
      targetPath: '/orgs/org_1/quota',
      before: 25,
      after: 0,
      expectedBeforeText: '25',
      expectedAfterText: '0',
    },
    {
      name: 'null-before-create',
      targetPath: '/orgs/org_1/items/item_eve',
      before: null,
      after: { ownerUid: 'eve', title: 'Unauthorized item' },
      controlData: { ownerUid: 'alice', title: 'Alice item' },
      expectedBeforeText: 'null',
      expectedAfterText: '"Unauthorized item"',
    },
  ];

  for (const tc of leafCases) {
    const scenario = validateScenario({
      schema: SCENARIO_SCHEMA,
      finding: { campaign: 'camp-rtdb-r3', probe: `probe-${tc.name}` },
      actors: {
        owner: { uid: 'alice', name: 'Alice' },
        peer: { uid: 'eve', name: 'Eve' },
      },
      copy: {
        title: `Unauthorized write (${tc.name})`,
        summary: `Eve mutates ${tc.targetPath}`,
        why: 'Missing ownership predicate',
      },
      fixRules: {
        before: '".write": "auth != null"',
        after: '".write": "auth != null && auth.uid == $uid"',
      },
    });

    const events = [
      {
        phase: 'control',
        service: 'database',
        method: 'set',
        path: tc.targetPath,
        data: tc.controlData !== undefined ? tc.controlData : tc.before,
        decision: 'ALLOW',
        tMs: 300,
      },
      {
        phase: 'repro',
        service: 'database',
        method: 'set',
        path: tc.targetPath,
        data: tc.after,
        stateBefore: tc.before,
        stateAfter: tc.after,
        decision: 'ALLOW',
        tMs: 900,
      },
      {
        phase: 'fix',
        service: 'database',
        method: 'set',
        path: tc.targetPath,
        data: tc.after,
        decision: 'DENY',
        tMs: 1600,
      },
    ];

    const provenanceText = buildLockedProvenanceText({
      decision: 'ALLOW',
      fixedDecision: 'DENY',
      service: 'database',
      method: 'set',
      path: tc.targetPath,
      actorLabel: 'eve',
    });

    const timeline = computeStageTimeline({
      scenario,
      events,
      durationMs: 2500,
      evidence: {
        service: 'database',
        method: 'set',
        path: tc.targetPath,
        before: tc.before,
        after: tc.after,
      },
    });

    const slides = timeline.presentation.slides;
    const problemSlide = slides.find((s) => s.id === 'problem-video');
    assert.deepEqual(problemSlide.stateBefore, tc.before);
    assert.deepEqual(problemSlide.stateAfter, tc.after);

    const payload = buildStagePayload({
      scenario,
      fps: 30,
      beats: timeline.beats,
      slides,
      passes: { repro: { fps: 30, totalFrames: 1, frames: [] } },
      evidence: {
        service: 'database',
        method: 'set',
        path: tc.targetPath,
        before: tc.before,
        after: tc.after,
      },
      provenanceText,
    });

    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err));
    await page.addInitScript((p) => {
      window.__PYRIC_EVIDENCE__ = p;
    }, payload);
    await page.goto(`file://${stageHtmlPath}`);
    await page.waitForFunction(() => typeof window.setFrame === 'function');
    await page.evaluate(
      (tSec) => window.setFrame(tSec),
      (problemSlide.startMs + problemSlide.endMs) / 2000,
    );

    assert.equal(pageErrors.length, 0, `Unexpected stage error for ${tc.name}: ${pageErrors[0]?.message}`);
    const domState = await page.evaluate(() => ({
      beforeHidden: document.getElementById('statePaneBefore').hidden,
      afterHidden: document.getElementById('statePaneAfter').hidden,
      beforeText: document.getElementById('stateContentBefore').textContent.trim(),
      afterText: document.getElementById('stateContentAfter').textContent.trim(),
      provenance: document.querySelector('[data-pyric-provenance]')?.textContent || '',
    }));

    assert.equal(domState.beforeHidden, false);
    assert.equal(domState.afterHidden, false);
    assert.ok(domState.beforeText.includes(tc.expectedBeforeText));
    assert.ok(domState.afterText.includes(tc.expectedAfterText));
    assert.equal(domState.provenance, provenanceText);
    await page.close();
  }
});

test('R4 & R6 unit: initialSeedValue avoids unrelated control fallback, read/error gates stay strict, and op-snippet uses isReadOperationMethod', () => {
  const planUnknownBefore = buildScenarioFromAssurance({
    campaignExport: { campaignId: 'camp-rtdb-r4' },
    probe: {
      probeId: 'probe-item-blind-write',
      classification: 'confirmed',
      invariant: { id: 'inv-1', name: 'Protected items', description: 'Clients cannot overwrite write-only items' },
      actorEvidence: { ownerUid: 'alice', peerUid: 'eve' },
      mutationSpec: {
        operation: {
          service: 'database',
          method: 'set',
          path: '/items/item_secret',
          data: { ownerUid: 'alice', status: 'forged' },
        },
      },
    },
    scenarioOverride: {
      controlOperation: {
        service: 'database',
        method: 'set',
        path: '/orgs/org_1/items/item_1',
        uid: 'alice',
        data: { ownerUid: 'alice', title: 'Alice item' },
      },
    },
  });
  assert.equal(planUnknownBefore.initialSeedValue, undefined);

  assert.equal(
    evaluateGateG3(
      {
        decision: 'ALLOW',
        method: 'get',
        path: '/users/alice/profile',
        data: { exists: true, value: { ownerUid: 'alice', plan: 'enterprise' } },
        changedPaths: [],
      },
      ['/users/alice/profile'],
    ).pass,
    true,
  );
  assert.equal(
    evaluateGateG3(
      {
        decision: 'ALLOW',
        method: 'get',
        path: '/users/alice/profile',
        data: { exists: false, value: null },
        changedPaths: [],
      },
      ['/users/alice/profile'],
    ).pass,
    false,
  );
  assert.equal(
    evaluateGateG4({
      mode: 'data-plane',
      stateDiff: { isRead: true, changed: false, before: null, after: null, changedPaths: [] },
    }).pass,
    false,
  );

  // Non-rule ERROR must never satisfy Gate G5
  const g5Error = evaluateGateG5({
    enabled: true,
    fixControlResult: { decision: 'ALLOW' },
    fixReproduceResult: { decision: 'ERROR', status: 400, error: 'HTTP 400 invalid argument' },
    fixStateDiff: { changedPaths: [] },
  });
  assert.equal(g5Error.pass, false);
  assert.match(g5Error.reasons.join(' '), /"DENY".*"ERROR"/);

  // op-snippet extractFocusedRuleSnippet treats getBytes as read (.read), not .write
  const snippet = extractFocusedRuleSnippet(
    { rules: { items: { $id: { '.read': 'auth != null', '.write': false } } } },
    { service: 'database', method: 'getBytes', path: '/items/item_1' },
  );
  assert.match(snippet, /"\.read":\s*"auth != null"/);
});

test('Slide & G6 copy integrity: truthful defaults for create, delete, read+write-control, and non-exists fix, with hard G6 slide checking and zero em dashes', (t) => {
  const baseActors = {
    owner: { uid: 'alice', name: 'Alice' },
    peer: { uid: 'eve', name: 'Eve' },
  };

  // 1. New-key create where fix restricts membership (does NOT allow new records by non-members)
  const createScenario = validateScenario({
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'camp-copy', probe: 'probe-create' },
    actors: baseActors,
    copy: {
      title: 'Non-member creates org item',
      summary: 'Eve creates /orgs/org_1/items/item_eve without org membership.',
      why: 'Write rule on /orgs/$orgId/items/$itemId only checked auth != null.',
    },
    fixRules: {
      before: 'orgs/$orgId/items/$itemId: ".write": "auth != null"',
      after:
        'orgs/$orgId/items/$itemId: ".write": "auth != null && root.child(\'orgs\').child($orgId).child(\'members\').child(auth.uid).val() === true"',
    },
  });
  const createEvents = [
    {
      phase: 'control',
      service: 'database',
      method: 'set',
      path: '/orgs/org_1/items/item_alice',
      data: { ownerUid: 'alice', title: 'Alice item' },
      decision: 'ALLOW',
      tMs: 300,
    },
    {
      phase: 'repro',
      actorLabel: 'eve',
      service: 'database',
      method: 'set',
      path: '/orgs/org_1/items/item_eve',
      data: { ownerUid: 'eve', title: 'Injected item' },
      stateBefore: null,
      stateAfter: { ownerUid: 'eve', title: 'Injected item' },
      decision: 'ALLOW',
      tMs: 900,
    },
    {
      phase: 'fix',
      actorLabel: 'eve',
      service: 'database',
      method: 'set',
      path: '/orgs/org_1/items/item_eve',
      data: { ownerUid: 'eve', title: 'Injected item' },
      decision: 'DENY',
      matchedRule: createScenario.fixRules.after,
      tMs: 1600,
    },
  ];
  const createTl = computeStageTimeline({
    scenario: createScenario,
    events: createEvents,
    evidence: {
      service: 'database',
      method: 'set',
      path: '/orgs/org_1/items/item_eve',
      before: null,
      after: { ownerUid: 'eve', title: 'Injected item' },
      fixRules: {
        before: createScenario.fixRules.before,
        after: createScenario.fixRules.after,
        beforeFull: createScenario.fixRules.before,
        afterFull: createScenario.fixRules.after,
      },
    },
  });
  const createSlides = createTl.presentation.slides;
  const createProblemSlide = createSlides.find((s) => s.id === 'problem-slide');
  const createProblemVideo = createSlides.find((s) => s.id === 'problem-video');
  const createPathSlide = createSlides.find((s) => s.id === 'path-slide');
  const createFixSlide = createSlides.find((s) => s.id === 'fix-slide');
  const createDeckText = JSON.stringify({ slides: createSlides, beats: createTl.beats });

  assert.doesNotMatch(createSlides.find((s) => s.id === 'problem-slide').subtitle, /overwrite|existing/i);
  assert.match(createProblemSlide.subtitle, /\bcreate\b/i);
  assert.match(createProblemVideo.subtitle, /Allowed by \.write at \/orgs\/\$orgId\/items\/\$itemId/);
  assert.doesNotMatch(JSON.stringify(createPathSlide), /Authored by alice/i);
  assert.doesNotMatch(createFixSlide.subtitle, /require a new record|matching author UID/i);
  assert.doesNotMatch(JSON.stringify(createFixSlide.beforeDiffTree), /Only checks membership/i);
  assert.equal(/\u2014/.test(createDeckText), false, 'Slides and beats must contain zero em dashes');

  const twoClauseCreateTl = computeStageTimeline({
    scenario: validateScenario({
      ...createScenario,
      fixRules: {
        before: 'orgs/org_1/items/$itemId: ".write": "auth != null"',
        after: 'orgs/org_1/items/$itemId: ".write": "auth != null && data.exists() && data.child(\'ownerUid\').val() === auth.uid"',
      },
    }),
    events: createEvents,
    evidence: {
      service: 'database',
      method: 'set',
      path: '/orgs/org_1/items/item_eve',
      before: null,
      after: { ownerUid: 'eve', title: 'Injected item' },
    },
  });
  assert.match(
    twoClauseCreateTl.presentation.slides.find((s) => s.id === 'fix-slide').subtitle,
    /data\.exists\(\) && data\.child\('ownerUid'\)\.val\(\) === auth\.uid/,
  );

  const createProv = buildLockedProvenanceText({
    decision: 'ALLOW',
    fixedDecision: 'DENY',
    service: 'database',
    method: 'set',
    path: '/orgs/org_1/items/item_eve',
    actorLabel: 'eve',
  });
  const createCopyCheck = checkCopyAgainstEvents({
    copy: createScenario.copy,
    slides: createSlides,
    beats: createTl.beats,
    provenanceText: createProv,
    reproEvent: createEvents[1],
    fixEvent: createEvents[2],
  });
  assert.equal(createCopyCheck.pass, true, createCopyCheck.reasons.join('; '));

  // 2. Delete repro (method: remove) must say delete/remove, never overwrite
  const deleteScenario = validateScenario({
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'camp-copy', probe: 'probe-delete' },
    actors: baseActors,
    copy: {
      title: 'Peer deletes owner item',
      summary: 'Eve deletes /items/item_1 directly.',
      why: 'Write rule on /items/$id did not check ownerUid.',
    },
    fixRules: {
      before: 'items/$id: ".write": "auth != null"',
      after: 'items/$id: ".write": "auth != null && data.child(\'ownerUid\').val() === auth.uid"',
    },
  });
  const deleteEvents = [
    {
      phase: 'control',
      service: 'database',
      method: 'set',
      path: '/items/item_1',
      data: { ownerUid: 'alice', title: 'Keep me' },
      decision: 'ALLOW',
      tMs: 300,
    },
    {
      phase: 'repro',
      actorLabel: 'eve',
      service: 'database',
      method: 'remove',
      path: '/items/item_1',
      stateBefore: { ownerUid: 'alice', title: 'Keep me' },
      stateAfter: null,
      decision: 'ALLOW',
      tMs: 900,
    },
    {
      phase: 'fix',
      actorLabel: 'eve',
      service: 'database',
      method: 'remove',
      path: '/items/item_1',
      decision: 'DENY',
      matchedRule: deleteScenario.fixRules.after,
      tMs: 1600,
    },
  ];
  const deleteTl = computeStageTimeline({
    scenario: deleteScenario,
    events: deleteEvents,
    evidence: {
      service: 'database',
      method: 'remove',
      path: '/items/item_1',
      before: { ownerUid: 'alice', title: 'Keep me' },
      after: null,
      fixRules: {
        beforeFull: deleteScenario.fixRules.before,
        afterFull: deleteScenario.fixRules.after,
      },
    },
  });
  const deleteSlides = deleteTl.presentation.slides;
  assert.doesNotMatch(deleteSlides.find((s) => s.id === 'problem-slide').subtitle, /overwrite/i);
  assert.match(deleteSlides.find((s) => s.id === 'problem-slide').subtitle, /delete|remove/i);
  assert.match(deleteSlides.find((s) => s.id === 'problem-video').title, /deletes/i);

  // 3. Read repro with write control + literal path segments (/users/alice/bio)
  const readScenario = validateScenario({
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'camp-copy', probe: 'probe-read-literal' },
    actors: baseActors,
    copy: {
      title: 'Private bio exposed to peers',
      summary: 'Eve reads /users/alice/bio.',
      why: 'Read rule at /users allowed any signed-in user.',
      fixContext: 'Custom scenario fixContext wins over defaults.',
    },
    fixRules: {
      before: 'users: ".read": "auth != null"',
      after: 'users/$uid: ".read": "auth != null && auth.uid === $uid"',
    },
  });
  const readEvents = [
    {
      phase: 'control',
      service: 'database',
      method: 'set',
      path: '/users/alice/bio',
      data: 'Staff engineer',
      decision: 'ALLOW',
      tMs: 300,
    },
    {
      phase: 'repro',
      actorLabel: 'eve',
      service: 'database',
      method: 'get',
      path: '/users/alice/bio',
      stateBefore: 'Staff engineer',
      stateAfter: 'Staff engineer',
      decision: 'ALLOW',
      tMs: 900,
    },
    {
      phase: 'fix',
      actorLabel: 'eve',
      service: 'database',
      method: 'get',
      path: '/users/alice/bio',
      decision: 'DENY',
      matchedRule: readScenario.fixRules.after,
      tMs: 1600,
    },
  ];
  const readTl = computeStageTimeline({
    scenario: readScenario,
    events: readEvents,
    evidence: {
      service: 'database',
      method: 'get',
      path: '/users/alice/bio',
      before: 'Staff engineer',
      after: 'Staff engineer',
      fixRules: {
        beforeFull: readScenario.fixRules.before,
        afterFull: readScenario.fixRules.after,
      },
    },
  });
  const readSlides = readTl.presentation.slides;
  const readPathTokens = readSlides.find((s) => s.id === 'path-slide').pathTokens;
  const bioToken = readPathTokens.find((tok) => tok.concreteValue === 'bio');
  assert.equal(bioToken.text, 'bio', 'Literal leaf segment bio must not be relabeled as $bio');
  assert.equal(bioToken.isParam, false);
  assert.match(readSlides.find((s) => s.id === 'attach-demo').subtitle, /\bwrite\b/i);
  assert.equal(readSlides.find((s) => s.id === 'fix-video').titleBefore, 'Owner write');
  assert.match(readSlides.find((s) => s.id === 'problem-video').subtitle, /Allowed by \.read at \/users/);
  assert.equal(
    readSlides.find((s) => s.id === 'fix-slide').subtitle,
    'Custom scenario fixContext wins over defaults.',
  );

  // 4. checkCopyAgainstEvents & evaluateGateG6 catch contradictory slide copy and return fatal: true
  const badSlideCheck = checkCopyAgainstEvents({
    copy: createScenario.copy,
    slides: [
      { id: 'problem-slide', subtitle: "Eve calls the SDK to overwrite Alice's existing item." },
      { id: 'path-slide', pathTokens: [{ text: 'item_eve', callout: { label: 'Target', detail: 'Authored by alice' } }] },
      { id: 'fix-slide', subtitle: 'Require a new record or matching author UID.' },
    ],
    provenanceText: createProv,
    reproEvent: createEvents[1],
    fixEvent: createEvents[2],
  });
  assert.equal(badSlideCheck.pass, false);
  assert.ok(badSlideCheck.reasons.some((r) => /overwrite/i.test(r)));
  assert.ok(badSlideCheck.reasons.some((r) => /Authored by alice/i.test(r)));
  assert.ok(badSlideCheck.reasons.some((r) => /new record/i.test(r)));

  const dir = makeTempDir('pyric-g6-fatal-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dummyVideo = path.join(dir, 'video.mp4');
  fs.writeFileSync(dummyVideo, Buffer.alloc(128, 1));
  const failedG6 = evaluateGateG6({
    videoPath: dummyVideo,
    ffprobeResult: { width: 1920, height: 1080, durationSec: 12 },
    expectedWidth: 1920,
    expectedHeight: 1080,
    posterPath: path.join(dir, 'missing-poster.png'),
    domProvenanceText: createProv,
    expectedProvenanceText: createProv,
    copy: createScenario.copy,
    slides: [{ id: 'problem-slide', subtitle: "Eve calls the SDK to overwrite Alice's existing item." }],
    events: createEvents,
  });
  assert.equal(failedG6.pass, false);
  assert.equal(failedG6.fatal, true, 'Gate G6 failures must carry fatal: true');
  assert.ok(failedG6.reasons.some((r) => /overwrite/i.test(r)));
});
