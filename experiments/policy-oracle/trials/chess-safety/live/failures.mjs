import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {manifest,sha} from '../../../arcade/corpus.mjs';
import {privateArchive} from '../../../arcade/live/controller/archive.mjs';
import {file as immutableFile,retained} from '../../chess/verify/journal.mjs';

const directory=new URL('failures/',import.meta.url);

function inspect(archive,runId,intendedRulesSha256) {
  const path=join(privateArchive(archive),runId);
  const files=readdirSync(path).filter(f=>/^\d+-.*\.json$/.test(f)).sort();
  const raw=files.map(f=>immutableFile(join(path,f))),events=raw.map(x=>JSON.parse(x));
  const matching=k=>events.filter(e=>e.kind===k).map(e=>e.data);
  function only(k) {const m=matching(k);assert.equal(m.length,1,k);return m[0];}
  assert.equal(events[0].kind,'acquired');
  assert.equal(events.at(-1).kind,'failure');
  const lock=only('acquired'), closed=only('closed'), fail=only('failure');
  assert.equal(closed.lockRunId,runId);
  assert.equal(closed.databaseUid,manifest.target.uid);
  assert.equal(closed.rulesetName,manifest.target.closedRuleset);
  assert.equal(closed.rulesSha256,manifest.files['v1/rules/closed.rules']);
  assert.equal(closed.lockVersion,lock.lockVersion);
  assert.deepEqual(only('released'),{runId,version:lock.lockVersion});
  assert.equal(matching('chess-attempt').length,0);
  const steps=matching('propagation-confirmed');
  assert.equal(steps[0].phase,'initially-closed');
  const activation=matching('activate');
  if(activation.length) {
    assert.equal(activation.length,1);
    assert.equal(activation[0].digest,intendedRulesSha256);
    assert.equal(steps.at(-1).phase,'restored-closed');
  }
  for(const step of steps.filter(s=>s.phase!=='open')) {
    assert.equal(step.proof.rulesSha256,closed.rulesSha256);
    assert.equal(step.proof.lockRunId,runId);
    const control=retained(archive,step.digest);
    assert.deepEqual(control.proof,step.proof);assert.equal(control.phase,step.phase);
    assert.deepEqual(control.controls.slice(-2).map(c=>[c.beforeRead,c.write,c.afterRead]),
      [['DENY','DENY','DENY'],['DENY','DENY','DENY']]);
  }
  assert.ok([429,503].includes(fail.status));
  const operation=fail.path.endsWith('/rulesets')?'create-ruleset':'activate-release';
  assert.equal(fail.method,operation==='create-ruleset'?'POST':'PATCH');
  return {intendedRulesSha256,journalBoundRulesSha256:activation[0]?.digest??null,
    journalSha256:sha(Buffer.concat(raw)),failureTime:events.at(-1).at,
    operation,httpStatus:fail.status,serviceCode:fail.serviceCode,caseWrites:0,
    originalClosed:true,leaseReleased:true,signedPhases:steps.map(s=>s.phase)};
}

export function record(archive,runId,plan,digest) {
  const summary={plan,...inspect(archive,runId,digest)};
  mkdirSync(directory,{recursive:true});
  const path=new URL(summary.journalSha256+'.json',directory);
  const bytes=JSON.stringify(summary,null,2)+'\n';
  if(existsSync(path)) assert.equal(readFileSync(path,'utf8'),bytes);
  else writeFileSync(path,bytes,{flag:'wx'});
  return summary;
}

export function failureObservations(archive) {
  if(!existsSync(directory)) return [];
  return readdirSync(directory).filter(f=>/^[0-9a-f]{64}\.json$/.test(f)).sort().map(f=>{
    const entry=JSON.parse(readFileSync(new URL(f,directory)));
    assert.equal(entry.journalSha256+'.json',f);
    if(archive) {
      const runs=readdirSync(privateArchive(archive),{withFileTypes:true}).filter(e=>e.isDirectory());
      let matches=0;
      for(const run of runs) {
        const dir=join(archive,run.name),files=readdirSync(dir).filter(s=>s.endsWith('-failure.json'));
        if(files.length!==1 || JSON.parse(readFileSync(join(dir,files[0]))).at!==entry.failureTime) continue;
        assert.deepEqual({plan:entry.plan,...inspect(archive,run.name,entry.intendedRulesSha256)},entry);matches++;
      }
      assert.equal(matches,1,'private failed journal is absent or ambiguous');
    }
    return entry;
  });
}
