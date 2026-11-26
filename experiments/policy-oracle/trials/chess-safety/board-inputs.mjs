import {readFileSync} from 'node:fs';
import {priorPosition} from '../chess/verify/document.mjs';
const rows=JSON.parse(readFileSync(0,'utf8'));
console.log(JSON.stringify(rows.map(({resource,data})=>{
  const {from,to,promotion}=data.lastMove;
  return {before:priorPosition(resource),after:priorPosition(data),uci:from+to+promotion,
    mover:resource.currentTurn,status:data.status,winner:data.winner};
})));
