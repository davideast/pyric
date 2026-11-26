import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {position} from '../../../chess/reference/score.mjs';
import * as native from '../../../chess/reference/native.mjs';
import * as standalone from '../../../chess/policies/chess.mjs';

const source=readFileSync(new URL('../../../chess/reference/public.json.gz',import.meta.url));
const digest=data=>createHash('sha256').update(data).digest('hex');
const corpusSha=digest(source);
assert.equal(corpusSha,'c2a0ee05ec81ce32998cb58281363a3a96cdee07b950fb697df204283d6e6d71');
const archive=JSON.parse(gunzipSync(source));
assert.equal(archive.engine,'python-chess 1.11.2');

export function* positions(traces=archive.traces) {
  const seen=new Set();
  for(const trace of traces) for(const [ply,row] of trace.rows.entries()) {
    const key=row.fen;
    const first=!seen.has(key);
    seen.add(key);
    yield {trace:trace.name,ply,row,next:trace.rows[ply+1],first};
  }
}

export function freeze(catalog=archive, archiveSha=corpusSha) {
  const hash=createHash('sha256');
  let uniquePositions=0, legalSuccessors=0, recordedMoves=0;
  const endings={};
  for(const {trace,ply,row,next,first} of positions(catalog.traces)) {
    const pos=position(row.fen);
    if(row.move) {
      assert.ok(row.legal.includes(row.move));
      assert.deepEqual(native.apply(pos,row.move),position(next.fen),trace+' '+ply);
      recordedMoves++;
    } else {
      endings[row.outcome]=(endings[row.outcome]??0)+1;
    }
    if(!first) continue;
    uniquePositions++;
    const legal=Array.from(native.legalMoves(pos)).sort();
    assert.deepEqual(legal,row.legal);
    assert.deepEqual(standalone.legalMoves(pos).sort(),legal);
    for(const move of legal) {
      const after=native.apply(pos,move);
      assert.deepEqual(standalone.apply(pos,move),after);
      const outcome=native.outcome(after);
      assert.equal(standalone.outcome(after),outcome);
      hash.update(JSON.stringify([row.fen,move,after.board,after.turn,after.castling,after.enPassant,outcome])+'\n');
      legalSuccessors++;
    }
  }
  return {archiveSha256:archiveSha,source:catalog.engine,traces:catalog.traces.length,
    uniquePositions,legalSuccessors,recordedMoves,endings,successorDigest:hash.digest('hex')};
}

if(import.meta.main) console.log(JSON.stringify(freeze(),null,2));
