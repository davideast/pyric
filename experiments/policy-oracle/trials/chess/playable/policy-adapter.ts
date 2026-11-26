import { legalMoves as policyMoves, inCheck } from './policy.mjs';
import { squareOf, type Position, type Move } from './chess.ts';
export { inCheck };
export function legalMoves(position: Position): Move[] {
  const moves: Move[] = policyMoves(position).map((uci: string) => ({
    from: squareOf(uci.slice(0, 2)), to: squareOf(uci.slice(2, 4)),
    ...(uci[4] ? { promotion: uci[4] as Move['promotion'] } : {}),
  }));
  const order = 'qrbn';
  return moves.sort((a,b) => a.from - b.from || a.to - b.to ||
    order.indexOf(a.promotion ?? '') - order.indexOf(b.promotion ?? ''));
}
