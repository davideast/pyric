export const stamp = '2026-01-01T00:00:00Z';
const clearCastle = 'k7/8/8/8/8/8/8/4K2R w K -';
const attackedCastle = 'k4r2/8/8/8/8/8/8/4K2R w K -';
const clearEp = '4k3/8/8/5pPK/8/8/8/8 w - f6';
const exposedEp = '4k3/8/8/r4pPK/8/8/8/8 w - f6';
const lifecycle = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
export const boundaryCases = [
  {id:'signed-out',role:null,fen:clearCastle,uci:'e1g1',ply:16,status:401,requirement:'identity'},
  {id:'wrong-seat',role:'guest',fen:clearCastle,uci:'e1g1',ply:16,status:409,requirement:'currentTurn'},
  {id:'stale-ply',role:'host',fen:clearCastle,uci:'e1g1',ply:15,status:409,requirement:'matchVersion'},
  {id:'castle-through-check',role:'host',fen:attackedCastle,uci:'e1g1',ply:16,status:409,requirement:'legalMove'},
  {id:'castle-clear',role:'host',fen:clearCastle,uci:'e1g1',ply:16,status:200,requirement:'committed'},
  {id:'ep-exposes-king',role:'host',fen:exposedEp,uci:'g5f6',ply:16,status:409,requirement:'legalMove'},
  {id:'ep-clear',role:'host',fen:clearEp,uci:'g5f6',ply:16,status:200,requirement:'committed'},
  {id:'occupied-seat-join',role:'guest',fen:lifecycle},
  {id:'wrong-resign-winner',role:'guest',fen:lifecycle},
  {id:'unfinished-parent-rematch',role:'host',fen:lifecycle},
];

export function waiting(native,host) {
  return {...native.initialFields(),host,guest:'',currentTurn:'host',status:'waiting',winner:'',moveCount:0};
}

export function boundarySeed(c,native,identities) {
  const [squares,side,flags,ep] = c.fen.split(' ');
  const pieces = [...squares.replaceAll('/','')].flatMap(p => /[1-8]/.test(p)
    ? Array(Number(p)).fill('') : [(p === p.toUpperCase() ? 'w' : 'b') + p.toLowerCase()]);
  if (pieces.length !== 64 || side !== 'w') throw Error('Invalid boundary fixture');
  const board = Object.fromEntries(pieces.map((piece,i) => ['abcdefgh'[i % 8]+(8-Math.floor(i/8)),piece]));
  const castling = flags === '-' ? '' : flags, enPassant = ep === '-' ? '' : ep;
  return {...waiting(native,identities.host),guest:c.id === 'occupied-seat-join' ? identities.reader : identities.guest,
    status:'playing',moveCount:16,board,prevBoard:board,castling,prevCastling:castling,enPassant,prevEnPassant:enPassant};
}

export function lifecycleOperations(c,matchId,native,identities) {
  const path = 'chess/'+matchId;
  if (c.id === 'occupied-seat-join') return [{op:'update',path,data:{guest:identities.guest,status:'playing'}}];
  if (c.id === 'wrong-resign-winner') return [{op:'update',path,data:{status:'resigned',winner:'guest'}}];
  if (c.id !== 'unfinished-parent-rematch') throw Error('Unknown lifecycle case');
  return [
    {op:'set',path:path+'-next',data:{...waiting(native,identities.host),rematchOf:matchId},serverTimestamp:['createdAt']},
    {op:'set',path:'rematches/chess/matches/'+matchId,data:{game:'chess',match:matchId+'-next',by:identities.host}},
  ];
}
