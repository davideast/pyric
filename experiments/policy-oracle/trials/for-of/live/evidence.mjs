import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {retained,journal} from '../../chess/verify/journal.mjs';
import {transition} from '../../chess/verify/document.mjs';
import {profile,checkBundle} from './fixtures.mjs';

export function checkRows(rows,ids,pathFor,mode) {
  const spec = profile(mode), cases=spec.cases;
  assert.deepEqual(rows.map(r=>r.id),cases.map(c=>c.id));
  for(const [i,c] of cases.entries()) {
    const row = rows[i], path = pathFor(c.id);
    const fixture = spec.sample(c,ids.host,ids.guest);
    assert.equal(row.observed,c.expected,c.id);
    assert.equal(row.actor,ids.host);
    assert.equal(row.reader,ids.observer);
    assert.deepEqual(row.probe,spec.probe(c));
    assert.deepEqual(row.before.map(s=>s.path),[path],c.id);
    assert.deepEqual(row.after.map(s=>s.path),[path],c.id);
    assert.deepEqual(row.before[0].data,fixture.before,c.id+' full before');
    assert.deepEqual(row.submitted,[{op:'update',path,data:fixture.proposal}],c.id+' complete submitted update');
    transition(row.before[0],row.after[0],fixture.after,c.id);
  }
}

// Retain complete documents, proposed SDK data, server creation and update times.
// Replace run-scoped document paths and anonymous identity values in the public
// replay; the private controller archive is the authority for admitting a run.
export function qualify(archive,digest,bundle) {
  const raw=retained(archive,digest);
  checkBundle(raw.mode,readFileSync(bundle,'utf8'),raw.rulesSha256);
  const j=journal(archive,raw,digest);
  const ids=j.actors, prefix=profile(raw.mode).collection+'/', match=prefix+raw.runId;
  checkRows(raw.rows,ids,id=>match+'-'+id,raw.mode);
  const map = new Map(Object.entries(ids).map(([role,uid])=>[uid,role]));
  const redact = x => {
    if(typeof x === 'string') return map.get(x) ?? x.replace(match,prefix+'match');
    if(Array.isArray(x)) return x.map(redact);
    if(x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,redact(v)]));
    return x;
  };
  const rows = raw.rows.map(({proof,end,expected,...row})=>{
    j.proof(proof); j.proof(end);
    assert.ok(Date.parse(end.verifiedAt) >= Date.parse(proof.verifiedAt));
    assert.equal(row.observed,expected);
    return redact(row);
  });
  const phases=j.all('propagation-confirmed').map(p=>({
    phase:p.phase,receipt:p.digest,rulesSha256:p.proof.rulesSha256,
    releaseUpdateTime:p.proof.releaseUpdateTime,verifiedAt:p.proof.verifiedAt,
  }));
  const closed = j.only('closed');
  const evidence = {mode:raw.mode,rulesSha256:raw.rulesSha256,privateReceipt:digest,journalSha256:j.journalSha256,
    targetDatabaseUid:raw.target.uid,release:j.release,restored:j.restored,phases,closure:{
      version:closed.releaseUpdateTime,verifiedAt:closed.verifiedAt,leaseReleased:true,
      signedRead: 'DENY',signedWrite:'DENY',
    },signedOutRead:'DENY',rows};
  const removed = JSON.stringify(evidence);
  for(const uid of map.keys()) assert.equal(removed.includes(uid),false);
  assert.equal(removed.includes(raw.runId),false);
  return evidence;
}

export function comparable(evidence) {
  const withoutVersion = snapshots => snapshots.map(({path,data})=>({path,data}));
  return evidence.rows.map(({before,after,...row})=>({
    ...row,before:withoutVersion(before),after:withoutVersion(after),
  }));
}
