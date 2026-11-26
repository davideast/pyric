import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {traces,sourceKind,steps,corpusSha,canonical,digest} from './fixtures.mjs';

export function freeze() {
  const signatures=[],records={};
  const groups={},kinds={},controlKinds={},terminal={},sources={};
  let writes=0,controls=0;
  for(const trace of traces) {
    const source=sourceKind(trace);
    sources[source]=(sources[source]??0)+1;
    const heads=createHash('sha256'),requests=createHash('sha256');
    let actions=0,probes=0,moves=0,final;
    for(const step of steps(trace)) {
      final=step.after;
      heads.update(canonical([step.kind,step.ply,step.actor??null,step.after])+'\n');
      if(step.kind==='seed')continue;
      if(step.kind==='move')moves++;
      actions++;
      kinds[step.kind]=(kinds[step.kind]??0)+1;
      const old=digest(step.before),plan=[[step.kind,step.actor,step.submitted,true],
        ...step.probes.map(p=>[p.kind,p.actor,p.data,false])];
      for(const [kind,actor,data,truthed] of plan) {
        requests.update(canonical([step.ply,step.method,old,kind,actor,digest(data),truthed])+'\n');
        if(!truthed){probes++;controlKinds[kind]=(controlKinds[kind]??0)+1;}
      }
    }
    assert.equal(moves,trace.rows.length-1);
    const receipt={source,moves,positiveWrites:actions,invalidProposals:probes,
      terminal:final.status,headSha256:digest(final),headsSha256:heads.digest('hex'),requestsSha256:requests.digest('hex')};
    records[trace.name]=receipt;
    signatures.push([trace.name,receipt.headsSha256,receipt.requestsSha256]);
    const g=groups[source]??={moves:0,signed:0,invalid:0};
    g.moves+=moves;g.signed+=actions;g.invalid+=probes;
    terminal[final.status]=(terminal[final.status]??0)+1;
    writes+=actions;controls+=probes;
  }
  return {archiveSha256:corpusSha,sha256:digest(signatures),traces:traces.length,sources,groups,
    positiveWrites:writes,invalidProposals:controls,kinds,controlKinds,terminal,records};
}
if(import.meta.main){
  const summary=freeze(),url=new URL('freeze.json',import.meta.url);
  if(process.argv[2]==='--freeze')writeFileSync(url,JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
  else assert.deepEqual(summary,JSON.parse(readFileSync(url)));
  console.log(JSON.stringify(summary,null,2));
}
