import assert from 'node:assert/strict';
import {linkKingProjections} from './king.mjs';

function replaceOnce(source, original, replacement) {
  assert.equal(source.split(original).length, 2, original.slice(0,100));
  return source.replace(original, () => replacement);
}

// The proposal's from/to and any EP/castling extras are read on both boards.
// Every other key is protected by affectedKeys().hasOnly(...). The two facts
// jointly imply exact key-set equality, including for unusual prior boards.
export function lowerProtocol(source,variant) {
  source=replaceOnce(source,'next.board.keys().toSet() == old.board.keys().toSet() && ','');
  const prior="old.castling == '' || kind != 'k' && !(fromSquare in ['a1', 'a8', 'h1', 'h8']) && !(toSquare in ['a1', 'a8', 'h1', 'h8']) && old.castling.matches('K?Q?k?q?') ? next.castling == old.castling : next.castling == (old.castling.matches('K?Q?k?q?') ? castle ? old.castling.replace(color == 'w' ? '[KQ]' : '[kq]', '') : _games_chess_chess_helpers__dropRights(old.castling, piece, fromSquare, toSquare) : keptRights(old.castling, piece, fromSquare, toSquare))";
  const canonical="old.castling == '' ? next.castling == '' : next.castling == (old.castling.matches('K?Q?k?q?') ? _games_chess_chess_helpers__dropRights(old.castling, piece, fromSquare, toSquare) : keptRights(old.castling, piece, fromSquare, toSquare))";
  const explicitCastle=['all-minors-v9','all-shared-rays-v10','all-projected-king-v11'].includes(variant) ? canonical.replace('? _games_chess_chess_helpers__dropRights',"? castle ? old.castling.replace(color == 'w' ? '[KQ]' : '[kq]', '') : _games_chess_chess_helpers__dropRights") : canonical;
  source=replaceOnce(source,prior,explicitCastle);
  const original='boardTransition(old, next, mv, piece, color, fromSquare, toSquare) && old.status';
  const dispatch="(piece.matches('[wb][rbq]') && old.castling == '' && (fromSquare + toSquare).matches('[a-h][1-8][a-h][1-8]') && next.board.values().hasOnly(',wp,wn,wb,wr,wq,wk,bp,bn,bb,br,bq,bk'.split(',')) ? orderedSliderTransition(next, mv, piece, color, fromSquare, toSquare) : boardTransition(old, next, mv, piece, color, fromSquare, toSquare)) && old.status";
  source=replaceOnce(source,original,!['all-packed-path-v5','all-tabled-path-v6'].includes(variant) ? dispatch.replace(" && old.castling == ''",'').replace("(fromSquare + toSquare).matches('[a-h][1-8][a-h][1-8]')","fromSquare.matches('[a-h][1-8]') && toSquare.matches('[a-h][1-8]')").replace('orderedSliderTransition(next','orderedSliderTransition(old,next') : dispatch);
  const coordinate="return {'a': 0, 'b': 1, 'c': 2, 'd': 3, 'e': 4, 'f': 5, 'g': 6, 'h': 7}[file];";
  // split() accepts a regular expression. Validate the lookup key first; an
  // invalid key deliberately indexes the empty map, retaining Rules error semantics.
  source=replaceOnce(source,coordinate,"return file.matches('[a-h]') ? 'abcdefgh'.split(file)[0].size() : {}[file];");
  return variant==='all-projected-king-v11' ? linkKingProjections(source) : source;
}

export function protocolBinding(variant) {
  const fn=`function orderedSliderTransition(next,mv,piece,color,fromSquare,toSquare) {
    let x = 'abcdefgh'.split(fromSquare[0:1])[0].size();
    let y = int(fromSquare[1:2])-1;
    let xt = 'abcdefgh'.split(toSquare[0:1])[0].size();
    let yt = int(toSquare[1:2])-1;
    let text = packNormal(next.board);
    return mv.extra == [] && next.enPassant=='' && next.castling=='' &&
      sliderTravel(text,piece[1:2],x,y,xt,yt) && packedSafe(text,color) && admittedStatus(text,color,next.status);
  }`;
  return !['all-packed-path-v5','all-tabled-path-v6'].includes(variant) ? fn.replace('orderedSliderTransition(next','orderedSliderTransition(old,next')
    .replace("next.castling==''", "(old.castling=='' ? next.castling=='' : next.castling==(old.castling.matches('K?Q?k?q?') ? _games_chess_chess_helpers__dropRights(old.castling,piece,fromSquare,toSquare) : keptRights(old.castling,piece,fromSquare,toSquare)))") : fn;
}

export function protocolSources(variant) {
  // After the original and proposed board difference is constrained to from
  // and to, interior cells of a normal slider move are identical on both boards.
  return {
    sliderTravel: `function sliderTravel(text,kind,x,y,xt,yt) {
      let dx=xt-x;
      let dy=yt-y;
      let straight=dx==0 || dy==0;
      let delta=dy==0 ? dx : dy;
      let length=delta<0 ? -delta : delta;
      let lo=delta<0 ? xt+10*yt : x+10*y;
      let step=dy==0 ? '' : dx==0 ? '(?:[^,]*,){9}' : dx==dy ? '(?:[^,]*,){10}' : '(?:[^,]*,){8}';
      return (straight ? kind!='b' : kind!='r' && (dx==dy || dx+dy==0)) &&
        (length==1 || text.matches('(?:[^,]*,){'+'0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80'.split(',')[lo+1]+'}(?:'+step+',){'+'0,1,2,3,4,5,6,7'.split(',')[length-1]+'}.*'));
    }`,
    ...(variant!=='all-packed-path-v5' ? {slideMayClaim: `function slideMayClaim(status,checkDirection) {
      return status=='playing' || ((checkDirection==0) == (status=='draw'));
    }`} : {}),
    slideClaim: `function slideClaim(status,hasReply) {
      return (status=='playing') == hasReply;
    }`,
  };
}
