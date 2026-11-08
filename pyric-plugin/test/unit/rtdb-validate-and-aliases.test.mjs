import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildLockedProvenanceText,
  buildStagePayload,
  SCENARIO_SCHEMA,
  validateScenario,
} from '../../skills/improve-firebase/scripts/lib/contracts.mjs';
import { checkCopyAgainstEvents } from '../../skills/improve-firebase/scripts/lib/gates.mjs';
import {
  extractFocusedRuleSnippet,
  normalizeServiceName,
  tryNormalizeServiceName,
} from '../../skills/improve-firebase/scripts/lib/op-snippet.mjs';
import { computeStageTimeline } from '../../skills/improve-firebase/scripts/lib/render-timeline.mjs';
import {
  formatShortRtdbScope,
  resolveRtdbRuleClause,
  sanitizeInlineRuleSource,
} from '../../skills/improve-firebase/scripts/lib/rtdb-rule-clause.mjs';
import { loadPlaywright, resolveChromiumExecutable } from '../../skills/improve-firebase/scripts/lib/runtime.mjs';
import { executeStep } from '../../skills/improve-firebase/scripts/lib/steps.mjs';
import { prepareIsolatedSandboxInputs } from '../../skills/improve-firebase/scripts/record.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Service aliases: tryNormalizeServiceName, executeStep, computeStageTimeline, and checkCopyAgainstEvents normalize rtdb, fs, and cloud-storage', async () => {
  assert.equal(normalizeServiceName('rtdb'), 'database');
  assert.equal(normalizeServiceName('fs'), 'firestore');
  assert.equal(normalizeServiceName('cloud-storage'), 'storage');

  assert.equal(tryNormalizeServiceName('rtdb'), 'database');
  assert.equal(tryNormalizeServiceName('fs'), 'firestore');
  assert.equal(tryNormalizeServiceName('cloud-storage'), 'storage');
  assert.equal(tryNormalizeServiceName(undefined, 'database'), 'database');
  assert.equal(tryNormalizeServiceName('', null), null);
  assert.equal(tryNormalizeServiceName('custom-svc'), 'custom-svc');

  const emitted = [];
  const fakeSandbox = {
    async executeOperation() {
      return { decision: 'ALLOW', status: 200, data: null, error: null, latencyMs: 1 };
    },
  };

  const hookRes = await executeStep({
    step: {
      kind: 'sdk',
      phase: 'hook',
      actor: 'owner',
      idToken: 'tok-alice',
      operation: {
        service: 'rtdb',
        method: 'set',
        path: '/items/item1',
        data: { name: 'Seeded' },
      },
    },
    sandbox: fakeSandbox,
    onEvent: (ev) => emitted.push(ev),
  });
  assert.equal(hookRes.event.service, 'database');
  assert.equal(hookRes.event.phase, 'hook');
  assert.equal(emitted[0].phase, 'hook');

  const frameRes = await executeStep({
    step: {
      kind: 'sdk',
      actor: 'peer',
      idToken: 'tok-bob',
      rateHz: 120,
      operation: {
        service: 'cloud-storage',
        method: 'uploadBytes',
        path: 'items/item1.txt',
      },
      frames: [{ body: 'v1' }, { body: 'v2' }],
    },
    sandbox: fakeSandbox,
    onEvent: (ev) => emitted.push(ev),
  });
  assert.ok(frameRes.events.every((ev) => ev.service === 'storage'));

  // Timeline with app view + raw alias in scenario.reproOperation and events
  const storageAppScenario = validateScenario({
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'camp-alias', probe: 'probe-storage-alias' },
    app: { url: 'http://127.0.0.1:5000' },
    actors: { owner: { uid: 'alice', name: 'Alice' }, peer: { uid: 'bob', name: 'Bob' } },
    reproOperation: {
      service: 'cloud-storage',
      method: 'uploadBytes',
      path: '/items/alice/doc.txt',
      data: 'overwritten',
    },
    fixRules: { after: 'allow write: if request.auth != null && request.auth.uid == userId;' },
    copy: {
      title: 'Cross-user object overwrite',
      summary: 'Placeholder overwritten below to test defaultTitleSubtitle',
      why: 'Storage write rule only checks request.auth != null.',
    },
  });
  storageAppScenario.copy.summary = '';

  const storageTimeline = computeStageTimeline({
    scenario: storageAppScenario,
    events: [
      {
        phase: 'repro',
        tMs: 900,
        service: 'cloud-storage',
        method: 'uploadBytes',
        path: '/items/alice/doc.txt',
        data: 'overwritten',
        decision: 'ALLOW',
      },
      {
        phase: 'fix',
        tMs: 2100,
        service: 'cloud-storage',
        method: 'uploadBytes',
        path: '/items/alice/doc.txt',
        data: 'overwritten',
        decision: 'DENY',
      },
    ],
  });
  const reproBeat = storageTimeline.beats.find((b) => b.id === 'repro');
  assert.match(reproBeat.sdkCall, /^storage\.uploadBytes\(/);
  const sSlides = storageTimeline.presentation.slides;
  assert.match(sSlides.find((s) => s.id === 'title').subtitle, /Cloud Storage SDK/);
  assert.match(sSlides.find((s) => s.id === 'problem-slide').subtitle, /Cloud Storage SDK/);
  assert.match(sSlides.find((s) => s.id === 'problem-slide').code, /^storage\.uploadBytes\(/);
  assert.equal(
    sSlides.find((s) => s.id === 'problem-video').actionStatusPending,
    'Sending storage.uploadBytes as bob',
  );
  assert.equal(
    sSlides.find((s) => s.id === 'fix-video').actionStatusPending,
    'Re-running storage.uploadBytes as bob',
  );

  // Fallback when reproEvent omits service: falls back to scenario.reproOperation.service normalized
  const fallbackTimeline = computeStageTimeline({
    scenario: validateScenario({
      schema: SCENARIO_SCHEMA,
      finding: { campaign: 'camp-alias', probe: 'probe-fs-fallback' },
      actors: { owner: { uid: 'alice', name: 'Alice' }, peer: { uid: 'bob', name: 'Bob' } },
      reproOperation: {
        service: 'fs',
        method: 'setDoc',
        path: '/items/item1',
        data: { name: 'Overwritten' },
      },
      copy: {
        title: 'Firestore doc overwrite',
        summary: 'Bob overwrites /items/item1.',
        why: 'Open write.',
      },
    }),
    events: [{ phase: 'repro', tMs: 800, method: 'setDoc', path: '/items/item1', decision: 'ALLOW' }],
  });
  assert.match(
    fallbackTimeline.presentation.slides.find((s) => s.id === 'problem-slide').subtitle,
    /Firestore SDK/,
  );

  const storageProv = buildLockedProvenanceText({
    decision: 'ALLOW',
    fixedDecision: 'DENY',
    service: 'storage',
    method: 'uploadBytes',
    path: '/items/alice/doc.txt',
    actorLabel: 'bob',
  });
  const copyCheck = checkCopyAgainstEvents({
    copy: {
      title: 'Cross-user object overwrite',
      summary: 'Bob overwrites /items/alice/doc.txt.',
      why: 'Write rule only checks request.auth != null.',
    },
    provenanceText: storageProv,
    reproEvent: {
      decision: 'ALLOW',
      service: 'cloud-storage',
      method: 'uploadBytes',
      path: '/items/alice/doc.txt',
      actorLabel: 'bob',
    },
    fixEvent: {
      decision: 'DENY',
      service: 'storage',
      method: 'uploadBytes',
      path: '/items/alice/doc.txt',
    },
  });
  assert.equal(copyCheck.pass, true, copyCheck.reasons.join('; '));
});

test('Multi-level RTDB .validate fallbackScope precedence and formatShortRtdbScope multi-wildcard walkback', () => {
  assert.equal(formatShortRtdbScope('orgs/$orgId/$memberId/role'), 'orgs/$orgId/$memberId/role');
  assert.equal(formatShortRtdbScope('v1/orgs/$orgId/$memberId/role'), 'orgs/$orgId/$memberId/role');
  assert.equal(formatShortRtdbScope('orgs/$orgId/items/$itemId'), 'items/$itemId');
  assert.equal(formatShortRtdbScope('/'), '');

  // Case A: unchanged parent .validate at /items/$itemId, newly added child .validate at /items/$itemId/role
  const beforeParentValidate = {
    rules: {
      items: {
        $itemId: {
          '.read': 'auth != null',
          '.write': 'auth != null',
          '.validate': "newData.hasChildren(['ownerUid', 'role'])",
        },
      },
    },
  };
  const afterChildValidate = {
    rules: {
      items: {
        $itemId: {
          '.read': 'auth != null',
          '.write': 'auth != null',
          '.validate': "newData.hasChildren(['ownerUid', 'role'])",
          role: {
            '.validate': "newData.val() === 'member'",
          },
        },
      },
    },
  };
  const setItemOp = {
    service: 'database',
    method: 'set',
    path: '/items/item1',
    data: { ownerUid: 'alice', role: 'admin' },
  };
  const clauseA = resolveRtdbRuleClause({
    operation: setItemOp,
    beforeRules: beforeParentValidate,
    afterRules: afterChildValidate,
  });
  assert.equal(clauseA.clause, '.validate');
  assert.equal(clauseA.changedScope, 'items/$itemId/role');

  const beforeSnippetA = extractFocusedRuleSnippet(beforeParentValidate, setItemOp, {
    ruleProp: clauseA.clause,
    fallbackScope: clauseA.changedScope,
  });
  const afterSnippetA = extractFocusedRuleSnippet(afterChildValidate, setItemOp, {
    ruleProp: clauseA.clause,
    fallbackScope: clauseA.changedScope,
  });
  assert.equal(beforeSnippetA, 'items/$itemId/role: ".validate": true');
  assert.equal(afterSnippetA, 'items/$itemId/role: ".validate": "newData.val() === \'member\'"');

  // Case B: unchanged leaf .validate at /items/$itemId/title, newly added ancestor .validate at /items/$itemId
  const beforeLeafValidate = {
    rules: {
      items: {
        $itemId: {
          '.read': 'auth != null',
          '.write': 'auth != null',
          title: {
            '.validate': 'newData.isString()',
          },
        },
      },
    },
  };
  const afterAncestorValidate = {
    rules: {
      items: {
        $itemId: {
          '.read': 'auth != null',
          '.write': 'auth != null',
          '.validate': 'data.exists()',
          title: {
            '.validate': 'newData.isString()',
          },
        },
      },
    },
  };
  const setTitleOp = {
    service: 'database',
    method: 'set',
    path: '/items/item1/title',
    data: 'Created without parent record',
  };
  const clauseB = resolveRtdbRuleClause({
    operation: setTitleOp,
    beforeRules: beforeLeafValidate,
    afterRules: afterAncestorValidate,
  });
  assert.equal(clauseB.clause, '.validate');
  assert.equal(clauseB.changedScope, 'items/$itemId');

  const beforeSnippetB = extractFocusedRuleSnippet(beforeLeafValidate, setTitleOp, {
    ruleProp: clauseB.clause,
    fallbackScope: clauseB.changedScope,
  });
  const afterSnippetB = extractFocusedRuleSnippet(afterAncestorValidate, setTitleOp, {
    ruleProp: clauseB.clause,
    fallbackScope: clauseB.changedScope,
  });
  assert.equal(beforeSnippetB, 'items/$itemId: ".validate": true');
  assert.equal(afterSnippetB, 'items/$itemId: ".validate": "data.exists()"');
});

test('prepareIsolatedSandboxInputs gates campaignExport.target.rulesPath on normalized firestore vs storage service', (t) => {
  const dir = makeTempDir('pyric-storage-cfg-unit-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const storageRulesPath = path.join(dir, 'storage.rules');
  fs.writeFileSync(
    storageRulesPath,
    "rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /{allPaths=**} { allow read, write: if request.auth != null; }\n  }\n}\n",
    'utf8',
  );
  const firestoreRulesPath = path.join(dir, 'firestore.rules');
  fs.writeFileSync(
    firestoreRulesPath,
    "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} { allow read, write: if request.auth != null; }\n  }\n}\n",
    'utf8',
  );

  const storageSetup = prepareIsolatedSandboxInputs({
    projectDir: dir,
    scenarioBaseDir: dir,
    scenario: { actors: { owner: { uid: 'alice' }, peer: { uid: 'bob' } } },
    rawScenario: { rules: { storage: storageRulesPath } },
    campaignExport: {
      target: {
        service: 'cloud-storage',
        rulesPath: 'storage.rules',
      },
    },
    reproOperation: {
      service: 'storage',
      method: 'uploadBytes',
      path: '/items/alice/doc.txt',
      data: 'overwritten',
    },
  });
  t.after(() => fs.rmSync(storageSetup.scratchCfgDir, { recursive: true, force: true }));
  const storageCfg = JSON.parse(fs.readFileSync(storageSetup.firebaseConfigPath, 'utf8'));
  assert.equal(storageCfg.firestore, undefined);
  assert.equal(storageCfg.storage?.rules, path.resolve(storageRulesPath));

  const fsSetup = prepareIsolatedSandboxInputs({
    projectDir: dir,
    scenarioBaseDir: dir,
    scenario: { actors: { owner: { uid: 'alice' }, peer: { uid: 'bob' } } },
    rawScenario: null,
    campaignExport: {
      target: {
        service: 'fs',
        rulesPath: 'firestore.rules',
      },
    },
    reproOperation: {
      service: 'firestore',
      method: 'setDoc',
      path: '/items/item1',
      data: { name: 'overwritten' },
    },
  });
  t.after(() => fs.rmSync(fsSetup.scratchCfgDir, { recursive: true, force: true }));
  const fsCfg = JSON.parse(fs.readFileSync(fsSetup.firebaseConfigPath, 'utf8'));
  assert.equal(fsCfg.storage, undefined);
  assert.equal(fsCfg.firestore?.rules, path.resolve(firestoreRulesPath));
});

test('render-timeline.mjs stays pure without node:fs and never leaks missing rule file paths into slides or beats', () => {
  const renderTimelineSrc = fs.readFileSync(
    path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../../skills/improve-firebase/scripts/lib/render-timeline.mjs',
    ),
    'utf8',
  );
  assert.equal(/node:fs|['"]fs['"]/.test(renderTimelineSrc), false);

  assert.equal(sanitizeInlineRuleSource('/missing/dir/rules.current.json'), null);
  assert.equal(sanitizeInlineRuleSource('./rules/storage.rules'), null);
  assert.ok(sanitizeInlineRuleSource('items/$itemId: ".validate": "newData.val() != null"'));

  const missingScenario = validateScenario({
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'camp-pure', probe: 'probe-no-path-leak' },
    rules: { rtdb: '/missing/dir/rules.current.json' },
    actors: { owner: { uid: 'alice', name: 'Alice' }, peer: { uid: 'bob', name: 'Bob' } },
    reproOperation: {
      service: 'database',
      method: 'set',
      path: '/items/item1',
      data: { name: 'Overwritten' },
    },
    fixRules: { rtdb: '/missing/dir/rules.fixed.json' },
    copy: {
      title: 'Item overwrite',
      summary: 'Bob overwrites /items/item1.',
      why: 'Rule allows any signed-in user.',
    },
  });
  const timeline = computeStageTimeline({
    scenario: missingScenario,
    events: [
      { phase: 'repro', tMs: 900, service: 'database', method: 'set', path: '/items/item1', decision: 'ALLOW' },
      { phase: 'fix', tMs: 2100, service: 'database', method: 'set', path: '/items/item1', decision: 'DENY' },
    ],
  });
  const serialized = JSON.stringify(timeline);
  assert.equal(serialized.includes('/missing/dir/'), false);
  assert.equal(serialized.includes('rules.current.json'), false);
  assert.equal(serialized.includes('rules.fixed.json'), false);
});

test('RTDB .validate vs .write stage rendering, newData highlighting, symmetric G6 copy checks, and stage fallback alignment', async (t) => {
  const currentRulesObj = {
    rules: {
      items: {
        $itemId: {
          '.read': 'auth != null',
          '.write': 'auth != null',
        },
      },
    },
  };
  const fixedValidateRulesObj = {
    rules: {
      items: {
        $itemId: {
          '.read': 'auth != null',
          '.write': 'auth != null',
          '.validate': "newData.child('role').val() === 'member'",
        },
      },
    },
  };
  const op = {
    service: 'database',
    method: 'set',
    path: '/items/item1',
    data: { role: 'admin' },
  };
  const valScenario = validateScenario({
    schema: SCENARIO_SCHEMA,
    finding: { campaign: 'camp-validate', probe: 'probe-validate-role' },
    rules: { rtdb: JSON.stringify(currentRulesObj) },
    actors: { owner: { uid: 'alice', name: 'Alice' }, peer: { uid: 'bob', name: 'Bob' } },
    reproOperation: op,
    fixRules: { rtdb: JSON.stringify(fixedValidateRulesObj) },
    copy: {
      title: 'Peer sets admin role on item',
      summary: 'Bob writes role admin on /items/item1.',
      why: 'The .write rule allows authenticated callers and no .validate rule constrains role.',
    },
  });
  const provenanceText = buildLockedProvenanceText({
    decision: 'ALLOW',
    fixedDecision: 'DENY',
    service: 'database',
    method: 'set',
    path: '/items/item1',
    actorLabel: 'bob',
  });
  const validateEvents = [
    {
      phase: 'repro',
      tMs: 1000,
      actor: 'bob',
      actorLabel: 'bob',
      service: 'database',
      method: 'set',
      path: '/items/item1',
      data: { role: 'admin' },
      stateBefore: { role: 'member' },
      stateAfter: { role: 'admin' },
      decision: 'ALLOW',
    },
    {
      phase: 'fix',
      tMs: 2200,
      actor: 'bob',
      actorLabel: 'bob',
      service: 'database',
      method: 'set',
      path: '/items/item1',
      data: { role: 'admin' },
      stateBefore: { role: 'member' },
      stateAfter: { role: 'member' },
      decision: 'DENY',
    },
  ];
  const timeline = computeStageTimeline({
    scenario: valScenario,
    events: validateEvents,
  });
  const slides = timeline.presentation.slides;
  const vProblemVideo = slides.find((s) => s.id === 'problem-video');
  const vWhySlide = slides.find((s) => s.id === 'why-slide');
  const vFixSlide = slides.find((s) => s.id === 'fix-slide');
  const vFixVideo = slides.find((s) => s.id === 'fix-video');

  assert.equal(vProblemVideo.subtitle, 'Allowed by .validate at /items/$itemId');
  assert.equal(vFixVideo.subtitle, 'Blocked by .validate at /items/$itemId');
  assert.equal(vFixSlide.beforeDiffTree[0].ruleKey, '.validate');
  assert.equal(vFixSlide.afterDiffTree[0].ruleKey, '.validate');
  assert.ok(
    vFixSlide.afterDiffTree[0].ruleLines.some((line) => line.highlight === true),
    'newData .validate clause should be highlighted in afterDiffTree',
  );

  // Verify split-actors.html DOM renders `.validate:`
  const { chromium } = await loadPlaywright({
    projectDir: path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..'),
  });
  const executablePath = resolveChromiumExecutable(chromium);
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(async () => {
    await browser.close();
  });
  const stagesDir = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../../skills/improve-firebase/assets/stages',
  );
  const payload = buildStagePayload({
    scenario: valScenario,
    fps: 30,
    beats: timeline.beats,
    slides,
    passes: { repro: { fps: 30, totalFrames: 1, frames: [] } },
    evidence: { service: 'database', method: 'set', path: '/items/item1', ruleClause: '.validate' },
    provenanceText,
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.addInitScript((p) => {
    window.__PYRIC_EVIDENCE__ = p;
  }, payload);
  await page.goto(`file://${path.join(stagesDir, 'split-actors.html')}`);
  await page.waitForFunction(() => typeof window.setFrame === 'function');
  await page.evaluate((tSec) => window.setFrame(tSec), (vWhySlide.startMs + vWhySlide.endMs) / 2000);
  const whyRuleKeys = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#slideTreeSurface .tree-rule-key')).map((el) => el.textContent.trim()),
  );
  assert.deepEqual(whyRuleKeys, ['.validate:']);
  await page.close();

  // Symmetric checkCopyAgainstEvents guards:
  // 1) .validate finding mislabeled as .write fails
  const mislabeledAsWrite = checkCopyAgainstEvents({
    copy: valScenario.copy,
    slides: [{ id: 'fix-video', title: 'Unauthorized write blocked', subtitle: 'Blocked by .write at /items/$itemId' }],
    provenanceText,
    reproEvent: { ...validateEvents[0], matchedRule: 'items/$itemId: ".validate": true' },
    fixEvent: { ...validateEvents[1], matchedRule: 'items/$itemId: ".validate": "newData.val() != null"' },
  });
  assert.equal(mislabeledAsWrite.pass, false);

  // 2) .write finding mislabeled as .validate fails
  const mislabeledAsValidate = checkCopyAgainstEvents({
    copy: valScenario.copy,
    slides: [{ id: 'fix-video', title: 'Unauthorized write blocked', subtitle: 'Blocked by .validate at /items/$itemId' }],
    provenanceText,
    reproEvent: { ...validateEvents[0], matchedRule: 'items/$itemId: ".write": "auth != null"' },
    fixEvent: { ...validateEvents[1], matchedRule: 'items/$itemId: ".write": "data.child(\'ownerUid\').val() === auth.uid"' },
  });
  assert.equal(mislabeledAsValidate.pass, false);
  assert.match(mislabeledAsValidate.reasons.join('; '), /\.write finding.*\.validate/i);

  // Stage fallback alignment across data-plane.html and single-hero.html
  const dataPlaneSrc = fs.readFileSync(path.join(stagesDir, 'data-plane.html'), 'utf8');
  const singleHeroSrc = fs.readFileSync(path.join(stagesDir, 'single-hero.html'), 'utf8');
  const expectedFallbackLiteral = String.raw`'".validate": "newData.child(\'authorUid\').val() == auth.uid"'`;
  assert.ok(dataPlaneSrc.includes(expectedFallbackLiteral));
  assert.ok(singleHeroSrc.includes(expectedFallbackLiteral));
});
