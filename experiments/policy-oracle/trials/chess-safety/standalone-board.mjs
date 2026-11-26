import {isDeepStrictEqual} from 'node:util';
import {readFileSync} from 'node:fs';
import {loadPolicyApi} from '../king-safety/policy/public-api.mjs';
const [dir,...encoded]=process.argv.slice(2);
const {compileBoundedModule}=await loadPolicyApi(dir);
if (typeof compileBoundedModule!=='function') throw Error('missing public compileBoundedModule');
const source=readFileSync(new URL('../chess/policies/chess.policy',import.meta.url),'utf8');
const {moduleSource}=compileBoundedModule(source);
const chess=await import('data:text/javascript;base64,'+Buffer.from(moduleSource).toString('base64'));
const inputs=JSON.parse(Buffer.from(encoded.join(''),'base64').toString());
const rows=inputs.map(({before,after,uci,status,winner,mover},i)=>{
  try {
    if (!chess.legalMoves(before).includes(uci)) return {i,decision:'DENY'};
    const derived=chess.apply(before,uci);
    const outcome=chess.outcome(derived);
    const correctStatus={checkmate:'won',stalemate:'draw',playing:'playing'}[outcome];
    if (!correctStatus) throw Error('unknown chess outcome: '+outcome);
    const correctWinner=outcome==='checkmate'?mover:'';
    const accepted=isDeepStrictEqual(derived,after)&&status===correctStatus&&winner===correctWinner;
    return {i,decision:accepted?'ALLOW':'DENY',outcome};
  }catch(e){return {i,error:String(e?.message??e)};}
});
console.log(JSON.stringify(rows));
