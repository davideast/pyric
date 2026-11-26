import assert from 'node:assert/strict';
import {spawnSync,execFileSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {manifest} from '../../../arcade/corpus.mjs';
import {privateArchive} from '../../../arcade/live/controller/archive.mjs';
import {read as immutableJson} from '../../chess/verify/journal.mjs';
import {record} from './failures.mjs';
import {reviewedPlan} from './fixtures.mjs';

const cli=fileURLToPath(new URL('run.mjs',import.meta.url));

// A lost response can follow a successful release activation. Only retry a
// signed-write-free run whose journal proves the exclusive lease was restored.
export function retryable(archive,runId) {
  assert.match(runId,/^[0-9a-f-]{36}$/);
  const directory=join(privateArchive(archive),runId);
  const events=readdirSync(directory).filter(f=>/^\d+-.*\.json$/.test(f)).sort()
    .map(f=>immutableJson(join(directory,f)));
  const one=kind=>events.filter(e=>e.kind===kind);
  const failures=one('failure'), closed=one('closed'), released=one('released'), locks=one('acquired');
  if(failures.length!==1 || closed.length!==1 || released.length!==1 || locks.length!==1 || one('chess-attempt').length) return false;
  const failure=failures[0].data;
  if(![429,503].includes(failure.status) || !['POST','PATCH'].includes(failure.method)
      || !/^\/v1\/projects\/[^/]+\/(rulesets$|releases\/cloud\.firestore\/)/.test(failure.path)) return false;
  const lock=locks[0].data, final=closed[0].data;
  assert.equal(final.databaseUid,manifest.target.uid);
  assert.equal(final.rulesetName,manifest.target.closedRuleset);
  assert.equal(final.rulesSha256,manifest.files['v1/rules/closed.rules']);
  assert.equal(final.lockVersion,lock.lockVersion);
  assert.equal(final.lockRunId,runId);
  assert.deepEqual(released[0].data,{runId,version:lock.lockVersion});
  const phases=one('propagation-confirmed').map(p=>p.data.phase);
  assert.ok(phases.includes('initially-closed'));
  if(one('activate').length) assert.ok(phases.includes('restored-closed'));
  return true;
}

export async function measure(name,archive,options=[]) {
  let captureOptions=options;
  for(let attempt=1;attempt<=3;attempt++) {
    const child=spawnSync(process.execPath,[cli,'capture',name,archive,...captureOptions],{
      encoding:'utf8',stdio:['ignore','pipe','inherit'],maxBuffer:2*1024*1024,
    });
    if(child.error) throw child.error;
    process.stdout.write(child.stdout);
    const lines=child.stdout.split('\n');
    if(child.status!==0) {
      const started=lines.find(l=>l.startsWith('Private run '));
      const id=started?.split(' ')[2];
      if(!id || !retryable(archive,id)) throw Error('Capture incomplete; no observations admitted');
      const observation=record(archive,id,name,reviewedPlan(name).plan.rulesSha256);
      // A failed activation can leave a correct, immutable Google Ruleset
      // behind. Its original journal is independently checked on the retry.
      if(!captureOptions.length && observation.journalBoundRulesSha256)
        captureOptions=['--reuse-run',id];
      if(attempt===3) throw Error('Three management failures; no observations admitted');
      console.log('Retrying temporary management failure after verified closure and zero scored writes',attempt);
      await delay(30000*attempt);
      continue;
    }
    const qualified=lines.filter(line=>line.startsWith('Qualified '));
    assert.equal(qualified.length,1,'a complete capture must produce one receipt');
    const [,mode,digest]=qualified[0].split(' ');
    assert.equal(mode,name);assert.match(digest,/^[0-9a-f]{64}$/);
    execFileSync(process.execPath,[cli,'retain',name,archive,digest],{stdio:'inherit'});
    return;
  }
}

// Source names come from the original capture's immutable, released lease.
export function previouslyUploaded(archive,runId,digest) {
  assert.match(runId,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  const directory=join(privateArchive(archive),runId);
  function one(kind) {
    const files=readdirSync(directory).filter(f=>f.endsWith('-'+kind+'.json'));
    assert.equal(files.length,1,kind);
    return immutableJson(join(directory,files[0])).data;
  }
  const activated=one('activate'),closed=one('closed'),acquired=one('acquired');
  assert.equal(activated.digest,digest);
  assert.equal(activated.previous,manifest.target.closedRuleset);
  assert.equal(closed.databaseUid,manifest.target.uid);
  assert.equal(closed.rulesetName,manifest.target.closedRuleset);
  assert.equal(closed.rulesSha256,manifest.files['v1/rules/closed.rules']);
  assert.equal(closed.lockRunId,runId);
  assert.equal(closed.lockVersion,acquired.lockVersion);
  assert.deepEqual(one('released'),{runId,version:acquired.lockVersion});
  return activated.candidate;
}
