import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../');
const cliDist = path.join(repoRoot, 'packages/cli/dist/index.mjs');

import { parseCampaignExport, buildScenarioFromAssurance } from '../../skills/improve-firebase/scripts/lib/from-assurance.mjs';
import { validateScenario } from '../../skills/improve-firebase/scripts/lib/contracts.mjs';

test('Live export contract (packages/cli -> from-assurance)', async (t) => {
  if (!fs.existsSync(cliDist)) {
    t.skip('Skipping: packages/cli/dist/index.mjs not found. Run repo build first.');
    return;
  }

  const { createAssuranceTools } = await import(url.pathToFileURL(cliDist).href);
  const tools = createAssuranceTools();
  
  // tiny campaign
  const campaign = tools.createCampaign('test-campaign', {
    target: { service: 'database', rules: { rtdb: { rules: { '.read': true } } } },
    actors: { owner: { uid: 'alice' }, peer: { uid: 'bob' } }
  });
  
  const p1 = tools.createProbe(campaign.id, 'p1');
  p1.mutationSpec = { operation: { service: 'database', method: 'get', path: '/secret' } };
  p1.classification = 'no-counterexample';
  
  const bundle = tools.exportBundle(campaign.id);
  // Need to structure it like export
  const rawExport = {
    schema: 'pyric.assurance.export.v1',
    campaignId: campaign.id,
    target: campaign.target,
    probes: [p1],
    report: { results: [p1] }
  };

  const parsed = parseCampaignExport(rawExport);
  const scenario = buildScenarioFromAssurance({
    campaignExport: parsed,
    probe: parsed.probes[0],
    rawScenario: { template: 'tamper' },
    overrideActors: {},
    fixRules: { rtdbRules: {} }
  });
  
  assert.ok(scenario);
  assert.doesNotThrow(() => validateScenario(scenario));
});
