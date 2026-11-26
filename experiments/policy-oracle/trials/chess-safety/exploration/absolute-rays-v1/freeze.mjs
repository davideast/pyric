import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync,gzipSync} from 'node:zlib';
import {squareName,inCheck,isLegal,applyMove} from '../../../chess/reference/arcade-reference.ts';
import * as standalone from '../../../chess/policies/chess.mjs';

const directions=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[-1,1],[1,-1]];
const jumps=[[1,2],[-1,2],[1,-2],[-1,-2],[2,1],[-2,1],[2,-1],[-2,-1]];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const at=(x,y)=>x>=0&&x<8&&y>=0&&y<8?x+8*y:-1;
function fen(position){
  const ranks=Array.from({length:8},(_,rank)=>position.board.slice(rank*8,rank*8+8).map(p=>
    !p?'1':p[0]==='w'?p[1].toUpperCase():p[1]).join('').replace(/1+/g,s=>s.length));
  return ranks.join('/')+' '+position.turn+' - -';
}

const rows=[], byGeometry={}, verification=createHash('sha256');
let pairs=0;
for(const color of ['w','b'])for(let king=0;king<64;king++)for(const [dx,dy] of directions){
  const other=color==='w'?'b':'w',orthogonal=dx===0||dy===0;
  const line=orthogonal?'r':'b', offLine=orthogonal?'b':'r';
  const square=n=>at((king%8)+n*dx,(king>>3)+n*dy);
  for(let distance=2;square(distance)>=0;distance++)for(let offset=1;offset<distance;offset++){
    const attacker=square(distance),from=square(offset);
    const interior=new Set(Array.from({length:distance-1},(_,i)=>square(i+1)));
    for(const piece of [line,'q']){
      const board=Array(64).fill('');
      board[king]=color+'k';board[from]=color+'n';board[attacker]=other+piece;
      const start={board,turn:color,castling:'',enPassant:-1};
      let pair;
      for(let opponent=0;opponent<64&&!pair;opponent++){
        if(board[opponent]||interior.has(opponent))continue;
        board[opponent]=other+'k';
        // Both source kings must be safe. In particular this excludes adjacent kings.
        if(!inCheck(start,color)&&!inCheck(start,other)){
          for(const [x,y] of jumps){
            const to=at(from%8+x,(from>>3)+y);
            if(to<0||board[to])continue;
            const move={from,to},uci=squareName(from)+squareName(to);
            const exposed=applyMove(start,move);
            assert.ok(!isLegal(start,move)&&inCheck(exposed,color));
            const safe={...start,board:[...board]};safe.board[attacker]=other+offLine;
            if(inCheck(safe,color)||!isLegal(safe,move))continue;
            pair=[{source:start,after:exposed,legal:false},{source:safe,after:applyMove(safe,move),legal:true}].map(entry=>{
              assert.equal(standalone.legalMoves(entry.source).includes(uci),entry.legal);
              assert.equal(standalone.inCheck({...entry.after,turn:color,enPassant:-1}),!entry.legal);
              return {id:'ray-'+pairs+(entry.legal?'-safe':'-pinned'),fen:fen(entry.source),uci,
                group:entry.legal?'safe-twin':'last-blocker',nativeAdmission:entry.legal,successor:fen(entry.after)};
            });
            break;
          }
        }
        board[opponent]='';
      }
      assert.ok(pair,'missing absolute pin geometry at '+[king,dx,dy,distance,offset,piece,color]);
      rows.push(...pair);pairs++;
      const key=[color,dx,dy,distance,offset,piece].join('/');
      byGeometry[key]=(byGeometry[key]??0)+1;
      verification.update(JSON.stringify(pair.map(c=>[c.id,c.successor,c.nativeAdmission]))+'\n');
    }
  }
}
const bytes=Buffer.from(JSON.stringify(rows));
const data={authority:'pinned native Arcade and independent standalone legal moves',scope:'every king square, slider ray, attacker distance, interior knight square, valid slider family, and color; one empty-square knight jump per geometry',
  pairs,writes:rows.length,geometryClasses:Object.keys(byGeometry).length,geometrySha256:sha(JSON.stringify(byGeometry)),inputsSha256:sha(bytes),successorsSha256:verification.digest('hex')};
const file=new URL('corpus.json.gz',import.meta.url);
if(process.argv.includes('--write'))writeFileSync(file,gzipSync(bytes,{level:9}),{flag:'wx'});
else assert.equal(sha(gunzipSync(readFileSync(file))),data.inputsSha256);
console.log(JSON.stringify(data,null,2));
