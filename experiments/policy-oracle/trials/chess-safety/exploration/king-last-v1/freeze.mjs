import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {sha} from '../../../../arcade/corpus.mjs';
import * as arcade from '../../../chess/reference/arcade-reference.ts';
import * as native from '../../../chess/reference/native.mjs';
import {position} from '../../../chess/reference/score.mjs';
import {nativeEvidence} from '../../reference/native.mjs';
import {encode} from '../v1/corpus.mjs';

// When only kings and one nonpawn remain without rights, all eight board
// symmetries preserve legal quiet moves. Ten squares represent defender kings.
const boardSquares=Array.from({length:64},(_,i)=>i);
const representatives=boardSquares.filter(s=>(s>>3)<4 && (s%8)<=(s>>3));
assert.equal(representatives.length,10);
const distance=(a,b)=>Math.max(Math.abs((a>>3)-(b>>3)),Math.abs(a%8-b%8));
const positions=[],coverage={},examples={};
function swapped(c) {
  const p=position(c.fen), flip=i=>i^56, b=Array(64);
  for(let i=0;i<64;i++) b[flip(i)]=p.board[i] ? (p.board[i][0]==='w'?'b':'w')+p.board[i][1] : '';
  const square=s=>arcade.squareName(flip(arcade.squareOf(s)));
  return {fen:encode({...p,board:b,turn:'b',castling:p.castling.toLowerCase()}),
    uci:square(c.uci.slice(0,2))+square(c.uci.slice(2))};
}
function add(c,group) {
  positions.push({...c,group:'w/'+group},{...swapped(c),group:'b/'+group});
}
for(const type of 'qrbn') for(const defender of representatives) {
  for(const king of boardSquares) {
    if(distance(king,defender)<=1) continue;
    for(const piece of boardSquares) {
      if(piece===defender||piece===king)continue;
      const board=Array(64).fill('');
      board[defender]='bk';board[king]='wk';board[piece]='w'+type;
      const next={board,turn:'b',castling:'',enPassant:-1};
      const outcome=native.outcome(next);
      const family=type+'/'+(outcome==='playing'&&arcade.inCheck(next)?'playing-checked':outcome);
      // Count terminal successor classes exhaustively. Sample nonterminal
      // positions only until each selected control class has four examples.
      if(outcome==='playing'&&(examples[family]??0)>=4)continue;
      let hasPrior=false;
      for(const from of boardSquares) {
        if(board[from]||distance(from,king)!==1||distance(from,defender)<=1)continue;
        const before=[...board];before[king]='';before[from]='wk';
        const prior={...next,board:before,turn:'w'};
        if(arcade.inCheck(prior,'b')||!arcade.isLegal(prior,{from,to:king}))continue;
        hasPrior=true;
        if((examples[family]??0)<4) {
          examples[family]=(examples[family]??0)+1;
          add({fen:encode(prior),uci:arcade.squareName(from)+arcade.squareName(king)},family);
        }
        break;
      }
      if(outcome!=='playing'){
        const count=coverage[family]??={terminalSuccessors:0,withLegalKingPredecessor:0};
        count.terminalSuccessors++;
        if(hasPrior)count.withLegalKingPredecessor++;
      }
    }
  }
}
for(const [fen,uci,side] of [['k7/8/8/8/8/8/8/4K2R w K -','e1g1','kingside'],
                             ['7k/8/8/8/8/8/8/R3K3 w Q -','e1c1','queenside']]) {
  add({fen,uci},'castle/'+side+'/held');
  add({fen:fen.replace(/ [KQ] /,' - '),uci},'castle/'+side+'/expired');
}
const rows=[];
for(const c of positions) {
  const writer=c.fen.split(' ')[1]==='w'?'host':'guest';
  for(const [status,winner] of [['playing',''],['draw',''],['won',writer]]) {
    const input={...c,id:'king-last-'+String(rows.length+1).padStart(3,'0'),claim:{status,winner}};
    const truth=nativeEvidence([input]).cases[0];
    rows.push({...input,kingSafe:truth.kingSafe,nativeLegal:truth.nativeLegal,nativeAdmission:truth.nativeAdmission,
      successor:truth.successor,outcome:truth.outcome,replyCount:truth.replies?.length??null,
      ...(truth.replies&&{replySha256:sha(JSON.stringify(truth.replies))})});
  }
}
const bytes=JSON.stringify(rows);
const summary={moves:positions.length,writes:rows.length,selectedWhiteConfigurations:examples,
  terminalRepresentativePositions:coverage,sha256:sha(bytes)};
const url=n=>new URL(n,import.meta.url);
if(process.argv[2]==='--freeze'){
  writeFileSync(url('corpus.json.gz'),gzipSync(bytes,{level:9}),{flag:'wx'});
  writeFileSync(url('freeze.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
}else{
  assert.deepEqual(JSON.parse(readFileSync(url('freeze.json'))),summary);
  assert.equal(gunzipSync(readFileSync(url('corpus.json.gz'))).toString(),bytes);
}
console.log(JSON.stringify(summary,null,2));
