import assert from 'node:assert/strict';
import {readFileSync,readdirSync,realpathSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {privateArchive} from '../../../arcade/live/controller/archive.mjs';
import {sha,manifest} from '../../../arcade/corpus.mjs';
import {journal,retained} from './journal.mjs';
import {protocol} from './document.mjs';
import {specials} from './special.mjs';
import {browserProof} from './browser-proof.mjs';

const dir=dirname(fileURLToPath(import.meta.url));

function canonical(row,runId,actors) {
  const ids=new Map(Object.entries(actors).map(([role,uid])=>[uid,role]));
  function normalize(v) {
    if(typeof v==='string') return ids.get(v) || v.replaceAll(runId,'$MATCH');
    if(Array.isArray(v)) return v.map(normalize);
    if(v && typeof v==='object'){
      if(v.type==='firestore/timestamp/1.0') return '$TIMESTAMP';
      return Object.fromEntries(Object.entries(v).filter(([k])=>!['version','created'].includes(k)).map(([k,val])=>[k,normalize(val)]));
    }
    return v;
  }
  return normalize({actor:row.actor,reader:row.reader,submitted:row.submitted,proposal:row.proposal,
    before:row.before,after:row.after,observed:row.observed});
}

function sensitivity(receipt,j) {
  const checked=(clone,pattern)=>{
    assert.throws(()=>protocol(clone,j.actors,j.proof),e=>e.code==='ERR_ASSERTION' && e.message.includes(pattern));
    return pattern;
  };
  if(receipt.mode==='referee') return null;
  const counter=structuredClone(receipt);
  counter.rows.find(r=>r.id==='f2f3').after[0].data.moveCount++;
  const link=structuredClone(receipt);
  const offer=link.rows.find(r=>r.id==='offer-rematch');
  offer.after[1]=structuredClone(offer.before[1]);
  return {changedMoveCount:checked(counter,'f2f3'),missingAtomicPointer:checked(link,'offer-rematch')};
}

export async function verify(archive,digest,bundle,enginePath) {
  const receipt=retained(archive,digest), {mode,runId,rulesSha256}=receipt;
  assert.ok(['stock','compatibility','stronger','referee'].includes(mode));
  assert.equal(sha(readFileSync(bundle)),rulesSha256,'linked release bytes');
  if(mode==='stock') assert.equal(rulesSha256,manifest.files['v1/rules/stock.rules']);
  const j=journal(archive,receipt,digest);
  const {decisions,history}=protocol(receipt,j.actors,j.proof);
  const special=specials(receipt,j.actors,j.proof);
  let browser;
  if(mode==='referee') {
    assert.equal(sha(readFileSync(enginePath)),receipt.browser.engineSha256,'deployed referee code bytes');
    const metadataPath=join(dirname(realpathSync(enginePath)),'chess-match.mjs');
    assert.equal(sha(readFileSync(metadataPath)),receipt.browser.matchPolicySha256,'deployed metadata policy bytes');
    const engine=await import(pathToFileURL(realpathSync(enginePath)));
    const matchPolicy=await import(pathToFileURL(metadataPath));
    browser=await browserProof(receipt,j,history,engine,matchPolicy);
  } else assert.equal(receipt.browser,undefined);
  const report={mode,runId,receipt:digest,rulesSha256,activeRuleset:j.release,restoredRuleset:j.restored,
    journalSha256:j.journalSha256,signedReadersExplicit:receipt.rows.every(r=>r.reader===j.actors.observer),
    exactProtocolIntents:receipt.rows.filter(r=>r.submitted).length,decisions,special,
    sensitivity:sensitivity(receipt,j),...(browser && {browser})};
  return {report,comparable:Object.fromEntries(receipt.rows.map(r=>[r.id,canonical(r,runId,j.actors)]))};
}

if (import.meta.main) {
  const [archivePath,mode,...args]=process.argv.slice(2);
  const archive=privateArchive(resolve(archivePath));
  if(mode==='verify'){
    const [digest,bundle,engine]=args;
    console.log(JSON.stringify((await verify(archive,digest,bundle,engine)).report,null,2));
  } else {
    assert.equal(mode,undefined,'use verify DIGEST BUNDLE [ENGINE] to inspect an unregistered run');
    const releases=new Map();
    for(const f of readdirSync(join(dir,'releases')).filter(f=>f.endsWith('.json')).sort()) {
      const pin=JSON.parse(readFileSync(join(dir,'releases',f)));
      const {report,comparable}=await verify(archive,pin.receipt,join(dir,pin.bundle),pin.engine && join(dir,pin.engine));
      assert.deepEqual(report,pin.report);
      const raw=gunzipSync(readFileSync(join(dir,'releases',pin.receipt+'.json.gz')));
      assert.equal(sha(raw),pin.receipt);
      assert.deepEqual(raw,readFileSync(join(archive,pin.receipt+'.json')));
      releases.set(pin.id,{report,comparable});
    }
    const stock=releases.get('stock'),compat=releases.get('compatibility');
    let comparableCases=0;
    if(stock && compat) {
      assert.deepEqual(compat.comparable,stock.comparable,'stock vs compatibility normalized writes, verdicts, full readbacks');
      comparableCases=Object.keys(stock.comparable).length;
    }
    console.log(JSON.stringify({releases:[...releases.values()].map(r=>r.report),comparableCases},null,2));
  }
}
