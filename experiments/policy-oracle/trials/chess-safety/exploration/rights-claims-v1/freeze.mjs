import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync,gzipSync} from 'node:zlib';
import {sha} from '../../../../arcade/corpus.mjs';
import {position} from '../../../chess/reference/score.mjs';
import {nativeEvidence} from '../../reference/native.mjs';

const masks=Array.from({length:16},(_,mask)=>[...'KQkq'].filter((_,i)=>mask&(1<<i)).join(''));
const rows=[],controls=[];
const placements='r3k2r/8/8/8/8/8/8/R3K2R';
for(const rights of masks) for(const [turn,moves] of [
  ['w',['a1a8','h1h8','e1e2','e1c1','e1g1']],['b',['a8a1','h8h1','e8e7','e8c8','e8g8']]]) {
  for(const uci of moves) {
    const c={id:'rights-base',fen:placements+' '+turn+' '+(rights||'-')+' -',uci};
    const a=nativeEvidence([c]).cases[0];
    if(!a.nativeLegal)continue;
    const expected=position(a.successor).castling;
    const revoked=[...rights].filter(v=>!expected.includes(v));
    const base=uci[0]==='e'?(uci[2]==='e'?'king-step':'castle'):'corner-to-corner';
    for(const claimedRights of masks) {
      const id=uci+'-'+(rights||'none')+'-claim-'+(claimedRights||'none');
      rows.push({group:base+'-drop-'+revoked.length,id,fen:c.fen,uci,claimedRights,expectedRights:expected,
        nativeAdmission:claimedRights===expected,successor:a.successor});
      if(rights==='KQkq'&&uci==='a1a8'&&[expected,expected+'q','KQk',rights].includes(claimedRights))
        controls.push({id,fen:c.fen,uci,claimedRights});
    }
  }
}
const bytes=JSON.stringify(rows), table={},summary={source:'native Arcade successor rights, independent standalone agreement',
  moves:new Set(rows.map(x=>x.fen+' '+x.uci)).size,writes:rows.length,sha256:sha(bytes),groups:table};
for(const row of rows) {
  const by=table[row.group]??={allow:0,deny:0};by[row.nativeAdmission?'allow':'deny']++;
}
const save=(name,value)=>writeFileSync(new URL(name,import.meta.url),value,{flag:'wx'});
if(process.argv[2]==='--freeze') {
  save('corpus.json.gz',gzipSync(bytes,{level:9}));save('freeze.json',JSON.stringify(summary,null,2)+'\n');
  save('controls.json',JSON.stringify(controls,null,2)+'\n');
} else {
  assert.deepEqual(JSON.parse(readFileSync(new URL('freeze.json',import.meta.url))),summary);
  assert.equal(gunzipSync(readFileSync(new URL('corpus.json.gz',import.meta.url))).toString(),bytes);
  assert.deepEqual(JSON.parse(readFileSync(new URL('controls.json',import.meta.url))),controls);
}
console.log(JSON.stringify(summary,null,2));
