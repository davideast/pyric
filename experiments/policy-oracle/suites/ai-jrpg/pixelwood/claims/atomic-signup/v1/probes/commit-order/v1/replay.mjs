import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const root = process.env.ORACLE_ROOT;
const oracleModule = path => pathToFileURL(join(root, path));
const {signup} = await import(oracleModule('adapters/atomic-signup/v1/fixture.mjs'));
const {materialize, seedTime, sourcePath} = await import(oracleModule('adapters/invite-profile/v1/fixture.mjs'));
const runtime = oracleModule('arcade/runtime/package.json').href;
const {SimulateFirestoreRulesHandler, projectAfterState} = await import(import.meta.resolve('@pyric/rules/internal', runtime));
const {timestamp, serverTimestamp} = await import(import.meta.resolve('@pyric/rules', runtime));
const rules = readFileSync(join(root,sourcePath),'utf8');
const handler = new SimulateFirestoreRulesHandler();
const caller = 'offline-claimant', reader = 'offline-reader';
const {paths, attempts} = signup(caller,'offline');
const fresh = () => new Map([[paths.invite,{createdBy:reader, createdAt:timestamp(seedTime), usedBy:null, usedAt:null}],
  ['world/config',{admins:[reader]}]]);

function commit(docs, writes, requestTime) {
  const projected = new Map();
  const requests = writes.map(write => {
    const resource = docs.get(write.path);
    const writeMode = write.method === 'update' ? {kind:'update'} : {kind:'set',merge:false};
    projected.set(write.path, projectAfterState(writeMode, resource ?? null, materialize(write.data,timestamp(requestTime))));
    return {description:write.path, path:write.path, method:write.method, auth:{uid:caller},
      ...(resource ? {resource} : {}), data:materialize(write.data,serverTimestamp()), writeMode, requestTime, expectation:'ALLOW'};
  });
  const result = handler.simulate(rules, requests, {getDoc:path => docs.get(path) ?? null,
    ...(writes.length > 1 ? {batchProjection:projected} : {})});
  assert.ok(result.success, JSON.stringify(result.error));
  const rows = result.data.results;
  assert.equal(rows.length, writes.length);
  assert.ok(result.data.unsupported === 0 && rows.every(row => !row.resourceLimit && ['ALLOW','DENY'].includes(row.decision)));
  if (rows.some(row => row.decision === 'DENY')) return 'DENY';
  for (const [path,value] of projected) docs.set(path,value);
  return 'ALLOW';
}

function replay(splitBatch) {
  const atomicState = fresh(), sequentialState = fresh(), decisions = {};
  for (const [index,attempt] of attempts.entries()) {
    const time = new Date(Date.UTC(2026,1,1,0,0,index)).toISOString();
    if (attempt.method === 'writeBatch.commit' && splitBatch) {
      decisions[attempt.id] = attempt.writes.every(write => commit(atomicState,[write],time) === 'ALLOW') ? 'ALLOW' : 'DENY';
    } else {
      decisions[attempt.id] = commit(attempt.method === 'writeBatch.commit' ? atomicState : sequentialState,attempt.writes,time);
    }
  }
  return decisions;
}
console.log(JSON.stringify({candidate:replay(false), mutant:replay(true)}));
