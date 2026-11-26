import assert from 'node:assert/strict';
import {existsSync,readdirSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {manifest} from '../../../arcade/corpus.mjs';
import {journal,retained} from '../../chess/verify/journal.mjs';
import {checkRows} from '../../for-of/live/evidence.mjs';
import {reviewedPlan} from './fixtures.mjs';
import {inspectRecovered} from './recovery-exclusion.mjs';

const directory=new URL('unqualified/',import.meta.url);

function inspect(archive,name,digest) {
  const raw=retained(archive,digest), {plan,bundle,fixtures}=reviewedPlan(name);
  assert.equal(raw.mode,name);assert.equal(raw.rulesSha256,plan.rulesSha256);
  fixtures.checkBundle(name,readFileSync(bundle,'utf8'),raw.rulesSha256);
  const j=journal(archive,raw,digest);
  checkRows(raw.rows,j.actors,id=>'chess/'+raw.runId+'-'+id,name,fixtures);
  const reversed=[];
  for(const row of raw.rows) {
    j.proof(row.proof);j.proof(row.end);
    if(Date.parse(row.end.verifiedAt)<Date.parse(row.proof.verifiedAt)) {
      reversed.push({id:row.id,localStart:row.proof.verifiedAt,localEnd:row.end.verifiedAt});
    }
  }
  assert.ok(reversed.length,'expected a reversed local proof pair');
  return {plan:name,rulesSha256:raw.rulesSha256,controllerSha256:digest,journalSha256:j.journalSha256,
    disposition:'unqualified',reason:'local-end-precedes-start',attempted:raw.rows.length,scored:0,reversed,
    targetDatabaseUid:manifest.target.uid,restored:j.restored,leaseReleased:true};
}

export function recordUnqualified(archive,name,digest) {
  const value=inspect(archive,name,digest), bytes=JSON.stringify(value,null,2)+'\n';
  mkdirSync(directory,{recursive:true}); const url=new URL(digest+'.json',directory);
  if(existsSync(url))assert.equal(readFileSync(url,'utf8'),bytes);
  else writeFileSync(url,bytes,{flag:'wx'});
}

export function unqualified(archive) {
  if(!existsSync(directory))return [];
  return readdirSync(directory).sort().map(file=>{
    assert.match(file,/^[a-f0-9]{64}\.json$/);
    const value=JSON.parse(readFileSync(new URL(file,directory)));
    assert.equal(value.controllerSha256+'.json',file);assert.equal(value.scored,0);
    assert.equal(value.restored,manifest.target.closedRuleset);assert.equal(value.leaseReleased,true);
    if(archive) {
      const checked=value.reason==='management-401-during-restore' ? inspectRecovered(archive,value.controllerSha256) : inspect(archive,value.plan,value.controllerSha256);
      assert.deepEqual(value,checked);
    }
    return value;
  });
}
