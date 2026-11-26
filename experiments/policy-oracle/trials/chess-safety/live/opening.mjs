import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {setTimeout as wait} from 'node:timers/promises';
import {gzipSync,gunzipSync} from 'node:zlib';
import {manifest,sha} from '../../../arcade/corpus.mjs';
import {startJournal,errorDetails,privateArchive,withMonotonicEvidenceClock} from '../../../arcade/live/controller/archive.mjs';
import {fresh,afterMove,movePatch,transition} from '../../chess/verify/document.mjs';
import {journal,retained} from '../../chess/verify/journal.mjs';
import {fixedCreatedAt} from '../../for-of/live/fixtures.mjs';
import {reviewedPlan} from './fixtures.mjs';

// Project the two ordinary moves from the frozen control. No alternative
// terminal assertion or conditional write is submitted in the live lifecycle.
const bytes=readFileSync(new URL('../reachable/lifecycle-v1/opening-plan.json',import.meta.url));
const inputSha256='3a65008cefb14bd78f6fbce12ca7cf16e2fabe28b585d0c9509bc5ec0afd0e42';
assert.equal(sha(bytes),inputSha256);
const opening=JSON.parse(bytes);
const steps=[...opening.setup,opening.ifRefused,opening.next];
assert.deepEqual(steps.map(s=>[s.seat,s.operation??s.uci]),[['host','create'],['guest','join'],['host','g2g4'],['guest','a7a6']]);
for(const s of steps.slice(2))assert.deepEqual(s.claim,{status:'playing',winner:''});
const aliases={host:'host',guest:'guest',observer:'observer'};

function intent(step,path,state,roles) {
  if(step.operation==='create') {
    const {createdAt,...data}=fresh(roles.host,fixedCreatedAt);
    return {op:'set',path,data,serverTimestamp:['createdAt']};
  }
  if(step.operation==='join')return {op:'update',path,data:{guest:roles.guest,status:'playing'}};
  return {op:'update',path,data:{...movePatch(afterMove(state,step.uci,undefined,false)),...step.claim}};
}

function checkOpening(rows,roles,path,checkProof=()=>{}) {
  assert.equal(rows.length,steps.length);
  let previous={path,data:null,version:null};
  for(const [index,row] of rows.entries()) {
    const step=steps[index];
    assert.equal(row.id,step.operation??step.uci);
    assert.equal(row.actor,roles[step.seat]);
    assert.equal(row.reader,roles.observer);
    assert.deepEqual(row.before,[previous]);
    assert.equal(row.after.length,1);
    const after=row.after[0];
    assert.equal(after.path,path);
    const op=intent(step,path,previous.data,roles);
    assert.deepEqual(row.submitted,[op]);
    assert.ok(['ALLOW','DENY'].includes(row.observed));
    // Record a refusal as an observation. Later actions require a real joined match.
    if(index<2)assert.equal(row.observed,'ALLOW','opening setup did not complete');
    if(index===2)assert.equal(row.observed,'ALLOW','first ply did not complete');
    const target=row.observed==='DENY' ? previous.data : op.op==='set' ? fresh(roles.host,after.data?.createdAt) : {...previous.data,...op.data};
    transition(previous,after,target,row.id);
    checkProof(row); previous=after;
  }
  return previous;
}

async function capture(name,archive,priorRun) {
  // Credentials and the live SDK are needed only to perform a new capture.
  const {clientsFor,lite}=await import('../../../arcade/live/controller/clients.mjs');
  const {counterPropagation}=await import('../../../arcade/live/controller/counter-controls.mjs');
  const {initializeApp,deleteApp}=await import('../../../arcade/live/controller/chess-sdk.mjs');
  const {withPreparedRuleset,withRelease}=await import('../../../arcade/live/controller/release.mjs');
  const {decision,snapshot}=await import('../../chess/live/snapshots.mjs');
  const {previouslyUploaded}=await import('./measure.mjs');
  const {plan,bundle}=reviewedPlan(name);
  const digest=plan.rulesSha256, mode='honest-opening-'+name, source=readFileSync(bundle,'utf8');
  const prepared=previouslyUploaded(archive,priorRun,digest), runId=randomUUID();
  const archiveWriter=startJournal(archive,runId), clients=clientsFor(runId,archiveWriter);
  console.log('Private run',runId,mode,digest);
  let stopped=false, writer, guest, reader, anonymous;
  const stop=()=>{stopped=true;}; const checkStop=()=>assert.ok(!stopped,'interrupted');
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  try {
    const receipt=await withPreparedRuleset(prepared,()=>withRelease({runId,journal:archiveWriter,source,digest,checkStop,
      async setupClients(config) {
        writer=await clients.add('host',config); guest=await clients.add('guest',config);
        reader=await clients.add('observer',config); anonymous=initializeApp(config,runId+'-signed-out');
      },
      async checkPropagation(phase,proof) {
        if(phase==='open')await wait(Math.max(0,Date.parse(proof.releaseUpdateTime)+65000-Date.now()));
        return counterPropagation({phase,proof,runId,writer,reader,journal:archiveWriter,checkStop});
      },
      async capture(verify) {
        const path='chess/'+runId, signedOut=lite.getFirestore(anonymous,manifest.target.database);
        const control=await decision(()=>lite.getDoc(lite.doc(signedOut,path)));
        assert.equal(control,'DENY');archiveWriter.event('unauthenticated-read',{path,observed:control});
        const seats={host:writer,guest,observer:reader};
        const roles=Object.fromEntries(Object.entries(seats).map(([seat,client])=>[seat,client.identity.uid]));
        const rows=[];
        for(const step of steps) {
          checkStop();const proof=await verify(), before=await snapshot(reader,path);
          const op=intent(step,path,before.data,roles), client=seats[step.seat];
          assert.equal(client.auth.currentUser.uid,roles[step.seat]);
          const ref=lite.doc(client.lite,path);
          const observed=await decision(()=>op.op==='set' ? lite.setDoc(ref,{...op.data,createdAt:lite.serverTimestamp()}) : lite.updateDoc(ref,op.data));
          const after=await snapshot(reader,path);
          const row={id:step.operation??step.uci,actor:roles[step.seat],reader:roles.observer,submitted:[op],observed,before:[before],after:[after],proof,end:await verify()};
          archiveWriter.event('chess-attempt',row); rows.push(row);
          if(rows.length<4)assert.equal(observed,'ALLOW','prerequisite '+row.id+' was refused');
        }
        checkOpening(rows,roles,path);
        return archiveWriter.retain({runId,mode,rulesSha256:digest,target:manifest.target,inputSha256,rows});
      }
    }));
    archiveWriter.complete({mode,runId,rulesSha256:digest,receipt});
    console.log('Qualified',mode,receipt);
    return receipt;
  } catch(error) {archiveWriter.event('failure',errorDetails(error));throw error;}
  finally {process.off('SIGINT',stop);process.off('SIGTERM',stop);if(anonymous)await deleteApp(anonymous);await clients.close();}
}

function qualify(name,archive,digest) {
  const {plan}=reviewedPlan(name), raw=retained(archive,digest);
  assert.equal(raw.mode,'honest-opening-'+name);assert.equal(raw.rulesSha256,plan.rulesSha256);
  assert.equal(raw.inputSha256,inputSha256);
  const j=journal(archive,raw,digest), path='chess/'+raw.runId;
  checkOpening(raw.rows,j.actors,path,row=>{j.proof(row.proof);j.proof(row.end);assert.ok(Date.parse(row.end.verifiedAt)>=Date.parse(row.proof.verifiedAt));});
  const aliasesById=new Map(Object.entries(j.actors).map(([role,uid])=>[uid,role]));
  aliasesById.set(path,'chess/match-opening');
  function redact(value) {
    if(typeof value==='string')return aliasesById.get(value)??value;
    if(Array.isArray(value))return value.map(redact);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,redact(v)]));
    return value;
  }
  const rows=raw.rows.map(({proof,end,...row})=>redact(row));
  const evidence={mode:raw.mode,rulesSha256:raw.rulesSha256,inputSha256,receipt:digest,journalSha256:j.journalSha256,
    targetDatabaseUid:manifest.target.uid,restored:j.restored,leaseReleased:true,
    controls:j.all('propagation-confirmed').map(c=>({phase:c.phase,rulesSha256:c.proof.rulesSha256,receipt:c.digest})),rows};
  validate(name,evidence);
  const publicBytes=JSON.stringify(evidence);
  for(const id of [raw.runId,...Object.values(j.actors)])assert.ok(!publicBytes.includes(id));
  return evidence;
}

function validate(name,evidence) {
  const {plan}=reviewedPlan(name), closed=manifest.files['v1/rules/closed.rules'];
  assert.equal(evidence.mode,'honest-opening-'+name);assert.equal(evidence.rulesSha256,plan.rulesSha256);
  assert.equal(evidence.inputSha256,inputSha256);assert.equal(evidence.targetDatabaseUid,manifest.target.uid);
  assert.equal(evidence.restored,manifest.target.closedRuleset);assert.equal(evidence.leaseReleased,true);
  assert.deepEqual(evidence.controls.map(c=>[c.phase,c.rulesSha256]),[['initially-closed',closed],['open',plan.rulesSha256],['restored-closed',closed]]);
  for(const digest of [evidence.receipt,evidence.journalSha256,...evidence.controls.map(c=>c.receipt)])assert.match(digest,/^[a-f0-9]{64}$/);
  return checkOpening(evidence.rows,aliases,'chess/match-opening');
}

function keep(url,bytes) {
  if(existsSync(url))assert.deepEqual(readFileSync(url),bytes);
  else writeFileSync(url,bytes,{flag:'wx'});
}

const [operation,name,archivePath,prior]=process.argv.slice(2);
assert.ok(['measure','replay','preflight'].includes(operation));
const {plan}=reviewedPlan(name), location=new URL('openings/'+plan.rulesSha256+'/',import.meta.url);
const archive=archivePath&&privateArchive(archivePath);
if(operation==='measure') {
  assert.ok(archive&&prior);
  const receipt=await withMonotonicEvidenceClock(()=>capture(name,archive,prior));
  const evidence=qualify(name,archive,receipt), zipped=gzipSync(JSON.stringify(evidence)+'\n');
  mkdirSync(location,{recursive:true});
  keep(new URL(name+'.json.gz',location),zipped);
  keep(new URL(name+'.pin.json',location),Buffer.from(JSON.stringify({receipt,gzipSha256:sha(zipped)},null,2)+'\n'));
}
if(operation==='preflight')console.log('Frozen honest control',steps.map(s=>s.operation??s.uci).join(' '),plan.rulesSha256);
else {
  const zipped=readFileSync(new URL(name+'.json.gz',location)), pin=JSON.parse(readFileSync(new URL(name+'.pin.json',location)));
  assert.equal(sha(zipped),pin.gzipSha256);
  const evidence=JSON.parse(gunzipSync(zipped));assert.equal(evidence.receipt,pin.receipt);
  const end=validate(name,evidence);
  if(archive)assert.deepEqual(evidence,qualify(name,archive,pin.receipt));
  console.log(JSON.stringify({rows:evidence.rows.map(r=>[r.id,r.observed,r.after[0].data.moveCount]),finalStatus:end.data.status,receipt:pin.receipt}));
}
