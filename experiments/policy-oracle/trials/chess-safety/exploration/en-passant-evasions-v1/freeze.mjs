import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import * as chess from '../../../chess/reference/arcade-reference.ts';
import * as native from '../../../chess/reference/native.mjs';
import * as pyric from '../../../chess/policies/chess.mjs';
import {position} from '../../../chess/reference/score.mjs';
import {nativeEvidence} from '../../reference/native.mjs';

const sha = s => createHash('sha256').update(s).digest('hex');
const fen = p => {
  const ranks = Array.from({length:8},(_,r) => p.board.slice(8*r,8*r+8).map(s=>!s?'1':s[0]==='w'?s[1].toUpperCase():s[1]).join('').replace(/1+/g,v=>v.length));
  return `${ranks.join('/')} ${p.turn} - ${p.enPassant<0?'-':chess.squareName(p.enPassant)}`;
};
const layers = new Map(), enumerated = {};
function retain(group,input){
  const key = sha(JSON.stringify(input));
  const rows = layers.get(group) ?? [];
  enumerated[group] = (enumerated[group] ?? 0) + 1;
  if(rows.length===12 && key>=rows.at(-1).key) return;
  rows.push({key,input});rows.sort((a,b)=>a.key.localeCompare(b.key));
  if(rows.length>12) rows.pop();
  layers.set(group,rows);
}
for (const side of ['w','b']) {
  const pushSide=side==='w'?'b':'w', rank=side==='w'?5:4;
  const sq=(file,rank)=>chess.squareOf('abcdefgh'[file]+rank);
  for(const file of [1,3,6]){
    const from=sq(file,side==='w'?7:2),target=sq(file,rank),ep=sq(file,side==='w'?6:3);
    const push=chess.squareName(from)+chess.squareName(target);
    const adjacent=[sq(file-1,rank),sq(file+1,rank)];
    for(const king of Array.from({length:64},(_,i)=>i)) for(const corner of [sq(0,side==='w'?8:1),sq(7,side==='w'?8:1)]) {
      for(const slider of ['r','b']) for(let loc=0;loc<64;loc++) {
        for(const pawns of [[adjacent[0]],[adjacent[1]],adjacent]){
          const squares=[from,target,ep,king,corner,loc,...pawns];
          if(new Set(squares).size!==squares.length)continue;
          const b=Array(64).fill('');
          b[from]=pushSide+'p'; b[king]=side+'k'; b[corner]=pushSide+'k'; b[loc]=pushSide+slider;
          for(const pawn of pawns)b[pawn]=side+'p';
          const prior={board:b,turn:pushSide,castling:'',enPassant:-1};
          // The previous player cannot have ended their turn in check. The double
          // push must be playable and may itself give discovered or direct check.
          if(chess.inCheck(prior,side) || !chess.isLegal(prior,{from,to:target})) continue;
          const current=chess.applyMove(prior,{from,to:target});
          assert.equal(current.enPassant,ep);
          const check=chess.inCheck(current,side);
          const pawnRemoved=current.board.slice();pawnRemoved[target]='';
          const pawnWasChecker=check&&!chess.attacked(pawnRemoved,king,pushSide);
          const legal=pawns.map(pawn=>chess.isLegal(current,{from:pawn,to:ep}));
          const distinct=legal.length===2&&legal[0]!==legal[1];
          for(const [i,pawn] of pawns.entries()){
            let kind;
            if(check) kind=legal[i]?(pawnWasChecker?'captures-checking-pawn':'blocks-discovered-check'):'fails-to-escape';
            else if(distinct) kind=legal[i]?'two-capturers-safe':'two-capturers-exposes';
            else if(!legal[i]) kind='opens-'+slider+'-attack';
            else kind='ordinary-safe';
            const input={priorFen:fen(prior),push,fen:fen(current),uci:chess.squareName(pawn)+chess.squareName(ep)};
            retain(side+'/'+kind,input);
          }
        }
      }
    }
  }
}
const rows=[];
for(const [group,items] of [...layers].sort(([a],[b])=>a.localeCompare(b))) {
  for(const [i,{input}] of items.entries()) {
    const id='ep-window-'+group.replace('/','-')+'-'+i;
    const [truth]=nativeEvidence([{id,fen:input.fen,uci:input.uci}]).cases;
    const before=position(input.priorFen);
    assert.ok(pyric.legalMoves(before).includes(input.push));
    assert.deepEqual(pyric.apply(before,input.push),native.apply(before,input.push));
    rows.push({group,id,...input,nativeLegal:truth.nativeLegal,nativeAdmission:truth.nativeAdmission,
      kingSafe:truth.kingSafe,successor:truth.successor,outcome:truth.outcome});
  }
}
for(const side of ['w','b'])for(const group of ['captures-checking-pawn','two-capturers-safe','two-capturers-exposes','opens-r-attack','opens-b-attack']) assert.ok(layers.has(side+'/'+group),group);
const bytes=JSON.stringify(rows);
const summary={authority:'native Arcade and separately run standalone Pyric on previous push and proposed en passant',cases:rows.length,groups:enumerated,sha256:sha(bytes)};
const file=name=>new URL(name,import.meta.url);
if(process.argv[2]==='--freeze'){
  writeFileSync(file('corpus.json.gz'),gzipSync(bytes,{level:9}),{flag:'wx'});
  writeFileSync(file('freeze.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
}else{
  assert.deepEqual(JSON.parse(readFileSync(file('freeze.json'))),summary);
  assert.equal(gunzipSync(readFileSync(file('corpus.json.gz'))).toString(),bytes);
}
console.log(JSON.stringify(summary,null,2));
