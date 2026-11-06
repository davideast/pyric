import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const cliDist = path.join(repoRoot, 'packages/cli/dist/assurance/index.js');

import { parseCampaignExport, buildScenarioFromAssurance, selectProbeFromExport } from '../../skills/improve-firebase/scripts/lib/from-assurance.mjs';
import { validateScenario, SCENARIO_SCHEMA } from '../../skills/improve-firebase/scripts/lib/contracts.mjs';

test('Live export contract (packages/cli -> from-assurance)', async (t) => {
  if (!fs.existsSync(cliDist)) {
    t.skip(`Skipping: packages/cli/dist/assurance/index.js not found. Run repo build first.`);
    return;
  }

  const { createAssuranceTools } = await import(url.pathToFileURL(cliDist).href);
  const rawTools = createAssuranceTools();
  const tools = Object.fromEntries(rawTools.map((t) => [t.name.replace('firebase_assurance_', ''), t]));
  
  async function call(name, args) {
    const res = await tools[name].execute(args);
    if (!res.ok) throw new Error(`${name} failed: ${res.summary}`);
    return res;
  }

  const CID = 'test-campaign';
  
  await call('start', {
    campaignId: CID,
    target: {
      schema: 'pyric.assurance.target.v1', network: 'forbid',
      rules: { rtdb: { rules: { ".read": true, "secret": { ".write": "auth.uid == 'alice'" } } } },
      state: { rtdb: { secret: "data" }, auth: { users: [{ uid: 'alice' }, { uid: 'bob' }] } },
    }
  });

  await call('map', {
    campaignId: CID,
    actors: [
      { id: 'alice', acquisition: { kind: 'fixture-user', uid: 'alice' } },
      { id: 'bob', acquisition: { kind: 'fixture-user', uid: 'bob' } },
    ],
    observations: [
      { 
        id: 'alice-writes-secret', actorId: 'alice', result: 'ALLOW', source: 'authored',
        description: 'Alice writes secret',
        operation: { service: 'rtdb', method: 'set', path: `/secret`, data: 'new' } 
      },
      { 
        id: 'bob-writes-secret-obs', actorId: 'bob', result: 'ALLOW', source: 'authored',
        description: 'Bob writes secret',
        operation: { service: 'rtdb', method: 'set', path: `/secret`, data: 'new' } 
      },
    ],
  });

  await call('define', {
    campaignId: CID,
    invariants: [{
      id: 'only-alice',
      statement: "Only Alice can write",
      service: 'rtdb', expected: 'DENY', source: 'declared', confidence: 'strong',
    }],
  });

  await call('propose', {
    campaignId: CID, observationId: 'bob-writes-secret-obs', invariantId: 'only-alice',
    mutations: [{ 
      id: 'bob-writes-secret', dimension: 'path',
      description: "Bob writes secret",
      operation: { service: 'rtdb', method: 'set', path: `/secret2`, data: 'new' } 
    }],
  });

  await call('run', { campaignId: CID });

  const exp = await call('export', { campaignId: CID });
  const rawExport = exp.data;

  const parsed = parseCampaignExport(rawExport);
  const probe = selectProbeFromExport(parsed, 'bob-writes-secret');
  
  const result = buildScenarioFromAssurance({
    campaignExport: parsed,
    probe,
    rawScenario: { template: 'tamper' },
    overrideActors: {},
    fixRules: { rtdbRules: {} },
    app: { dist: '/tmp/dist' }
  });
  
  assert.ok(result.scenario);
  result.scenario.schema = SCENARIO_SCHEMA;
  assert.doesNotThrow(() => validateScenario(result.scenario));
  assert.equal(result.controlSource.kind, 'observation', 'Control must come from observation');
  assert.equal(result.controlOperation.path, '/secret', 'Control observation must be from owner (alice)');
});
