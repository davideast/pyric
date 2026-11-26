import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {position} from '../../chess/reference/score.mjs';
import {legalMoves,squareName} from '../../chess/reference/arcade-reference.ts';
import {loadPolicyApi} from '../../king-safety/policy/public-api.mjs';
import {compileKnight} from './knight.mjs';
import {sha} from '../../../arcade/corpus.mjs';

const [pkg,extra,variant]=process.argv.slice(2);
const {compileFunction}=await loadPolicyApi(pkg);
const policy=compileKnight(compileFunction,{mode:'standalone',quiet:variant==='--quiet',pair:['--pair','--all'].includes(variant),all:variant==='--all'});
const archive=readFileSync(new URL('../../chess/reference/public.json.gz',import.meta.url));
assert.equal(sha(archive),'c2a0ee05ec81ce32998cb58281363a3a96cdee07b950fb697df204283d6e6d71');
const pub=JSON.parse(gunzipSync(archive));
const inputs=new Map([...pub.positions,...pub.traces.flatMap(t=>t.rows)].map(c=>[c.fen,c.legal]));
let independentSha=null;
if(extra) {
  const bytes=gunzipSync(readFileSync(extra));
  independentSha=sha(bytes);
  assert.equal(independentSha,'d86a76e978fda19b225777cef344d937ecb7d9edaa21920ed160fe4c4ecb90fc');
  for(const row of JSON.parse(bytes)) if(row.successor)inputs.set(row.successor,null);
}
const limits=JSON.parse(readFileSync(new URL('knight-limit-native.json',import.meta.url)));
for(const r of limits.cases)inputs.set(r.fen,r.legalKnightMoves);
const stats={limitedExamples:[],unique:inputs.size,extraCorpus:independentSha,counts:{},eligibility:{},projectedWitnesses:0,missingOnThreeOrMore:0};
for(const [fen,archived] of inputs) {
  const p=position(fen);
  const board=Object.fromEntries(p.board.map((pc,i)=>[squareName(i),pc]));
  const count=p.board.filter(v=>v===p.turn+'n').length;
  const legal=archived??legalMoves(p).map(m=>squareName(m.from)+squareName(m.to)+(m.promotion??''));
  const actual=legal.filter(m=>board[m.slice(0,2)]===p.turn+'n').sort();
  const found=policy.witnesses(board,p.turn);
  for(const m of found)assert.ok(actual.includes(m),fen+' '+m);
  if(count<=2 || (variant==='--all' && count<=10))assert.deepEqual(found,actual,fen);
  if(count>2) {
    const missed=actual.filter(m=>!found.includes(m));
    stats.missingOnThreeOrMore+=missed.length;
    if(limits.cases.some(c=>c.fen===fen))stats.limitedExamples.push({fen,found,missed});
  }
  assert.equal(policy.hasReply(board,p.turn),found.length>0,fen);
  stats.counts[count]=(stats.counts[count]??0)+1;
  const label=count===0?'absent':found.length?'legal':'unable';
  stats.eligibility[label]=(stats.eligibility[label]??0)+1;
  stats.projectedWitnesses+=found.length;
}
console.log(JSON.stringify(stats,null,2));
