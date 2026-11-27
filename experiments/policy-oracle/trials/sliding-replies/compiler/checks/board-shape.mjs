import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {sample} from '../../../chess-safety/reference/fixtures.mjs';
const [installed, ...rules]=process.argv.slice(2);
if (!installed || !rules.length) throw Error('Usage: bun board-shape.mjs INSTALLED_EVALUATOR FULL_RULES [FULL_RULES ...]');
const {firestoreRules}=await import(pathToFileURL(resolve(installed,'dist/index.js')));
const digest=source=>createHash('sha256').update(source).digest('hex');
const controls=[
 ['white-short','4k3/8/8/8/8/8/8/4K2R w K -','e1g1'],
 ['white-long','4k3/8/8/8/8/8/8/R3K3 w Q -','e1c1'],
 ['black-short','4k2r/8/8/8/8/8/8/4K3 b k -','e8g8'],
 ['black-long','r3k3/8/8/8/8/8/8/4K3 b q -','e8c8'],
 ['white-ep','4k3/8/8/3pP3/8/8/8/4K3 w - d6','e5d6'],
 ['black-ep','4k3/8/8/8/3pP3/8/8/4K3 b - e3','d4e3'],
 ['normal-rook','4k3/8/8/8/8/8/8/R3K3 w - -','a1a2'],
];
const rows=[];
for(const [id,fen,uci] of controls) {
  const {before,proposal}=sample({fen,uci},'writer','other');
  const next={...before,...proposal}, touched=[uci.slice(0,2),uci.slice(2,4),...proposal.lastMove.extra];
  function add(suffix,expectation,mutate) {
    const resource=structuredClone(before),data=structuredClone(next);
    mutate(resource,data);
    // Refresh previous snapshot to isolate the board validation from prevBoard.
    data.prevBoard=structuredClone(resource.board);
    rows.push({description:id+'-'+suffix,path:'chess/shape',method:'update',auth:{uid:'writer'},resource,data,expectation});
  }
  add('stock','ALLOW',()=>{});
  add('unchanged-extra','ALLOW',(old,next)=>{old.board.legacy='';next.board.legacy='';});
  for(const sq of touched){
    add('missing-after-'+sq,'DENY',(_,next)=>{delete next.board[sq]});
    add('missing-before-'+sq,'DENY',(old)=>{delete old.board[sq]});
  }
  add('surplus-new','DENY',(_,next)=>{next.board.i1='';});
  add('missing-unrelated','DENY',(_,next)=>{delete next.board.c3;});
  add('drop-legacy','DENY',(old)=>{old.board.legacy='';});
  add('mutate-legacy','DENY',(old,next)=>{old.board.legacy='';next.board.legacy='wq';});
  add('forged-extra','DENY',(_,next)=>{next.lastMove.extra.push('c3');next.board.c3='bp';});
}
const output={cases:rows.length,expected:{ALLOW:rows.filter(r=>r.expectation==='ALLOW').length,DENY:rows.filter(r=>r.expectation==='DENY').length},runs:{}};
output.requestsSha256=digest(JSON.stringify(rows));
for(const path of rules) {
 const source=readFileSync(path,'utf8'),model=firestoreRules(source);
 const cases=model.simulate(rows).cases;
 output.runs[digest(source)]={total:cases.length,correct:cases.filter((r,i)=>r.decision===rows[i].expectation).length,
   mismatches:cases.flatMap((r,i)=>r.decision===rows[i].expectation?[]:[{id:rows[i].description, expected:rows[i].expectation,observed:r.decision,cost:r.evaluatedExpressions}]),
   limits:cases.flatMap((r,i)=>r.resourceLimit?[rows[i].description]:[])};
}
console.log(JSON.stringify(output,null,2));

assert.ok(Object.values(output.runs).every(run=>run.correct===rows.length && !run.limits.length));
