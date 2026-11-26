import assert from 'node:assert/strict';
import { wireFields } from '../../../adapters/arcade-sdk/v1/evidence.mjs';
import { lite, createDocument } from '../../../arcade/live/controller/clients.mjs';
import { decision, move, snapshot, square } from '../live/snapshots.mjs';

// Sparse positions make the tested move available immediately. Each proposal starts from a
// new full document. The timestamp is a Firestore timestamp on the wire, like an Arcade create.
const positions = {
  castle: ['r3k2r/8/8/8/8/8/8/R3K2R', 'b', 'KQkq', ''],
  throughCheck: ['4kr2/8/8/8/8/8/8/4K2R', 'w', 'K', ''],
  ep: ['4k3/8/8/3pP3/8/8/8/4K3', 'w', '', 'd6'],
  promotion: ['1r5k/P7/8/8/8/8/8/K7', 'w', '', ''],
  clearRay: ['8/8/7k/8/8/8/8/Q4K2', 'w', '', ''],
  blockedRay: ['8/8/7k/8/8/8/P7/Q4K2', 'w', '', ''],
  stalemate: ['7k/5K2/8/8/4Q3/8/8/8', 'w', '', ''],
};

function seed(native, key, host, guest) {
  const [fen, turn, castling, enPassant] = positions[key];
  const pieces = [...fen.replaceAll('/','')].flatMap(char => /\d/.test(char)
    ? Array(Number(char)).fill('') : [(char === char.toUpperCase() ? 'w' : 'b') + char.toLowerCase()]);
  assert.equal(pieces.length, 64);
  const board = Object.fromEntries(pieces.map((piece,i) => [square(i),piece]));
  return {...native.initialFields(), host,guest,currentTurn:turn === 'w' ? 'host':'guest',
    moveCount:16,status:'playing',winner:'',board,castling,enPassant,prevBoard:board,prevCastling:castling,prevEnPassant:enPassant};
}

const probes = [
  {id:'castle-black-queenside',p:'castle',uci:'e8c8'},
  {id:'castle-rook-arrival',p:'castle',uci:'e8c8',change:patch=>{patch.board.d8='';}},
  {id:'castle-attacked-transit',p:'throughCheck',uci:'e1g1',residual:true},
  {id:'capture-corner-rights',p:'castle',uci:'a8a1'},
  {id:'capture-retains-rights',p:'castle',uci:'a8a1',change:patch=>{patch.castling='KQkq';}},
  {id:'en-passant',p:'ep',uci:'e5d6'},
  {id:'en-passant-captured-pawn',p:'ep',uci:'e5d6',change:patch=>{patch.board.d5='bp';}},
  {id:'en-passant-expires',p:'ep',uci:'e5e6',change:patch=>{patch.enPassant='d6';}},
  {id:'underpromotion-capture',p:'promotion',uci:'a7b8n'},
  {id:'promotion-required',p:'promotion',uci:'a7a8',shape:false},
  {id:'long-clear-ray',p:'clearRay',uci:'a1a8'},
  {id:'long-blocked-ray',p:'blockedRay',uci:'a1a8',shape:false},
  {id:'stalemate',p:'stalemate',uci:'e4g6',outcome:'draw'},
  {id:'ongoing-vs-terminal',p:'clearRay',uci:'a1a8',residual:true,change:patch=>{patch.status='won';patch.winner='host';}},
];

export async function specialCases({mode,runId,writer,guest,reader,native,verify,journal}) {
  const rows = [];
  for (const c of probes) {
    const invalid = !!(c.change || c.residual || c.shape === false);
    if (invalid && (mode === 'stock' || mode === 'compatibility')) continue;
    if (c.residual && mode === 'stronger') continue;
    const beforeProof = await verify(), id = 'special-' + c.id;
    const path = 'chess/' + runId + '-' + id;
    const data = seed(native,c.p,writer.identity.uid,guest.identity.uid);
    await createDocument(path, {...wireFields(data), createdAt:{timestampValue:'2026-01-01T00:00:00Z'}});
    const initial = await snapshot(reader,path);
    assert.deepEqual(initial.data,{...data,createdAt:lite.Timestamp.fromMillis(Date.UTC(2026,0,1)).toJSON()});
    const patch = native.moveUpdate(initial.data,move(c.uci));
    if (c.outcome) assert.equal(patch.status,c.outcome,id);
    c.change?.(patch);
    const expected = mode === 'referee' || (mode === 'stronger' && !c.residual && (c.change || c.shape === false)) ? 'DENY' : 'ALLOW';
    const actor = data.currentTurn === 'host' ? writer : guest;
    assert.equal(actor.identity.uid,actor.auth.currentUser.uid);
    const observed = await decision(() => lite.updateDoc(lite.doc(actor.lite,path),patch));
    const stored = await snapshot(reader,path), end = await verify();
    const row = {id, actor:actor.identity.uid, expected, observed, before:[initial], after:[stored],
      probe:{position:c.p,uci:c.uci}, proposal:patch, proof:beforeProof, end};
    rows.push(row);
    journal.event('chess-attempt',row);
    assert.equal(observed,expected,id);
    if (observed === 'ALLOW') {
      assert.deepEqual(stored.data,{...initial.data,...patch},id);
      assert.notEqual(stored.version,initial.version,id);
    } else assert.deepEqual(stored,initial,id);
  }
  return rows;
}
