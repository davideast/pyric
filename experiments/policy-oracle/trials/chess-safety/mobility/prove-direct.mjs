import assert from 'node:assert/strict';
import {attacked} from '../../chess/reference/arcade-reference.ts';
import {directions,directTests} from './direct.mjs';

const components={N:[0,1],NE:[1,1],E:[1,0],SE:[1,-1],S:[0,-1],SW:[-1,-1],W:[-1,0],NW:[-1,1]};
const board=Array(64).fill(''),stats={singleAttackerDirections:0,captureAndOccupancy:0,interveningBlockers:0};
function packed() {
  const ranks=[];
  for(let rank=0;rank<8;rank++)ranks.push(...board.slice(rank*8,rank*8+8),'#','#');
  return ranks.join(',')+',';
}
for(const color of ['w','b']) {
  const enemy=color==='w'?'b':'w';
  const patterns=directions.map(([name,offset])=>{
    const {valid,attacked,rejected}=directTests(color,offset);
    return [name,new RegExp('^(?:'+valid+')$'),new RegExp('^(?:'+attacked+')$'),new RegExp('^(?:'+rejected+')$')];
  });
  for(let source=0;source<64;source++)for(let foe=0;foe<64;foe++) {
    if(source===foe)continue;
    for(const kind of 'prnbqk') {
      board[source]=color+'k';board[foe]=enemy+kind;
      for(const [name,valid,threat,rejected] of patterns) {
        const [dx,dy]=components[name],x=(source%8)+dx,y=(source>>3)+dy;
        const to=x+8*y,on=x>=0&&x<8&&y>=0&&y<8;
        function check(key) {
          let expected=false;
          if(on && (!board[to] || (board[to][0]===enemy && board[to]!==enemy+'k'))) {
            const successor=Array.from({length:64},(_,i)=>board[i^56]);
            successor[source^56]='';successor[to^56]=color+'k';
            expected=!attacked(successor,to^56,enemy);
          }
          const text=packed();
          assert.equal(valid.test(text)&&!threat.test(text),expected,`${color} ${source}→${to} ${name} foe ${foe} ${kind} ${key} ${text}`);
          assert.equal(!rejected.test(text),expected,'complement '+text);
          stats[key]++;
        }
        check('singleAttackerDirections');
        if(!on||to===foe)continue;
        if('rbq'.includes(kind)) {
          const ax=foe%8-x,ay=(foe>>3)-y;
          const straight=ax===0||ay===0,diagonal=Math.abs(ax)===Math.abs(ay);
          if((straight && kind!=='b') || (diagonal && kind!=='r')) {
            for(let d=1;d<Math.max(Math.abs(ax),Math.abs(ay));d++){
              const block=to+d*(Math.sign(ax)+8*Math.sign(ay));
              if(block===source)continue;
              board[block]=color+'p';check('interveningBlockers');board[block]='';
            }
            for(const occupant of [color+'n',enemy+'p']) {board[to]=occupant;check('captureAndOccupancy');} board[to]='';
          }
        }
      }
      board[source]='';board[foe]='';
    }
  }
}
console.log(JSON.stringify({authority:'pinned native attacked on each hypothetical successor',...stats},null,2));
