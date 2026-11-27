"""Freeze and independently re-adjudicate post-move boards for the dense diagonal proof."""
import argparse
from collections import Counter
import gzip
import hashlib
import json
from pathlib import Path
import random
import runpy
import tempfile

HERE=Path(__file__).resolve().parent
REF=runpy.run_path(str(HERE.parents[1]/'chess/reference/generate.py'))
SEED=27031

def boards(chess):
    rng=random.Random(SEED)
    seen=set()
    while len(seen)<2400:
        board=chess.Board(None)
        board.turn=rng.choice((chess.WHITE,chess.BLACK))
        side=board.turn
        king=rng.randrange(64)
        x,y=chess.square_file(king),chess.square_rank(king)
        dx,dy=rng.choice((-1,1)),rng.choice((-1,1))
        if not (0<=x+3*dx<8 and 0<=y+3*dy<8): continue
        checker=chess.square(x+3*dx,y+3*dy)
        ray={king,checker,*[chess.square(x+n*dx,y+n*dy) for n in (1,2)]}
        board.set_piece_at(king,chess.Piece(chess.KING,side))
        board.set_piece_at(checker,chess.Piece(rng.choice((chess.BISHOP,chess.QUEEN)),not side))
        empty=list(sorted(set(chess.SQUARES)-ray))
        rng.shuffle(empty)
        board.set_piece_at(empty.pop(),chess.Piece(chess.KING,not side))
        pieces=[(chess.PAWN,side),(chess.PAWN,side)]
        for _ in range(rng.randrange(0,18)):
            pieces.append((rng.choice((1,1,2,3,4,5)),rng.choice((side,not side))))
        for piece,color in pieces:
            if not empty: break
            square=empty.pop()
            if piece==chess.PAWN and chess.square_rank(square) in (0,7): break
            board.set_piece_at(square,chess.Piece(piece,color))
        if len(board.pieces(chess.PAWN,side))<2 or not board.is_valid() or checker not in board.checkers(): continue
        fen=REF['fen'](board)
        if fen in seen: continue
        seen.add(fen)
        replies=sorted(move.uci() for move in board.legal_moves)
        nonking=[m for m in replies if chess.parse_square(m[:2])!=king]
        yield {'fen':fen,'checker':chess.square_name(checker),'replies':replies,'nonking':nonking}

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('archive',type=Path)
    p.add_argument('--record',action='store_true')
    args=p.parse_args()
    with tempfile.TemporaryDirectory(prefix='diagonal-replies-native-') as temp:
        chess=REF['load_chess'](args.archive,Path(temp))
        rows=list(boards(chess))
    raw=json.dumps(rows,separators=(',',':')).encode()
    compressed=gzip.compress(raw,mtime=0)
    target=HERE/'dense-boards.json.gz'
    if args.record:
        with target.open('xb') as f:f.write(compressed)
    assert gzip.decompress(target.read_bytes())==raw
    print(json.dumps({'seed':SEED,'boards':len(rows),'inputsAndNativeRepliesSha256':hashlib.sha256(raw).hexdigest(),
                      'nativeSourceSha256':REF['PIN'],'boardsWithNonkingReply':sum(bool(r['nonking']) for r in rows),
                      'checkmates':sum(not r['replies'] for r in rows)}))

if __name__=='__main__':main()
