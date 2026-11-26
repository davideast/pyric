export const fen = '7k/7p/8/8/2B5/8/8/R3K1N1 w - -';
export const isoTime = '2026-01-01T00:00:00Z';
const legal = {stock:'ALLOW', compatibility:'ALLOW', stronger:'ALLOW'};
const protocol = {stock:'DENY', compatibility:'DENY', stronger:'DENY'};
const geometry = {stronger:'DENY'};

// The first four cases are also the positive writes paired with the geometry and metadata controls.
export const cases = [
  {id:'knight', uci:'g1f3', expected:legal}, {id:'bishop', uci:'c4d5', expected:legal},
  {id:'king', uci:'e1f2', expected:legal}, {id:'rook', uci:'a1a5', expected:legal},
  {id:'knight-shape', uci:'g1g3', expected:geometry}, {id:'bishop-shape', uci:'c4c6', expected:geometry},
  {id:'king-shape', uci:'e1e3', expected:geometry}, {id:'rook-shape', uci:'a1b2', expected:geometry},
  {id:'retain-turn', field:'currentTurn', expected:protocol},
  {id:'previous-board', field:'prevBoard', expected:protocol},
  {id:'previous-rights', field:'prevCastling', expected:protocol},
  {id:'previous-ep', field:'prevEnPassant', expected:protocol},
  {id:'retained-source', field:'board.g1', expected:protocol},
  {id:'wrong-destination', field:'board.f3', expected:protocol},
  {id:'unrelated-square', field:'board.a1', expected:protocol},
  {id:'protected-guest', field:'guest', expected:protocol},
  {id:'last-move-extra', field:'lastMove.extra', expected:protocol},
  {id:'ongoing-winner', field:'winner', expected:protocol},
  {id:'wrong-color', uci:'h7h6', expected:protocol},
];

export function initial(native, host, guest) {
  const board = Object.fromEntries(Object.keys(native.initialFields().board).map(k => [k,'']));
  Object.assign(board,{h8:'bk',h7:'bp',c4:'wb',a1:'wr',e1:'wk',g1:'wn'});
  return {...native.initialFields(), board, prevBoard:board, host, guest, currentTurn:'host', status:'playing',
    winner:'', moveCount:16, castling:'', prevCastling:'', enPassant:'', prevEnPassant:''};
}

export function proposal(native, before, c) {
  const uci = c.uci ?? 'g1f3';
  const idx = sq => (8 - Number(sq[1])) * 8 + 'abcdefgh'.indexOf(sq[0]);
  const patch = native.moveUpdate(before, {from:idx(uci.slice(0,2)), to:idx(uci.slice(2,4))});
  switch (c.field) {
    case 'currentTurn': patch.currentTurn = 'host'; break;
    case 'prevBoard': patch.prevBoard = {...before.board,c4:''}; break;
    case 'prevCastling': patch.prevCastling = 'K'; break;
    case 'prevEnPassant': patch.prevEnPassant = 'e3'; break;
    case 'board.g1': patch.board.g1 = 'wn'; break;
    case 'board.f3': patch.board.f3 = 'wb'; break;
    case 'board.a1': patch.board.a1 = ''; break;
    case 'guest': patch.guest = ''; break;
    case 'lastMove.extra': patch.lastMove.extra = ['b3']; break;
    case 'winner': patch.winner = 'host'; break;
  }
  return patch;
}
