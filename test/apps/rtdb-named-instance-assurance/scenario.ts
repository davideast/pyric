import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

export default scenario(async (app) => {
  await app.step('write the target and campaign bundle', () => {
    app.writeFile('campaign.json', JSON.stringify({
      schema: "pyric.assurance.campaign.v1",
      id: "test-rtdb-instances-app",
      target: {
        schema: "pyric.assurance.target.v1",
        network: "forbid",
        rules: { 
          rtdb: { rules: { ".read": "false", ".write": "false" } },
          rtdbInstances: {
            "my-named-instance": { rules: { ".read": "true", ".write": "true" } }
          }
        },
        state: {},
      },
      actors: [{ id: "actor1", acquisition: { kind: "anonymous-request" } }],
      invariants: [{
        id: "inv1", statement: "Test named instance", service: "rtdb", expected: "ALLOW", source: "authored-test", confidence: "authoritative"
      }],
      probes: [
        {
          id: "probe-default", actorId: "actor1", invariantId: "inv1",
          control: { service: "rtdb", method: "get", path: "/default-path" },
          mutation: { dimension: "path", description: "mut", operation: { service: "rtdb", method: "get", path: "/default-path-2" } },
        },
        {
          id: "probe-named", actorId: "actor1", invariantId: "inv1",
          control: {
            service: "rtdb", method: "get", path: "/named-path",
            instance: "my-named-instance",
          },
          mutation: {
            dimension: "path", description: "mut",
            operation: {
              service: "rtdb", method: "get", path: "/named-path-2",
              instance: "https://my-named-instance.firebaseio.com",
            },
          },
        },
      ],
    }, null, 2));
  });

  await app.step('run pyric assurance start against the local bundle via a script', async () => {
    app.writeFile('run.mjs', `
import { runAuthorizationCampaign } from '@pyric/cli/assurance';
import { readFileSync } from 'fs';
const spec = JSON.parse(readFileSync('campaign.json', 'utf8'));
runAuthorizationCampaign(spec).then(report => {
  console.log(JSON.stringify(report.results.map(r => ({ probeId: r.probeId, decision: r.control.decision }))));
}).catch(e => {
  console.error(e.message);
  process.exit(1);
});
    `);
    const { output } = await app.serverScript('run.mjs');
    const results = JSON.parse(output);
    assert.deepEqual(results, [
      { probeId: "probe-default", decision: "DENY" },
      { probeId: "probe-named", decision: "ALLOW" }
    ]);
  });
});
