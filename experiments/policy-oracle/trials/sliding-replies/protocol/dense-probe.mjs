// Query compiled sufficient conditions and independently compare with complete native reply lists.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {position} from '../../chess/reference/score.mjs';
import {legalMoves} from '../../chess/reference/native.mjs';
import {squareOf} from '../../chess/reference/arcade-reference.ts';
const [installed,bundle]=process.argv.slice(2);
const {firestoreRules}=await import(pathToFileURL(resolve(installed,'dist/index.js')));
const source=readFileSync(bundle,'utf8');
const anchor='  match /databases/{database}/documents {';
assert.equal(source.split(anchor).length,2);
const rule="match /denseProof/{id} { allow update: if request.resource.data.white ? denseNoInterpositionw(request.resource.data.text) : denseNoInterpositionb(request.resource.data.text); }";
const probe=firestoreRules(source.replace(anchor,()=>anchor+'\n'+rule));
const sha=b=>createHash('sha256').update(b).digest('hex');
const raw=gunzipSync(readFileSync(new URL('dense-boards.json.gz',import.meta.url)));
const freeze=JSON.parse(readFileSync(new URL('dense-freeze.json',import.meta.url)));
assert.equal(sha(raw),freeze.inputsAndNativeRepliesSha256);
const results=[],frequencies={},perSide={w:{},b:{}},replyKinds={},examples={};
for(const row of JSON.parse(raw)) {
  const p=position(row.fen);
  const native=legalMoves(p).sort();
  assert.deepEqual(native,row.replies);
  assert.deepEqual(native.filter(m=>p.board[squareOf(m.slice(0,2))][1]!=='k'),row.nonking);
  const text=Array.from({length:8},(_,rank)=>Array.from({length:8},(_,file)=>p.board[(7-rank)*8+file]+',').join('')+'#,#,').join('');
  const [out]=probe.simulate([{description:'diagonal proof',method:'update',path:'denseProof/example',resource:{},
    auth:{uid:'host'},data:{white:p.turn==='w',text},expectation:'ALLOW'}]).cases;
  const error=out.resourceLimit?'resource-limit':out.unsupported?'unsupported':out.trace.some(t=>t.verdict==='ERROR')?'evaluation-error':null;
  const proven=out.decision==='ALLOW';
  const outcome=error??(proven?(row.nonking.length?'unsound-proof':'proved-no-nonking-reply'):row.nonking.length?'legal-nonking-reply':'inconclusive');
  frequencies[outcome]=(frequencies[outcome]??0)+1;
  perSide[p.turn][outcome]=(perSide[p.turn][outcome]??0)+1;
  for(const kind of new Set(row.nonking.map(m=>p.board[squareOf(m.slice(0,2))][1]))) replyKinds[kind]=(replyKinds[kind]??0)+1;
  examples[outcome]??={...row,proof:proven};
  results.push([row.fen,outcome,out.evaluatedExpressions]);
}
const report={rulesSha256:sha(source),boards:results.length,nativeInputsSha256:sha(raw),decisionSha256:sha(JSON.stringify(results)),outcomes:frequencies,perSide,replyKinds,examples};
console.log(JSON.stringify(report,null,2));
if(Object.keys(frequencies).some(k=>!['proved-no-nonking-reply','legal-nonking-reply','inconclusive'].includes(k)) ||
  !perSide.w['proved-no-nonking-reply'] || !perSide.b['proved-no-nonking-reply']) process.exitCode=1;
