import assert from 'node:assert/strict';
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {manifest,sha} from '../../../arcade/corpus.mjs';

export function file(path) {
  const stat=lstatSync(path);
  assert.ok(stat.isFile() && !(stat.mode & 0o222), 'expected immutable controller file ' + path);
  return readFileSync(path);
}
export const read = path => JSON.parse(file(path));
export function retained(archive,digest) {
  assert.match(digest,/^[0-9a-f]{64}$/);
  const bytes=file(join(archive,digest+'.json'));
  assert.equal(sha(bytes),digest);
  return JSON.parse(bytes);
}
export function journal(archive,receipt,digest) {
  const {runId,mode,rulesSha256}=receipt;
  assert.match(runId,/^[a-f0-9-]{36}$/);
  const dir=join(archive,runId), files=readdirSync(dir).filter(f=>/^\d+-/.test(f)).sort();
  const events=files.map((f,i)=>{
    const v=read(join(dir,f));
    assert.equal(f,String(i+1).padStart(5,'0')+'-'+v.kind+'.json');
    assert.ok(Number.isFinite(Date.parse(v.at)));
    return v;
  });
  const all=k=>events.filter(x=>x.kind===k).map(x=>x.data);
  const only=k=>{const group=all(k);assert.equal(group.length,1,k);return group[0];};
  assert.deepEqual(read(join(dir,'completed.json')),{mode,runId,rulesSha256,receipt:digest});
  assert.deepEqual(receipt.target,manifest.target);
  const ids=all('identity'); assert.deepEqual(ids.map(x=>x.role),['host','guest','observer']);
  for (const i of ids) {
    assert.ok(i.uid.length);assert.equal(i.provider,'anonymous');assert.equal(i.audience,manifest.target.project);
    assert.equal(i.issuer,'https://securetoken.google.com/'+manifest.target.project);
  }
  const actors=Object.fromEntries(ids.map(i=>[i.role,i.uid]));
  assert.equal(new Set(Object.values(actors)).size,3);
  const phases=all('propagation-confirmed'), opened=phases[1], lock=only('acquired'), closed=only('closed');
  assert.deepEqual(phases.map(p=>p.phase),['initially-closed','open','restored-closed']);
  assert.deepEqual(only('activate'),{candidate:opened.proof.rulesetName,digest:rulesSha256,previous:manifest.target.closedRuleset});
  assert.equal(lock.releaseName,'projects/'+manifest.target.project+'/releases/cloud.firestore/'+manifest.target.database);
  assert.equal(closed.releaseName,lock.releaseName);
  assert.equal(closed.lockVersion,lock.lockVersion);
  assert.equal(closed.lockRunId,runId);
  const lastOpen=events.findLastIndex(e=>['chess-attempt','browser-state','referee'].includes(e.kind));
  const activated=events.findIndex(e=>e.kind==='propagation-confirmed' && e.data.phase==='open');
  const closedPhase=events.findIndex(e=>e.kind==='propagation-confirmed' && e.data.phase==='restored-closed');
  assert.ok(activated < events.findIndex(e=>e.kind==='chess-attempt') && lastOpen < closedPhase);
  assert.equal(events[0].kind,'acquired'); assert.equal(events.at(-1).kind,'released');
  assert.deepEqual(only('released'),{runId,version:lock.lockVersion});
  assert.equal(lock.rulesetName,manifest.target.closedRuleset); assert.equal(closed.rulesetName,manifest.target.closedRuleset);
  assert.equal(closed.rulesSha256,lock.rulesSha256);
  for (const phase of phases) {
    const {proof:p}=phase, body=retained(archive,phase.digest);
    assert.deepEqual(body.proof,p); assert.equal(body.phase,phase.phase);
    assert.deepEqual(body.identities,{host:actors.host,guest:actors.observer});
    assert.equal(p.databaseUid,manifest.target.uid); assert.equal(p.releaseName,lock.releaseName);
    assert.equal(p.lockRunId,runId); assert.equal(p.lockVersion,lock.lockVersion);
    const open=phase.phase==='open';
    assert.equal(p.rulesSha256,open ? rulesSha256 : lock.rulesSha256);
    assert.equal(p.rulesetName,open ? opened.proof.rulesetName : manifest.target.closedRuleset);
    assert.deepEqual(all('propagation-control').filter(c=>c.phase===phase.phase).map(({phase,...c})=>c),body.controls);
    const decisive=body.controls.slice(open?-4:-2);
    assert.deepEqual(decisive.map(c=>[c.count,c.beforeRead,c.write,c.afterRead]),open ?
      [[1,'ALLOW','ALLOW','ALLOW'],[2,'ALLOW','DENY','ALLOW'],[1,'ALLOW','ALLOW','ALLOW'],[2,'ALLOW','DENY','ALLOW']] :
      [[1,'DENY','DENY','DENY'],[1,'DENY','DENY','DENY']]);
  }
  const proof=p=>{
    const {verifiedAt,...fields}=p;
    const {verifiedAt:openedAt,...release}=opened.proof;
    assert.deepEqual(fields,{...release,propagationReceiptSha256:opened.digest});
    assert.ok(Date.parse(verifiedAt)>=Date.parse(openedAt) && Date.parse(verifiedAt)<=Date.parse(closed.verifiedAt));
  };
  assert.deepEqual(only('unauthenticated-read'),{path:'chess/'+runId,observed:'DENY'});
  assert.deepEqual(all('chess-attempt'),receipt.rows);
  return {dir,all,only,actors,proof,release:opened.proof.rulesetName,
    restored:closed.rulesetName,journalSha256:sha(Buffer.concat(files.map(f=>file(join(dir,f)))))};
}
