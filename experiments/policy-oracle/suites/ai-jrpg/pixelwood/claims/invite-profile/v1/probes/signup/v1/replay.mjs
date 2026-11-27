import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const root = process.env.ORACLE_ROOT;
const {accounts, fixture, materialize, seedTime, sourcePath} =
  await import(pathToFileURL(join(root, 'adapters/invite-profile/v1/fixture.mjs')));
const runtime = pathToFileURL(join(root, 'arcade/runtime/package.json')).href;
const {SimulateFirestoreRulesHandler} = await import(import.meta.resolve('@pyric/rules/internal', runtime));
const {serverTimestamp, timestamp} = await import(import.meta.resolve('@pyric/rules', runtime));
const source = readFileSync(join(root, sourcePath), 'utf8');
const simulator = new SimulateFirestoreRulesHandler();
const actors = Object.fromEntries(accounts.map(role => [role, 'offline-' + role]));
const {paths, steps} = fixture(actors, 'offline');

function replay(staleInvite) {
  const seed = {createdBy:actors.reader, createdAt:timestamp(seedTime), usedBy:null, usedAt:null};
  const docs = new Map([[paths.invite, seed], ['world/config', {admins:[actors.reader]}]]);
  const results = {};
  for (const [index, step] of steps.entries()) {
    const path = paths[step.target], prior = docs.get(path);
    const requestTime = new Date(Date.UTC(2026, 1, 1, 0, 0, index)).toISOString();
    const request = {description:step.id, auth:{uid:actors[step.role]}, method:step.method, path,
      ...(prior ? {resource:prior} : {}), data:materialize(step.data, serverTimestamp()), requestTime,
      writeMode:step.method === 'update' ? {kind:'update'} : {kind:'set', merge:false}, expectation:'ALLOW'};
    const result = simulator.simulate(source, [request], {getDoc: key =>
      staleInvite && key === paths.invite ? seed : docs.get(key) ?? null});
    assert.ok(result.success, JSON.stringify(result.error));
    const row = result.data.results[0];
    assert.ok(result.data.unsupported === 0 && !row.resourceLimit && ['ALLOW','DENY'].includes(row.decision), step.id);
    results[step.id] = row.decision;
    if (row.decision === 'ALLOW') docs.set(path, {...prior, ...materialize(step.data, timestamp(requestTime))});
  }
  return results;
}
console.log(JSON.stringify({candidate:replay(false), mutant:replay(true)}));
