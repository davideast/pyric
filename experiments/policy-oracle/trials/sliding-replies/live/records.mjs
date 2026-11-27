import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {manifest,sha} from '../../../arcade/corpus.mjs';
import {qualify,checkRows} from '../../for-of/live/evidence.mjs';
import {privateArchive} from '../../../arcade/live/controller/archive.mjs';
import {reviewedPlan} from '../../chess-safety/live/fixtures.mjs';
import {diagnostics} from './diagnostic.mjs';
import {uploadObservation} from './upload.mjs';
import {previousDigest,previousPlans,roles,readJSON,inputs,versionDirectory,
  buildPlan,verifySource,chunkFixtures,signedOperands} from './fixtures.mjs';

export function verifiedPlan(digest) {
  const dir=versionDirectory(digest);
  const bundle=new URL('firestore.rules',dir),plan=readJSON(new URL('plan.json',dir));
  const data=inputs(plan.version>=2,plan.version===3);
  assert.deepEqual(plan,buildPlan(data,digest),'capture plan or frozen operands changed');
  verifySource(readFileSync(bundle,'utf8'),digest);
  return {dir,bundle,plan,data};
}

export function writeOnce(file,bytes) {
  try {writeFileSync(file,bytes,{flag:'wx'});}
  catch(e) {
    if(e.code!=='EEXIST') throw e;
    assert.deepEqual(readFileSync(file),Buffer.from(bytes),'immutable release file changed');
  }
}

function verifyCapture(digest,name,folder,bundle,fixtures,data,archive) {
  const bytes=readFileSync(new URL(name+'.json.gz',folder));
  const pin=readJSON(new URL(name+'.pin.json',folder));
  assert.equal(sha(bytes),pin.receiptGzipSha256);
  const ev=JSON.parse(gunzipSync(bytes));
  assert.equal(ev.privateReceipt,pin.controllerSha256);
  assert.match(ev.privateReceipt,/^[a-f0-9]{64}$/);assert.match(ev.journalSha256,/^[a-f0-9]{64}$/);
  assert.equal(ev.mode,name);assert.equal(ev.rulesSha256,digest);
  assert.equal(ev.targetDatabaseUid,manifest.target.uid);assert.equal(ev.restored,manifest.target.closedRuleset);
  const closed=manifest.files['v1/rules/closed.rules'];
  assert.deepEqual(ev.phases.map(p=>[p.phase,p.rulesSha256]),[
    ['initially-closed',closed],['open',digest],['restored-closed',closed]]);
  assert.equal(ev.closure.version,ev.phases[2].releaseUpdateTime);
  assert.deepEqual([ev.closure.leaseReleased,ev.closure.signedRead,ev.closure.signedWrite,ev.signedOutRead],
    [true,'DENY','DENY','DENY']);
  if(archive) assert.deepEqual(ev,qualify(privateArchive(archive),ev.privateReceipt,bundle,fixtures));
  checkRows(ev.rows,roles,id=>'chess/match-'+id,name,fixtures);
  const rows=ev.rows.map(row=>{
    if(data.prior.has(row.id)) assert.deepEqual(signedOperands(row),data.prior.get(row.id),'changed prior signed input '+row.id);
    const versionBefore=row.before[0].version,versionAfter=row.after[0].version;
    assert.equal(versionBefore!==versionAfter,row.observed==='ALLOW');
    return {id:row.id,batch:data.all.get(row.id).batch,verdict:row.observed,versionBefore,versionAfter,
      versionChanged:versionAfter!==versionBefore};
  });
  return {meta:{name,receipt:ev.privateReceipt,journalSha256:ev.journalSha256,rows:rows.length,
    release:ev.release,restored:ev.restored,phases:ev.phases,closure:ev.closure},rows};
}

export function lookup(digest,archive) {
  const dir=versionDirectory(digest),captures=[],distinct=new Map();
  const stored=existsSync(new URL('plan.json',dir))?verifiedPlan(digest):null;
  const data=stored?.data??inputs(digest!==previousDigest,digest!==previousDigest);
  function add(entry) {
    captures.push(entry.meta);
    for(const row of entry.rows) {
      if(distinct.has(row.id)) assert.equal(row.verdict,distinct.get(row.id).verdict);
      else distinct.set(row.id,row);
    }
  }
  if(stored) {
    const {plan,bundle}=stored;
    for(const chunk of plan.chunks) {
      const name=chunk.name,folder=new URL('receipts/',dir);
      if(existsSync(new URL(name+'.pin.json',folder))) {
        add(verifyCapture(digest,name,folder,bundle,chunkFixtures(data,plan,name),data,archive));
      }
    }
  }
  if(digest===previousDigest) {
    for(const name of previousPlans) {
      const old=reviewedPlan(name);
      add(verifyCapture(digest,name,old.receipts,old.bundle,old.fixtures,data,archive));
    }
  }
  const rows=[...distinct.values()],distinctCases=rows.length,expectedCases=data.order.length;
  if(distinctCases===expectedCases) assert.deepEqual([...rows.map(r=>r.id)].sort(),[...data.order].sort());
  return {rulesSha256:digest,status:distinctCases===expectedCases?'measured':distinctCases?'partial':'unmeasured',
    expectedCases,distinctCases,archiveAuthenticated:Boolean(archive),compileDiagnostics:diagnostics(digest,archive),
    rulesetCreation:uploadObservation(digest,archive),captures,rows};
}
