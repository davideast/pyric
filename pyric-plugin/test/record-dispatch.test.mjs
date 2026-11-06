import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  EvidenceRecordError,
  dispatchRecord,
  isBehaviorScenarioFile,
  parseRecordCliArgs,
} from '../skills/improve-firebase/scripts/record.mjs';

function writeScenario(dir, name, scenario) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, JSON.stringify(scenario));
  return filePath;
}

describe('record.mjs single entry point', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pyric-record-dispatch-'));
  const behaviorPath = writeScenario(tmp, 'behavior.json', {
    schema: 'pyric.evidence.scenario.v1',
    finding: { campaign: 'c', probe: 'p' },
    app: { dist: '/tmp/before' },
    behavior: { fixApp: { dist: '/tmp/after' } },
  });
  const rulesPath = writeScenario(tmp, 'rules.json', {
    schema: 'pyric.evidence.scenario.v1',
    finding: { campaign: 'c', probe: 'p' },
    fixRules: { rtdb: '/tmp/fixed.rules.json' },
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('detects build-variant scenarios by the behavior block', () => {
    assert.equal(isBehaviorScenarioFile(behaviorPath), true);
    assert.equal(isBehaviorScenarioFile(rulesPath), false);
    assert.equal(isBehaviorScenarioFile(null), false);
  });

  it('delegates a behavior scenario to the build recorder with pass-through flags', async () => {
    const cli = parseRecordCliArgs([
      '--scenario', behaviorPath,
      '--out', path.join(tmp, 'out'),
      '--render',
      '--formats', 'mp4,gif',
      '--fps', '24',
      '--json',
    ]);
    let behaviorArgs = null;
    let rulesCalled = false;
    const result = await dispatchRecord(cli, {
      recordRules: async () => {
        rulesCalled = true;
        return { ok: true };
      },
      loadBehaviorRecorder: async () => async (args) => {
        behaviorArgs = args;
        return { ok: true, bundleDir: path.join(tmp, 'out', 'p') };
      },
    });
    assert.equal(rulesCalled, false);
    assert.equal(result.variant, 'build');
    assert.equal(behaviorArgs.scenarioPath, behaviorPath);
    assert.equal(behaviorArgs.outDir, path.join(tmp, 'out'));
    assert.equal(behaviorArgs.render, true);
    assert.deepEqual(behaviorArgs.formats, ['mp4', 'gif']);
    assert.equal(behaviorArgs.fps, 24);
    assert.equal(typeof behaviorArgs.log, 'function');
  });

  it('keeps rules scenarios on the rules recorder', async () => {
    const cli = parseRecordCliArgs(['--scenario', rulesPath, '--out', path.join(tmp, 'out')]);
    let rulesArgs = null;
    await dispatchRecord(cli, {
      recordRules: async (args) => {
        rulesArgs = args;
        return { ok: true };
      },
      loadBehaviorRecorder: async () => {
        throw new Error('build recorder must not load for a rules scenario');
      },
    });
    assert.equal(rulesArgs.scenarioPath, rulesPath);
  });

  it('rejects rules-only flags on a behavior scenario', async () => {
    const cli = parseRecordCliArgs([
      '--scenario', behaviorPath,
      '--out', path.join(tmp, 'out'),
      '--rtdb-rules', path.join(tmp, 'fixed.json'),
    ]);
    await assert.rejects(
      dispatchRecord(cli, {
        loadBehaviorRecorder: async () => async () => ({ ok: true }),
      }),
      (err) => err instanceof EvidenceRecordError && err.code === 'INVALID_CLI_ARGS',
    );
  });
});
