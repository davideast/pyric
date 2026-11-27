// In a file check, neither rook can interpose or capture when both rooks are
// outside every checked rank and neither shares the king's file.
import assert from 'node:assert/strict';
export const fileCheckSources={
  rooksOutsideFileCheck:`function rooksOutsideFileCheck(board) {
    let remaining=board.replace('[^#]*(?:K.{9}(?:,.{9})*[rq]|[rq].{9}(?:,.{9})*K)[^#]*','');
    return remaining!=board && remaining.matches('.*S.*S.*')
      && !board.matches('.*(?:K.{9}(?:.{10})*S|S.{9}(?:.{10})*K).*');
  }`,
};
export function skipImpossibleSecondRook(source) {
  const old='return first>=0 || !two ? first : slideOne(';
  assert.equal(source.split(old).length,2);
  return source.replace(old,'return first>=0 || !two || (direction==2 && rooksOutsideFileCheck(board)) ? first : slideOne(');
}
