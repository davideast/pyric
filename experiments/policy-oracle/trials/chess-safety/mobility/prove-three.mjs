import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pieces,verdict} from '../terminal/table-v2/endings.mjs';
import {touching} from '../terminal/v1/geometry.mjs';
import {terminalEnvelope,threePatterns} from './three-piece.mjs';

const frozen=JSON.parse(readFileSync(new URL('../terminal/table-v2/native.json',import.meta.url)));
const hash=createHash('sha256'), totals={};
const padded=s=>s%8+(s>>3)*10;
const envelope=new RegExp('^(?:'+terminalEnvelope()+')$');
let count=0;
for(const color of ['w','b']) {
  const opp=color==='w'?'b':'w';
  const patterns=Object.fromEntries(['won','draw','either'].map(s=>[s,threePatterns(color,s).map(x=>new RegExp('^(?:'+x+')$'))]));
  for(const piece of pieces) {
    const tally=totals[color+piece]={playing:0,checkmate:0,stalemate:0};
    for(let s=0;s<64;s++)for(let d=0;d<64;d++)for(let a=0;a<64;a++) {
      if(s===d||a===s||touching(a,d))continue;
      const cells=[[padded(s),color+piece],[padded(d),opp+'k'],[padded(a),color+'k']].sort((a,b)=>a[0]-b[0]);
      let key='',offset=0;
      for(const [square,type] of cells) {key+=','.repeat(square-offset)+type;offset=square;}
      key+=','.repeat(80-offset);
      const won=patterns.won.some(p=>p.test(key)), draw=patterns.draw.some(p=>p.test(key));
      const terminal=patterns.either.some(p=>p.test(key)), label=verdict(piece,s,d,a);
      assert.equal(won,label==='won'); assert.equal(draw,label==='draw'); assert.equal(terminal,won||draw);
      if(terminal)assert.ok(envelope.test(key));
      if(piece!=='q' && (won||draw)) assert.equal(Math.max(Math.abs(d%8-a%8),Math.abs((d>>3)-(a>>3))),2);
      const status=won?'checkmate':draw?'stalemate':'playing';
      tally[status]++; count++;
      hash.update([color,piece,s,d,a,status].join(' ')+'\n');
    }
  }
}
assert.deepEqual(totals,frozen.tally);
assert.equal(count,frozen.positions);
assert.equal(hash.digest('hex'),frozen.sha256);
console.log(JSON.stringify({positions:count,independentNativeSha256:frozen.sha256,trueTerminal: Object.values(totals).reduce((n,t)=>n+t.stalemate+t.checkmate,0),separateWonDrawAndEitherPatterns:true,fastMaterialShortcut:true},null,2));
