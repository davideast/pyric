import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {sha} from '../../../arcade/corpus.mjs';
import {sample} from '../../king-safety/reference/fixtures.mjs';

const [reference,...paths]=process.argv.slice(2);
assert.ok(reference && paths.length);
const {firestoreRules}=await import(pathToFileURL(resolve(reference,'dist/index.js')));
const baseline=readFileSync(new URL('../../chess/bundle/artifacts/stronger.rules',import.meta.url),'utf8');
assert.equal(sha(baseline),'523c4c137aa00c2c764264aa6c2cefeda7c692561544da45d4fcccf3a2056fda');
const names=paths.map(p=>sha(readFileSync(p)));
const handles=[baseline,...paths.map(p=>readFileSync(p,'utf8'))].map(s=>firestoreRules(s));
const cases=[];

function add(id,expected,edit=()=>{},seed={fen:'4k3/8/8/8/8/8/4P3/4K3 w - -',uci:'e2e3'}) {
  const {before,proposal}=sample(seed,'writer','other');
  const row={description:id,path:'chess/match',method:'update',resource:structuredClone(before),
    data:structuredClone({...before,...proposal}),auth:{uid:'writer'},expectation:expected};
  edit(row);
  const observations=handles.map(h=>{
    const [r]=h.simulate([row]).cases;
    assert.ok(!r.resourceLimit&&!r.unsupported,id);
    assert.equal(r.decision,expected,id);
    return {decision:r.decision,evaluationError:r.trace.some(t=>t.verdict==='ERROR')};
  });
  cases.push({id,expected,observations});
}
const allow=(id,edit,seed)=>add(id,'ALLOW',edit,seed);
const deny=(id,edit,seed)=>add(id,'DENY',edit,seed);
allow('ordinary-white-move');
allow('ordinary-black-move',undefined,{fen:'4k3/4p3/8/8/8/8/8/4K3 b - -',uci:'e7e6'});
deny('signed-out',r=>{r.auth=null;});
deny('wrong-seat',r=>{r.auth.uid='other';});
deny('nonparticipant',r=>{r.auth.uid='spectator';});
deny('unknown-current-turn',r=>{r.resource.currentTurn='unassigned';});
deny('retained-turn',r=>{r.data.currentTurn=r.resource.currentTurn;});
deny('wrong-ply',r=>{r.data.moveCount+=1;});
deny('wrong-previous-board',r=>{r.data.prevBoard.a1='wn';});
deny('wrong-previous-rights',r=>{r.data.prevCastling='K';});
deny('wrong-previous-ep',r=>{r.data.prevEnPassant='e3';});
deny('rewrite-host',r=>{r.data.host='other';});
deny('rewrite-guest',r=>{r.data.guest='writer';});
deny('rewrite-created-at',r=>{delete r.data.createdAt;});
deny('unrelated-document-field',r=>{r.data.extra='value';});
deny('illegal-en-passant-claim',r=>{r.data.enPassant='e4';});
deny('impossible-rights',r=>{r.data.castling='K';});
deny('unknown-move-field',r=>{r.data.lastMove.other=true;});
deny('missing-move-from',r=>{delete r.data.lastMove.from;});
deny('missing-move-to',r=>{delete r.data.lastMove.to;});
deny('missing-move-extra',r=>{delete r.data.lastMove.extra;});
deny('missing-move-promotion',r=>{delete r.data.lastMove.promotion;});
deny('extra-touched-square',r=>{r.data.board.a1='wn';});
deny('source-not-vacated',r=>{r.data.board.e2='wp';});
deny('wrong-arriving-piece',r=>{r.data.board.e3='wq';});
deny('extra-board-key',r=>{r.data.board.i1='';});
deny('missing-board-key',r=>{delete r.data.board.a1;});
deny('same-map-cardinality-different-key',r=>{delete r.data.board.a1;r.data.board.i1='';});
allow('reordered-board-map',r=>{r.data.board=Object.fromEntries(Object.entries(r.data.board).reverse());});
deny('missing-board',r=>{delete r.data.board;});
deny('winner-on-ongoing',r=>{r.data.winner='host';});
deny('wrong-winning-seat',r=>{r.data.status='won';r.data.winner='guest';});
allow('canonical-rights-retained',r=>{r.resource.castling='Kq';r.data.prevCastling='Kq';r.data.castling='Kq';});
allow('noncanonical-stored-rights-normalized',r=>{r.resource.castling='qK';r.data.prevCastling='qK';r.data.castling='Kq';});
deny('noncanonical-rights-copied-verbatim',r=>{r.resource.castling='qK';r.data.prevCastling='qK';r.data.castling='qK';});
console.log(JSON.stringify({authority:'pinned local complete rules; signed write projections',rules:[sha(baseline),...names],cases},null,2));
