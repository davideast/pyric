import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {sha} from '../../../arcade/corpus.mjs';
import {withMonotonicEvidenceClock} from '../../../arcade/live/controller/archive.mjs';
import {retained} from '../../chess/verify/journal.mjs';
import {retain} from '../../for-of/live/retain.mjs';
import {inputs,buildPlan,versionDirectory,verifySource,chunkFixtures} from './fixtures.mjs';
import {lookup,verifiedPlan,writeOnce} from './records.mjs';
import {inspectTarget} from './preflight.mjs';
import {uploadObservation} from './upload.mjs';

const json=x=>JSON.stringify(x,null,2)+'\n';

export function prepare(file,digest) {
  const source=readFileSync(file,'utf8');
  verifySource(source,digest);
  const dir=versionDirectory(digest);
  const plan=existsSync(new URL('plan.json',dir))?verifiedPlan(digest).plan:buildPlan(inputs(4),digest);
  mkdirSync(dir,{recursive:true});writeOnce(new URL('firestore.rules',dir),source);
  writeOnce(new URL('plan.json',dir),json(plan));
  return plan;
}

async function execute(args) {
  const [command,digest,name,archive,receipt]=args;
  if(command==='lookup') {
    assert.ok(args.length===2 || (args.length===4 && name==='--archive'));
    console.log(json(lookup(digest,archive)));
  } else if(command==='prepare') {
    assert.equal(args.length,3);
    const plan=prepare(name,digest);
    console.log(json({digest,cases:plan.expectedCases,chunks:plan.chunks.map(c=>[c.name,c.ids.length])}));
  } else {
    assert.ok(['capture','retain'].includes(command));
    assert.equal(args.length,command==='retain'?5:4);
    const {bundle,plan,data,dir}=verifiedPlan(digest);
    const fixtures=chunkFixtures(data,plan,name);
    if(command==='retain') {
      const raw=retained(archive,receipt);
      assert.equal(raw.mode,name);assert.equal(raw.rulesSha256,digest);
      const target=new URL('receipts/',dir);
      retain([archive,receipt,bundle],fixtures,target);
      const bytes=readFileSync(new URL(name+'.json.gz',target));
      writeOnce(new URL(name+'.pin.json',target),json({controllerSha256:receipt,receiptGzipSha256:sha(bytes)}));
      const result=lookup(digest,archive);
      console.log(json({digest,qualified:result.distinctCases,expected:result.expectedCases}));
    } else {
      const state=lookup(digest);
      assert.ok(!state.captures.some(c=>c.name===name),'chunk already qualified');
      const setup=await inspectTarget();
      console.log('Verified original closed target; credential valid through',setup.managementCredentialExpires);
      const {capture}=await import('../../for-of/live/capture.mjs');
      const run=()=>withMonotonicEvidenceClock(()=>capture([name,archive,bundle,digest],fixtures));
      // Ask the capture loop to finish while the management credential can
      // still restore the deny-all release and verify its signed controls.
      const stop=setTimeout(()=>process.emit('SIGTERM'),Date.parse(setup.managementCredentialExpires)-Date.now()-12*60_000);
      try {
        if(state.captures.length) {
          const {previouslyUploaded}=await import('../../chess-safety/live/measure.mjs');
          const {withPreparedRuleset}=await import('../../../arcade/live/controller/release.mjs');
          const prior=retained(archive,state.captures[0].receipt);
          const uploaded=previouslyUploaded(archive,prior.runId,digest);
          await withPreparedRuleset(uploaded,run);
        } else {
          const upload=uploadObservation(digest,archive);
          assert.equal(upload?.state,'compiled','no verified Google ruleset available for activation');
          const {withPreparedRuleset}=await import('../../../arcade/live/controller/release.mjs');
          await withPreparedRuleset(upload.ruleset,run);
        }
      } finally {clearTimeout(stop);}
    }
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await execute(process.argv.slice(2));
