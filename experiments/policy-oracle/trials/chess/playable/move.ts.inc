import { squareName } from './chess.ts';
export async function moveChess({auth}: Connection, id: string, move: Move, ply: number): Promise<void> {
  const user = auth.currentUser;
  if (!user) throw new Error('No active match.');
  const response = await fetch('/move', {
    method: 'POST', headers: {Authorization: 'Bearer ' + await user.getIdToken(), 'Content-Type': 'application/json'},
    body: JSON.stringify({id, ply, uci: squareName(move.from) + squareName(move.to) + (move.promotion ?? '')}),
  });
  if (!response.ok) throw new Error((await response.json()).requirement);
}
