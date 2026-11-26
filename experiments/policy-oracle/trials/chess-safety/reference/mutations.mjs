import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sha} from '../../../arcade/corpus.mjs';
import {position} from '../../chess/reference/score.mjs';
import {sample} from './fixtures.mjs';

const source=readFileSync(new URL('../../chess/reference/arcade-reference.ts',import.meta.url),'utf8');
assert.equal(sha(source),'1f321bbb70128936c00283d22cfe03ad84b8907a00f0dacf3363b694d6534d5e');
const ordinary='return pseudoMoves(pos).filter((m) => !inCheck(applyMove(pos, m), pos.turn));';
const beforeRay='for (let k = 1; k < 8; k++) {\n        const p = at(r + dr * k, c + dc * k);';

const variants={
  '01-rank-diagonal':[
    {name:'forbid-any-move-by-absolutely-pinned-piece',edits:[[ordinary,`
      return pseudoMoves(pos).filter(m => {
        if (inCheck(applyMove(pos,m),pos.turn)) return false;
        if (pos.board[m.from][1] === 'k') return true;
        const b = [...pos.board];
        b[m.from] = '';
        return !inCheck({...pos,board:b},pos.turn);
      });`]]},
  ],
  '02-king-destinations':[
    {name:'use-legal-captures-to-detect-attacked-king-destination',edits:[[ordinary,`
      return pseudoMoves(pos).filter(m => {
        const next = applyMove(pos,m);
        if (pos.board[m.from][1] !== 'k') return !inCheck(next,pos.turn);
        return !pseudoMoves(next).some(reply => reply.to === m.to && !inCheck(applyMove(next,reply),next.turn));
      });`]]},
  ],
  '03-check-evasions':[
    {name:'accept-eliminating-one-checker-in-double-check',edits:[[ordinary,`
      function count(p) {
        const target = p.board.indexOf(pos.turn+'k');
        const by = other(pos.turn);
        return p.board.reduce((total,piece,i) => {
          if (!piece || piece[0] !== by) return total;
          // Change each other hostile piece to an inert blocker, retaining occupancy.
          const single = p.board.map((v,j) => j !== i && v[0] === by ? pos.turn+'n' : v);
          return total + (attacked(single,target,by) ? 1 : 0);
        },0);
      }
      const before = count(pos);
      return pseudoMoves(pos).filter(m => {
        const remaining = count(applyMove(pos,m));
        return remaining === 0 || remaining < before;
      });`]]},
  ],
  '04-en-passant':[
    {name:'leave-captured-en-passant-pawn-on-board',edits:[[
      "if (kind === 'p' && move.to === pos.enPassant) board[move.to + (color === 'w' ? 8 : -8)] = '';",
      '// en passant victim erroneously retained',
    ]]},
  ],
  '05-castling':[
    {name:'test-only-final-king-square-when-castling',edits:[
      [" && !attacked(board, home, other(turn))",''],
      ["&& !attacked(board, home + 1, other(turn)) && !attacked(board, home + 2, other(turn))",''],
      ["&& !attacked(board, home - 1, other(turn)) && !attacked(board, home - 2, other(turn))",''],
    ]},
  ],
  '06-composition':[
    {name:'truncate-slider-attack-ray-before-seventh-square',edits:[[beforeRay,beforeRay.replace('k < 8','k < 7')]]},
  ],
  '07-terminal':[
    {name:'accept-client-declared-result-for-legal-move',edits:[],trust:true},
    {name:'inspect-only-king-replies-for-terminal-position',edits:[[
      'if (legalMoves(pos).length > 0)', "if (legalMoves(pos).some(m => pos.board[m.from][1] === 'k'))",
    ]]},
  ],
};

async function mutate(edits) {
  let code=source;
  for(const [needle,replacement] of edits) {
    assert.equal(code.split(needle).length,2,'mutation must have one source location');
    code=code.replace(needle,replacement);
  }
  const js=new Bun.Transpiler({loader:'ts'}).transformSync(code);
  const mod=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
  return {engine:mod,sourceDigest:sha(code)};
}

export async function sensitivity(batch,inputs,truth) {
  assert.deepEqual(inputs.map(c=>c.id),truth.cases.map(c=>c.id));
  const results=[];
  for(const variant of variants[batch]) {
    const {engine,sourceDigest}=await mutate(variant.edits);
    const mistakes=[];
    for(const [i,c] of inputs.entries()) {
      const p=position(c.fen), m={from:engine.squareOf(c.uci.slice(0,2)),to:engine.squareOf(c.uci.slice(2,4)),
        ...(c.uci[4] && {promotion:c.uci[4]})};
      const legal=engine.isLegal(p,m);
      let accept=legal;
      if(batch==='07-terminal' && !variant.trust) {
        const result=engine.outcome(engine.applyMove(p,m));
        const status=result==='checkmate'?'won':result==='stalemate'?'draw':'playing';
        const winner=status==='won'?(p.turn==='w'?'host':'guest'):'';
        const {proposal}=sample(c,'writer','other');
        accept=legal && proposal.status===status && proposal.winner===winner;
      }
      if(accept!==truth.cases[i].nativeAdmission) mistakes.push({id:c.id,native:truth.cases[i].nativeAdmission,mutant:accept});
    }
    assert.ok(mistakes.length,variant.name+' must be caught');
    results.push({name:variant.name,sourceDigest,cases:inputs.length,firstDivergence:mistakes[0],mistakes});
  }
  return {batch,authority:'offline mutation sensitivity',results};
}

if(import.meta.main) {
  const batch=process.argv[2];
  const read=name=>JSON.parse(readFileSync(new URL('../batches/'+batch+'/v1/'+name+'.json',import.meta.url)));
  console.log(JSON.stringify(await sensitivity(batch,read('positions'),read('native')),null,2));
}
