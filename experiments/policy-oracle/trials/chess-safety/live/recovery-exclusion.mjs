import assert from 'node:assert/strict';
import {existsSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {manifest,sha,versionNs} from '../../../arcade/corpus.mjs';
import {checkWire} from '../../../adapters/arcade-sdk/v1/evidence.mjs';
import {immutable} from '../../../arcade/live/controller/archive.mjs';
import {file as immutableFile,read,retained} from '../../chess/verify/journal.mjs';
import {checkRows} from '../../for-of/live/evidence.mjs';
import {reviewedPlan} from './fixtures.mjs';

function transcript(archive,id) {
  assert.match(id,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  const dir=join(archive,id);
  const names=readdirSync(dir).filter(f=>/^\d+-.*\.json$/.test(f)).sort();
  const files=names.map(f=>immutableFile(join(dir,f)));
  const events=files.map((bytes,i)=>{
    const event=JSON.parse(bytes);assert.equal(names[i],String(i+1).padStart(5,'0')+'-'+event.kind+'.json');
    assert.ok(Number.isFinite(Date.parse(event.at)));return event;
  });
  const matching=kind=>events.filter(e=>e.kind===kind).map(e=>e.data);
  function only(kind){const matches=matching(kind);assert.equal(matches.length,1,kind);return matches[0];}
  return {dir,events,matching,only,sha256:sha(Buffer.concat(files))};
}

function identities(log,roles) {
  const entries=log.matching('identity');assert.deepEqual(entries.map(e=>e.role),roles);
  const ids=Object.fromEntries(entries.map(e=>{
    assert.equal(e.provider,'anonymous');assert.equal(e.audience,manifest.target.project);
    assert.equal(e.issuer,'https://securetoken.google.com/'+manifest.target.project);return [e.role,e.uid];
  }));
  assert.equal(new Set(Object.values(ids)).size,roles.length);return ids;
}

function verifyControl(archive,log,phase,ids) {
  const matches=log.matching('propagation-confirmed').filter(c=>c.phase===phase);
  assert.equal(matches.length,1);const c=matches[0], raw=retained(archive,c.digest);
  assert.deepEqual(raw.proof,c.proof);assert.deepEqual(raw.identities,ids);assert.equal(raw.phase,phase);
  const records=log.matching('propagation-control').filter(r=>r.phase===phase).map(({phase,...r})=>r);
  assert.deepEqual(records,raw.controls);
  const open=phase==='open', decisive=records.slice(open?-4:-2);
  assert.deepEqual(decisive.map(r=>[r.count,r.beforeRead,r.write,r.afterRead]),open ?
    [[1,'ALLOW','ALLOW','ALLOW'],[2,'ALLOW','DENY','ALLOW'],[1,'ALLOW','ALLOW','ALLOW'],[2,'ALLOW','DENY','ALLOW']] :
    [[1,'DENY','DENY','DENY'],[1,'DENY','DENY','DENY']]);
  for(const r of decisive) {
    const before=checkWire(r.seed,r.path,r.before), after=checkWire(r.after,r.path,r.write==='ALLOW'?r.proposal:r.before);
    assert.ok(r.write==='ALLOW' ? after>before : after===before);
  }
  return {proof:c.proof,digest:c.digest,decisive};
}

export function inspectRecovered(archive,controllerSha256) {
  const ref=retained(archive,controllerSha256);
  assert.equal(ref.schema,'interrupted-capture-with-owned-recovery-v1');
  const log=transcript(archive,ref.capture), recovery=transcript(archive,ref.recovery);
  assert.equal(log.sha256,ref.captureJournalSha256);assert.equal(recovery.sha256,ref.recoveryJournalSha256);
  const {plan,bundle,fixtures}=reviewedPlan(ref.plan), digest=plan.rulesSha256;
  fixtures.checkBundle(ref.plan,readFileSync(bundle,'utf8'),digest);
  const lock=log.only('acquired'), activate=log.only('activate'), fail=log.only('failure');
  const release='projects/'+manifest.target.project+'/releases/cloud.firestore/'+manifest.target.database;
  const closed=manifest.target.closedRuleset, closedSha=manifest.files['v1/rules/closed.rules'];
  assert.equal(log.events[0].kind,'acquired');assert.equal(log.events.at(-1).kind,'failure');
  assert.ok(!existsSync(join(log.dir,'completed.json')));
  assert.equal(lock.databaseUid,manifest.target.uid);assert.equal(lock.releaseName,release);assert.equal(lock.lockRunId,ref.capture);
  assert.equal(lock.rulesetName,closed);assert.equal(lock.rulesSha256,closedSha);assert.equal(activate.previous,closed);
  assert.equal(activate.digest,digest);assert.notEqual(activate.candidate,closed);
  assert.deepEqual([fail.method,fail.path,fail.status,fail.serviceCode],['PATCH','/v1/'+release,401,'UNAUTHENTICATED']);
  assert.equal(log.matching('closed').length,0);assert.equal(log.matching('released').length,0);
  const actors=identities(log,['host','guest','observer']), controlIds={host:actors.host,guest:actors.observer};
  const initial=verifyControl(archive,log,'initially-closed',controlIds), opened=verifyControl(archive,log,'open',controlIds);
  assert.deepEqual(initial.proof,lock);assert.equal(opened.proof.releaseName,release);assert.equal(opened.proof.rulesSha256,digest);
  assert.equal(opened.proof.rulesetName,activate.candidate);assert.equal(opened.proof.lockVersion,lock.lockVersion);
  assert.equal(opened.proof.databaseUid,lock.databaseUid);assert.equal(opened.proof.lockRunId,lock.lockRunId);
  assert.ok(versionNs(opened.proof.releaseUpdateTime)>versionNs(lock.releaseUpdateTime));
  assert.deepEqual(log.matching('propagation-confirmed').map(p=>p.phase),['initially-closed','open']);
  assert.deepEqual(recovery.matching('propagation-confirmed').map(p=>p.phase),['restored-closed']);
  assert.deepEqual(log.only('unauthenticated-read'),{path:'chess/'+ref.capture,observed:'DENY'});
  const rows=log.matching('chess-attempt'),profile=fixtures.profile(ref.plan);assert.ok(rows.length>0 && rows.length<profile.cases.length);
  const prefix={...profile,cases:profile.cases.slice(0,rows.length)};
  checkRows(rows,actors,id=>'chess/'+ref.capture+'-'+id,ref.plan,{profile:()=>prefix});
  const {verifiedAt,...releaseProof}=opened.proof;
  for(const row of rows) {
    for(const p of [row.proof,row.end]) {
      const {verifiedAt:at,...values}=p;
      assert.deepEqual(values,{...releaseProof,propagationReceiptSha256:opened.digest});
      assert.ok(Date.parse(at)>=Date.parse(verifiedAt));
    }
    assert.ok(Date.parse(row.end.verifiedAt)>=Date.parse(row.proof.verifiedAt));
  }
  assert.equal(recovery.events[0].kind,'owned-recovery');assert.equal(recovery.events.at(-1).kind,'released');
  const owned=recovery.only('owned-recovery');assert.equal(owned.runId,ref.capture);assert.deepEqual(owned.old,lock);
  assert.deepEqual(owned.activation,activate);assert.equal(owned.current.name,release);
  assert.equal(owned.current.rulesetName,activate.candidate);assert.equal(owned.current.updateTime,opened.proof.releaseUpdateTime);
  const recoveredActors=identities(recovery,['recovery-writer','recovery-reader']);
  const restored=verifyControl(archive,recovery,'restored-closed',{host:recoveredActors['recovery-writer'],guest:recoveredActors['recovery-reader']});
  assert.deepEqual(restored.proof,{...lock,releaseUpdateTime:restored.proof.releaseUpdateTime});
  assert.ok(versionNs(restored.proof.releaseUpdateTime)>versionNs(owned.current.updateTime));
  assert.deepEqual(recovery.only('released'),{runId:ref.capture,version:lock.lockVersion});
  assert.deepEqual(read(join(recovery.dir,'completed.json')),{mode:'recovery',runId:ref.capture,restored:closed});
  return {plan:ref.plan,rulesSha256:digest,controllerSha256,journalSha256:log.sha256,recoveryJournalSha256:recovery.sha256,
    disposition:'unqualified',reason:'management-401-during-restore',intended:profile.cases.length,attempted:rows.length,
    attemptedCountBasis:'journaled full transitions; any additional in-flight write is unknown',scored:0,sourceWasActivated:true,
    targetDatabaseUid:manifest.target.uid,restored:closed,restoredRulesSha256:closedSha,
    initialReleaseVersion:lock.releaseUpdateTime,candidateReleaseVersion:owned.current.updateTime,
    restoredReleaseVersion:restored.proof.releaseUpdateTime,releasedLeaseVersion:lock.lockVersion,leaseReleased:true,
    restorationControl:restored.digest,closedRounds:restored.decisive.map(r=>({beforeRead:r.beforeRead,write:r.write,afterRead:r.afterRead,unchangedVersion:r.after.updateTime}))};
}

export function recordRecovered(archive,plan,capture,recovery) {
  const ref={schema:'interrupted-capture-with-owned-recovery-v1',plan,capture,recovery,
    captureJournalSha256:transcript(archive,capture).sha256,recoveryJournalSha256:transcript(archive,recovery).sha256};
  const bytes=Buffer.from(JSON.stringify(ref,null,2)+'\n'), digest=sha(bytes);
  immutable(join(archive,digest+'.json'),bytes,{identicalOk:true});
  const value=inspectRecovered(archive,digest),url=new URL('unqualified/'+digest+'.json',import.meta.url);
  const publicBytes=JSON.stringify(value,null,2)+'\n';
  if(existsSync(url))assert.equal(readFileSync(url,'utf8'),publicBytes);else writeFileSync(url,publicBytes,{flag:'wx'});
  return value;
}
