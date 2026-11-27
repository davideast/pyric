import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {position} from '../../../chess/reference/score.mjs';
import {squareOf} from '../../../chess/reference/arcade-reference.ts';

const [installed,file,...panels]=process.argv.slice(2);
if(!installed || !file || !panels.length) throw Error('Usage: bun king-projection.mjs INSTALLED_EVALUATOR FULL_RULES PANEL [PANEL ...]');
const {firestoreRules}=await import(pathToFileURL(resolve(installed,'dist/index.js')));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const source=readFileSync(file,'utf8');
const functions=[...source.matchAll(/^  (function slideKing[wb]\(board\) \{\n[\s\S]*?^\})/gm)].map(m=>m[1]);
assert.equal(functions.length,2,'expected the two actual emitted pure adjacent-king helpers');
const rule=`rules_version='2';service cloud.firestore {
  ${functions.join('\n')}
  match /databases/{db}/documents { match /probe/{side} {
    allow create: if side=='w' ? slideKingw(request.resource.data.board) : slideKingb(request.resource.data.board);
  }}
}`;
const evaluator=firestoreRules(rule),results={};
for(const panel of panels) {
  const bytes=readFileSync(panel),rows=JSON.parse(panel.endsWith('.gz')?gunzipSync(bytes):bytes);
  const probes=rows.map(row=>{
    const pos=position(row.successor),side=pos.turn;
    const squares=[];
    for(let rank=1;rank<=8;rank++) {
      for(const f of 'abcdefgh') {
        const piece=pos.board[squareOf(f+rank)];
        squares.push(!piece?',':piece[0]!==side?piece[1]:piece[1]==='k'?'K':'X');
      }
      squares.push('#','#');
    }
    const kingCanStep=row.replies.some(move=>pos.board[squareOf(move.slice(0,2))]===side+'k' &&
      Math.abs(move.charCodeAt(0)-move.charCodeAt(2))<=1);
    return {description:row.id,method:'create',path:'probe/'+side,data:{board:squares.join('')},
      expectation:kingCanStep?'ALLOW':'DENY'};
  });
  const failures=[],accepted=probes.filter(p=>p.expectation==='ALLOW').length;
  for(let start=0;start<probes.length;start+=64) {
    const batch=probes.slice(start,start+64),verdicts=evaluator.simulate(batch).cases;
    for(const [i,verdict] of verdicts.entries()) {
      if(verdict.decision!==batch[i].expectation || verdict.resourceLimit || verdict.unsupported ||
        verdict.trace.some(entry=>entry.verdict==='ERROR')) failures.push(batch[i].description);
    }
  }
  results[digest(bytes)]={boards:rows.length,legalKingReply:accepted,noKingReply:rows.length-accepted,failures};
}
console.log(JSON.stringify({fullRulesSha256:digest(source),results},null,2));
assert.ok(Object.values(results).every(r=>!r.failures.length));
