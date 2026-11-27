import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const root = process.env.ORACLE_ROOT;
const local = path => pathToFileURL(join(root,path));
const {attempts, pathsFor, messageData, profileData} = await import(local('adapters/pixelwood-chat/v1/fixture.mjs'));
const {sourcePath} = await import(local('adapters/invite-profile/v1/fixture.mjs'));
const runtime = local('arcade/runtime/package.json').href;
const {SimulateFirestoreRulesHandler} = await import(import.meta.resolve('@pyric/rules/internal',runtime));
const {timestamp, serverTimestamp} = await import(import.meta.resolve('@pyric/rules',runtime));
const schedule = JSON.parse(readFileSync(new URL('timing.json',import.meta.url)));
const rules = readFileSync(join(root,sourcePath),'utf8'), handler = new SimulateFirestoreRulesHandler();
const uid = 'offline-sender', epoch = Date.UTC(2026,0,1);
const iso = ms => new Date(epoch + ms).toISOString();

function evaluate(method, path, data, resource, writeMode, at, getDoc) {
  const test = {description:path, path, method, auth:{uid}, data, ...(resource ? {resource} : {}),
    writeMode, requestTime:iso(at), expectation:'ALLOW'};
  const result = handler.simulate(rules,[test],{getDoc});
  assert.ok(result.success,JSON.stringify(result.error));
  const row = result.data.results[0];
  assert.ok(!result.data.unsupported && !row.resourceLimit && ['ALLOW','DENY'].includes(row.decision));
  return row.decision;
}

function replay(rapidMs, recoveryMs, frozenClock) {
  let lastStamp;
  const decisions = {};
  for (const attempt of attempts) {
    if (attempt.fresh) lastStamp = undefined;
    let at = 0;
    if (!attempt.fresh) at = attempt.id === 'rapid-repeat' || frozenClock ? rapidMs : recoveryMs;
    const p = pathsFor(uid,'offline',attempt.id);
    const getDoc = path => path === p.profile ? profileData(attempt.profile) : null;
    const ledger = evaluate(lastStamp === undefined ? 'create' : 'update',p.ledger,{lastChatAt:serverTimestamp()},
      lastStamp === undefined ? undefined : {lastChatAt:timestamp(iso(lastStamp))},{kind:'set',merge:true},at,getDoc);
    let message = 'NOT_SUBMITTED';
    if (ledger === 'ALLOW') {
      lastStamp = at;
      message = evaluate('create',p.message,messageData(uid,attempt.profile,serverTimestamp()),undefined,
        {kind:'set',merge:false},at,getDoc);
    }
    decisions[attempt.id] = {ledger,message};
  }
  return decisions;
}
const candidate = replay(schedule.rapid[0],schedule.recovery[0],false);
// A refusal has no committed request timestamp. Exercise the ends of its server-time bracket.
for (const rapid of new Set(schedule.rapid)) {
  for (const recovery of new Set(schedule.recovery)) {
    assert.deepEqual(replay(rapid,recovery,false),candidate,'decision varies inside the measured time interval');
  }
}
console.log(JSON.stringify({candidate,mutant:replay(schedule.rapid[0],schedule.recovery[0],true)}));
