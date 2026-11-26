import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sha} from '../../../arcade/corpus.mjs';
import {position} from '../../chess/reference/score.mjs';
import {inCheck,applyMove,squareOf,squareName} from '../../chess/reference/arcade-reference.ts';
import {loadPolicyApi} from '../../king-safety/policy/public-api.mjs';
import {packedSources} from './packed.mjs';
import {squares} from './geometry.mjs';

const [pkg]=process.argv.slice(2);
const nativeHash=sha(readFileSync(new URL('../../chess/reference/arcade-reference.ts',import.meta.url)));
assert.equal(nativeHash,'1f321bbb70128936c00283d22cfe03ad84b8907a00f0dacf3363b694d6534d5e');
const {compileFunction}=await loadPolicyApi(pkg);
const compiled=Object.fromEntries(Object.entries(packedSources(true)).map(([key,src])=>[key,compileFunction(src)]));
const blank=()=>Object.fromEntries(squares.map(s=>[s,'']));
const chess=position('8/8/8/8/8/8/8/8 w - -');
function asPosition(b,turn) {
  return {...chess,turn,board:Array.from({length:64},(_,i)=>b[squareName(i)])};
}
const stats={singleAttacker:0,singleAttackerChecks:0,alignedBlocker:0,castles:0,castleRefusals:0};
function compare(b,color,category) {
  const actual=compiled.packedSafe(compiled.packNormal(b),color);
  const expected=!inCheck(asPosition(b,color),color);
  assert.equal(actual,expected,JSON.stringify({b,color,category}));
  stats[category]++;
  return expected;
}

for (const color of ['w','b']) {
  const enemy=color==='w'?'b':'w';
  for (const king of squares) for (const foe of squares) {
    if(king===foe) continue;
    const b=blank();
    b[king]=color+'k';
    for(const kind of 'prnbqk') {
      b[foe]=enemy+kind;
      if(compare(b,color,'singleAttacker')) continue;
      stats.singleAttackerChecks++;
      if(!'rbq'.includes(kind)) continue;
      const x=king.charCodeAt(0),y=Number(king[1]);
      const dx=foe.charCodeAt(0)-x,dy=Number(foe[1])-y;
      for(let i=1;i<Math.max(Math.abs(dx),Math.abs(dy));i++) {
        const sq=String.fromCharCode(x+i*Math.sign(dx))+(y+i*Math.sign(dy));
        for(const side of [color,enemy]) {
          // A knight on the ray may independently attack the king.
          b[sq]=side+'n';
          compare(b,color,'alignedBlocker');
        }
        b[sq]='';
      }
    }
  }
  const rank=color==='w'?'1':'8', from='e'+rank;
  for(const short of [true,false]) {
    const rook=(short?'h':'a')+rank, transit=(short?'f':'d')+rank, to=(short?'g':'c')+rank;
    const excluded=new Set([rook,from,transit,to,...short?[]:['b'+rank]]);
    for(const foe of squares) {
      if(excluded.has(foe)) continue;
      for(const kind of 'prnbqk') {
        const b=blank();
        b[from]=color+'k';b[rook]=color+'r';b[foe]=enemy+kind;
        const p=asPosition(b,color);
        const unsafe=inCheck(p,color) || [transit,to].some(target=>inCheck(applyMove(p,{from:squareOf(from),to:squareOf(target)}),color));
        const actual=compiled.packedSafe(compiled['pack'+color+(short?'short':'long')](b),color);
        assert.equal(actual,!unsafe,JSON.stringify({from,to,foe,kind}));
        stats.castles++;if(unsafe)stats.castleRefusals++;
      }
    }
  }
}
console.log(JSON.stringify({authority:'native attacked squares; synthetic attack configurations',nativeHash,...stats},null,2));
