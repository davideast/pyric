import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {manifest, sha, versionNs} from '../../../arcade/corpus.mjs';
import {databasePath, releaseName} from '../../arcade-sdk/v1/evidence.mjs';
import {directory, fixtureApi, revision, root, rulesFor, variants} from './catalog.mjs';
import {fields, matchesFilter, raceResult} from './values.mjs';

const [probe,raw] = process.argv.slice(2);
const record = JSON.parse(readFileSync(raw));
const {variant,family,runId} = record;
assert.ok(Object.hasOwn(variants,variant) && variants[variant].families.includes(family));
assert.equal(relative(root,resolve(probe)),directory(family,variant));
const recipeFile = join(probe,'recipe.json');
if (existsSync(recipeFile)) {
  const {campaign} = JSON.parse(readFileSync(recipeFile));
  if (campaign) {
    assert.equal(campaign.family,family);
    assert.equal(campaign.variant,variant);
  }
}
const keys = (object,names) => assert.deepEqual(Object.keys(object).sort(),[...names].sort());
assert.deepEqual(record.target,manifest.target);
assert.equal(record.revision,revision);
assert.equal(record.sdk,manifest.target.sdk);
assert.equal(record.endpoint,'firestore.googleapis.com');
assert.match(runId,/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const roles = ['a','b','c'];
keys(record.identities,roles);
const uids = {}, emails = {};
for (const role of roles) {
  const identity = record.identities[role];
  assert.equal(identity.audience,manifest.target.project);
  assert.equal(identity.issuer,'https://securetoken.google.com/'+manifest.target.project);
  assert.match(identity.uid,/^[\w-]+$/);
  uids[role] = identity.uid;
  emails[role] = role+'-'+runId+'@example.invalid';
  if (identity.email !== undefined) {
    assert.equal(variant,'blocking');
    assert.ok(role === 'a' || role === 'b');
    assert.equal(identity.email,emails[role]);
    assert.ok(['anonymous','password'].includes(identity.provider));
  } else {
    assert.equal(identity.provider,'anonymous');
    assert.ok(family !== 'session-access' || role === 'c','missing token email for session caller '+role);
  }
}
assert.equal(new Set(Object.values(uids)).size,roles.length);
assert.deepEqual(record.ctx,{uids,emails,runId,variant});
assert.equal(record.marker,variant === 'blocking' ? 'pyric_oracle/'+runId+'/checks/propagation' : 'mapPins/'+uids.a);

const {phases,beforeProof,afterProof} = record;
const initial = phases['initially-closed'], open = phases.open, restored = phases['restored-closed'];
keys(phases,['initially-closed','open','restored-closed']);
const active = open.proof.rulesetName, closed = manifest.target.closedRuleset;
assert.ok(active.startsWith('projects/'+manifest.target.project+'/rulesets/'));
assert.match(active.split('/').at(-1),/^[a-f0-9-]{36}$/);
assert.notEqual(active,closed);
const digest = sha(rulesFor(variant)), propagation = sha(JSON.stringify(open,null,2)+'\n');
function checkProof(proof,isClosed) {
  assert.equal(proof.databaseUid,manifest.target.uid);
  assert.equal(proof.releaseName,releaseName);
  assert.equal(proof.rulesetName,isClosed ? closed : active);
  assert.equal(proof.rulesSha256,isClosed ? manifest.files['v1/rules/closed.rules'] : digest);
  assert.equal(proof.lockRunId,runId);
  assert.equal(proof.lockVersion,open.proof.lockVersion);
  versionNs(proof.lockVersion);
  versionNs(proof.releaseUpdateTime);
  versionNs(proof.verifiedAt);
}
for (const [name,phase] of Object.entries(phases)) {
  const isClosed = name !== 'open';
  assert.equal(phase.phase,name);
  checkProof(phase.proof,isClosed);
  assert.equal(phase.write,isClosed ? 'DENY' : 'ALLOW');
  assert.equal(phase.read,phase.write);
  assert.ok(versionNs(phase.proof.verifiedAt) <= versionNs(phase.at));
}
for (const proof of [beforeProof,afterProof]) {
  checkProof(proof,false);
  assert.equal(proof.releaseUpdateTime,open.proof.releaseUpdateTime);
  assert.equal(proof.propagationReceiptSha256,propagation);
}
assert.ok(versionNs(initial.at) <= versionNs(open.proof.verifiedAt));
assert.ok(versionNs(beforeProof.verifiedAt)-versionNs(open.at) >= 100000000000n);

const {families} = await fixtureApi(variant);
const steps = families[family](record.ctx);
const paths = [...new Set(steps.flatMap(step=>step.watch))];
assert.ok(!paths.includes(record.marker));
keys(record.rows,steps.map(s=>s.id));
keys(record.seed,paths);
function checkSnapshot(snapshot,path) {
  keys(snapshot,['document','readTime']);
  const readTime = versionNs(snapshot.readTime);
  const doc = snapshot.document;
  if (doc === null) return;
  assert.equal(doc.name,databasePath+'/documents/'+path);
  assert.ok(versionNs(doc.createTime) <= versionNs(doc.updateTime));
  assert.ok(versionNs(doc.updateTime) <= readTime);
}
const known = new Map();
for (const path of paths) {
  const seed = record.seed[path];
  checkSnapshot(seed,path);
  assert.equal(seed.document,null);
  known.set(path,seed);
}

// Convert the submitted fields into their expected wire types. A transform has
// no client-chosen value. Check the actual server timestamp against the
// independent server reads and the document commit version.
function wire(input,observed,lo,hi) {
  if (input === null) return {nullValue:null};
  if (Array.isArray(input)) {
    if (!input.length) return {arrayValue:{}};
    return {arrayValue:{values:input.map((item,i)=>wire(item,observed?.arrayValue?.values[i],lo,hi))}};
  }
  if (input && typeof input === 'object') {
    if (input.$server) {
      const actual = versionNs(observed?.timestampValue);
      assert.ok(actual >= lo-lo%1000000n && actual <= hi,'server timestamp outside write interval');
      return {timestampValue:observed.timestampValue};
    }
    if (input.$time) {
      assert.equal(versionNs(observed?.timestampValue),versionNs(input.$time));
      return {timestampValue:observed.timestampValue};
    }
    return {mapValue:{fields:Object.fromEntries(Object.entries(input).map(([k,v])=>
      [k,wire(v,observed?.mapValue?.fields?.[k],lo,hi)]))}};
  }
  if (typeof input === 'string') return {stringValue:input};
  if (typeof input === 'boolean') return {booleanValue:input};
  assert.ok(Number.isSafeInteger(input));
  return {integerValue:String(input)};
}
function checkWrite(before,after,data,op) {
  if (op === 'delete') {
    assert.equal(after.document,null);
    return;
  }
  const doc = after.document, prior = before.document;
  assert.ok(doc);
  if (op === 'update') assert.ok(prior);
  const lo = versionNs(before.readTime), hi = versionNs(doc.updateTime);
  const expected = op === 'update' ? {...prior.fields} : {};
  for (const [key,value] of Object.entries(data)) {
    expected[key] = wire(value,doc.fields[key],lo,hi);
  }
  assert.deepEqual(doc.fields,expected);
  if (!prior) assert.equal(doc.createTime,doc.updateTime);
  else {
    assert.equal(doc.createTime,prior.createTime);
    assert.ok(isDeepStrictEqual(prior.fields,doc.fields) ? hi >= versionNs(prior.updateTime) : hi > versionNs(prior.updateTime));
  }
}
function sdkData(document) {
  function sdk(value) {
    if (value?.$time) {
      const ns = versionNs(value.$time);
      return {type:'firestore/timestamp/1.0',seconds:Number(ns/1000000000n),nanoseconds:Number(ns%1000000000n)};
    }
    if (Array.isArray(value)) return value.map(sdk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sdk(v)]));
    return value;
  }
  return sdk(fields(document));
}
function checkResponse(response) {
  assert.ok(['ALLOW','DENY'].includes(response.verdict));
  assert.equal(response.code,response.verdict === 'ALLOW' ? 'ok' : 'permission-denied');
  assert.equal(Object.hasOwn(response,'value'),response.verdict === 'ALLOW');
}
function checkQuery(step,row) {
  const documents = step.watch.filter(path=>path.slice(0,path.lastIndexOf('/')) === step.path && row.before[path].document &&
    (step.filters ?? []).every(filter=>matchesFilter(fields(row.before[path].document),filter))).map(path=>({
      id:path.split('/').at(-1),path,data:sdkData(row.before[path].document)
    })).sort((a,b)=>a.path.localeCompare(b.path));
  assert.deepEqual(row.response.value,documents);
  return {verdict:'ALLOW',matches:documents.map(doc=>step.watch.indexOf(doc.path)).sort((a,b)=>a-b)};
}

let lastTime = versionNs(beforeProof.verifiedAt);
const results = {};
for (const step of steps) {
  const row = record.rows[step.id];
  assert.deepEqual(row.step,step);
  const started = versionNs(row.started), finished = versionNs(row.finished);
  assert.ok(lastTime <= started && started <= finished);
  lastTime = finished;
  for (const snap of [row.before,row.after]) {
    keys(snap,step.watch);
    for (const path of step.watch) checkSnapshot(snap[path],path);
  }
  let decision, applied;
  if (step.op === 'race') {
    assert.equal(row.response,undefined);
    keys(row.race,step.actors);
    const contenders = step.actors.map(actor=>row.race[actor]);
    for (const res of contenders) {
      checkResponse(res);
      assert.ok(started <= versionNs(res.submitted) && versionNs(res.submitted) <= versionNs(res.finished) && versionNs(res.finished) <= finished);
      if (res.verdict === 'ALLOW') assert.equal(res.value,null);
    }
    assert.ok(contenders.every(a=>contenders.every(b=>versionNs(a.submitted) <= versionNs(b.finished))),'race requests did not overlap');
    const owner = row.after[step.path].document?.fields.usedBy?.stringValue;
    const granted = step.actors.filter(role=>row.race[role].verdict === 'ALLOW');
    if (granted.length) {
      const writer = granted.find(role=>uids[role] === owner);
      assert.ok(writer,'stored claimant must have completed an allowed update');
      applied = step.dataByActor[writer];
    }
    decision = raceResult(Object.fromEntries(step.actors.map(role=>[role,row.race[role].verdict])),step.actors,owner,uids);
  } else {
    assert.equal(row.race,undefined);
    checkResponse(row.response);
    decision = row.response.verdict;
    if (decision === 'ALLOW') {
      if (step.op === 'query') decision = checkQuery(step,row);
      else if (step.op === 'get') assert.deepEqual(row.response.value,sdkData(row.before[step.path].document));
      else {
        assert.equal(row.response.value,null);
        applied = step.data ?? {};
      }
    }
  }
  for (const path of step.watch) {
    const before = row.before[path], after = row.after[path], previous = known.get(path);
    assert.deepEqual(before.document,previous.document);
    assert.ok(versionNs(previous.readTime) <= versionNs(before.readTime));
    assert.ok(versionNs(before.readTime) <= versionNs(after.readTime));
    if (path === step.path && applied) checkWrite(before,after,applied,step.op === 'race' ? 'update' : step.op);
    else assert.deepEqual(after.document,before.document);
    known.set(path,after);
  }
  assert.deepEqual(row.decision,decision);
  results[step.id] = decision;
}
assert.ok(lastTime <= versionNs(afterProof.verifiedAt));
assert.ok(versionNs(afterProof.verifiedAt) <= versionNs(restored.proof.verifiedAt));
console.log(JSON.stringify(results));
