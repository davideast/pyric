// Capture a new cohort on the preceding immutable release without editing its plan.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {sha} from '../../../arcade/corpus.mjs';
import {withPreparedRuleset} from '../../../arcade/live/controller/release.mjs';
import {withMonotonicEvidenceClock} from '../../../arcade/live/controller/archive.mjs';
import {sample} from '../../chess-safety/reference/fixtures.mjs';
import {capture} from '../../for-of/live/capture.mjs';
import {retain} from '../../for-of/live/retain.mjs';
import {versionDirectory,chunkFixtures,readJSON,verifySource} from './fixtures.mjs';
import {inspectTarget} from './preflight.mjs';
import {writeOnce} from './records.mjs';
import {uploadObservation} from './upload.mjs';

export async function baseline(digest, name, [action,archive,receipt]) {
  const bundle=fileURLToPath(new URL('firestore.rules',versionDirectory(digest)));
  verifySource(readFileSync(bundle,'utf8'),digest);
  const cases=readJSON(new URL('../native/'+name+'/positions.json',import.meta.url));
  const all=new Map(cases.map(c=>[c.id,{c,spec:{sample,probe:({id,...fields})=>fields}}]));
  const fixtures=chunkFixtures({all},{rulesSha256:digest,chunks:[{name,ids:[...all.keys()]}]},name);
  if(action==='retain') {
    const folder=new URL('../supplemental/'+name+'/',import.meta.url);
    retain([archive,receipt,bundle],fixtures,folder);
    const receiptGzipSha256=sha(readFileSync(new URL(name+'.json.gz',folder)));
    writeOnce(new URL(name+'.pin.json',folder),JSON.stringify({controllerSha256:receipt,receiptGzipSha256},null,2)+'\n');
  } else {
    assert.equal(action,'capture');
    const target=await inspectTarget();
    const upload=uploadObservation(digest,archive);
    assert.equal(upload.state,'compiled');
    const stop=setTimeout(()=>process.emit('SIGTERM'),Date.parse(target.managementCredentialExpires)-Date.now()-720000);
    try {
      await withPreparedRuleset(upload.ruleset,()=>withMonotonicEvidenceClock(()=>capture([name,archive,bundle,digest],fixtures)));
    } finally {clearTimeout(stop);}
  }
}
