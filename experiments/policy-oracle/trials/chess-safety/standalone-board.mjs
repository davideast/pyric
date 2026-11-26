import {isDeepStrictEqual} from 'node:util';
import {readFileSync} from 'node:fs';
import {loadPolicyApi} from '../king-safety/policy/public-api.mjs';
const [dir,...encoded]=process.argv.slice(2);
const {compileBoundedModule}=await loadPolicyApi(dir);
if (typeof compileBoundedModule!=='function') throw Error('missing public compileBoundedModule');
const source=readFileSync(new URL('../chess/policies/chess.policy',import.meta.url),'utf8');
const {moduleSource}=compileBoundedModule(source);
const chess=await import('data:text/javascript;base64,'+Buffer.from(moduleSource).toString('base64'));
for(const name of ['legalMoves','apply','outcome']) if(typeof chess[name]!=='function') throw Error('missing chess export '+name);
const uciPattern=/^[a-h][1-8][a-h][1-8][qrbn]?$/;
const inputs=JSON.parse(Buffer.from(encoded.join(''),'base64').toString());
const rows=inputs.map(({before,after,uci,status,winner,mover},i)=>{
  try {
    const legal=chess.legalMoves(before);
    if (!Array.isArray(legal)||!legal.every(move=>typeof move==='string'&&uciPattern.test(move))||new Set(legal).size!==legal.length)
      throw Error('legalMoves must return distinct UCI moves');
    if (!legal.includes(uci)) return {i,decision:'DENY'};
    const derived=chess.apply(before,uci);
    if (!derived||!Array.isArray(derived.board)||derived.board.length!==64||
        !derived.board.every(piece=>typeof piece==='string'&&/^(?:[wb][prnbqk])?$/.test(piece))||
        !['w','b'].includes(derived.turn)||typeof derived.castling!=='string'||!/^K?Q?k?q?$/.test(derived.castling)||
        !Number.isInteger(derived.enPassant)||derived.enPassant < -1||derived.enPassant>63) throw Error('apply returned an invalid position');
    const outcome=chess.outcome(derived);
    if(!['checkmate','stalemate','playing'].includes(outcome)) throw Error('outcome must return a chess status');
    const correctStatus={checkmate:'won',stalemate:'draw',playing:'playing'}[outcome];
    if (!correctStatus) throw Error('unknown chess outcome: '+outcome);
    const correctWinner=outcome==='checkmate'?mover:'';
    const accepted=isDeepStrictEqual(derived,after)&&status===correctStatus&&winner===correctWinner;
    return {i,decision:accepted?'ALLOW':'DENY',outcome};
  }catch(e){return {i,error:String(e?.message??e)};}
});
console.log(JSON.stringify(rows));
