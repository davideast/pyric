import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root = process.env.ORACLE_ROOT;
const {hashes, roles, operations, configFor, event, profile, patch} =
  await import(pathToFileURL(join(root, 'adapters/world-role/v1/fixture.mjs')));
const runtime = pathToFileURL(join(root, 'arcade/runtime/package.json')).href;
const {SimulateFirestoreRulesHandler} = await import(import.meta.resolve('@pyric/rules/internal', runtime));
const sources = Object.fromEntries(Object.keys(hashes).map(mode =>
  [mode, readFileSync(new URL(mode + '.rules', import.meta.url), 'utf8')]));
const simulator = new SimulateFirestoreRulesHandler();

function compare(swapRulesets) {
  const decisions = {};
  for (const mode of Object.keys(sources)) {
    const source = swapRulesets ? sources[mode === 'app' ? 'mirror' : 'app'] : sources[mode];
    for (const role of roles) {
      const config = configFor(role, 'actor', 'owner');
      for (const op of operations) {
        const id = [mode, role, op].join('-');
        const request = op === 'event-delete'
          ? {method: 'delete', path: 'events/oracle-event', resource: event}
          : {method: 'update', path: 'players/owner', resource: profile, data: patch, writeMode: {kind: 'update'}};
        const result = simulator.simulate(source, [{...request, description: id, auth: {uid: 'actor'}, expectation: 'ALLOW'}],
          {getDoc: path => { assert.equal(path, 'world/config'); return config; }});
        assert.ok(result.success, JSON.stringify(result.error));
        const row = result.data.results[0];
        assert.ok(result.data.unsupported === 0 && !row.resourceLimit && ['ALLOW', 'DENY'].includes(row.decision), id);
        decisions[id] = row.decision;
      }
    }
  }
  return decisions;
}
console.log(JSON.stringify({candidate: compare(false), mutant: compare(true)}));
