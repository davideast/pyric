"""Freeze real precursor moves leading to knight checks, pawn checks and quiet positions."""
import argparse
from collections import Counter
import gzip
from hashlib import sha256
import json
from pathlib import Path
import random
import runpy
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
helpers = runpy.run_path(str(HERE.parent/'panel/generate.py'))
SEED = 73287
COUNT = 6


def prior(c, after, square, rng):
    moving = after.piece_at(square)
    if moving.piece_type != c.PAWN:
        return helpers['predecessor'](c,after,square,rng)
    src = square + (-8 if moving.color else 8)
    if not 0 <= src < 64 or after.piece_at(src):
        return None
    before = after.copy(stack=False)
    before.remove_piece_at(square)
    before.set_piece_at(src,moving)
    before.turn = moving.color
    move = c.Move(src,square)
    if before.is_valid() and before.is_legal(move):
        return before,move


def positions(c):
    rng = random.Random(SEED)
    seen = set()
    for kind in ('quiet','pawn','knight'):
        for side in (c.WHITE,c.BLACK):
            for defender in (c.ROOK,c.BISHOP,c.QUEEN):
                for extra in ('none','defender-pawn','attacker'):
                    counts = Counter()
                    for attempt in range(100000):
                        if counts[True] == COUNT and (kind == 'quiet' or counts[False] == COUNT):
                            break
                        end = c.Board(None)
                        end.turn = side
                        king = rng.choice(c.SQUARES)
                        mover = rng.choice([c.ROOK,c.BISHOP,c.QUEEN,c.KNIGHT]) if kind=='quiet' else c.PAWN if kind=='pawn' else c.KNIGHT
                        if kind=='quiet':
                            square = rng.choice([sq for sq in c.SQUARES if sq!=king])
                        else:
                            mask = c.BB_KNIGHT_ATTACKS[king] if kind=='knight' else c.BB_PAWN_ATTACKS[side][king]
                            cells = list(c.scan_forward(mask))
                            if not cells: continue
                            square = rng.choice(cells)
                        end.set_piece_at(king,c.Piece(c.KING,side))
                        end.set_piece_at(square,c.Piece(mover,not side))
                        cells = rng.sample([sq for sq in c.SQUARES if sq not in (king,square)],3)
                        end.set_piece_at(cells[0],c.Piece(c.KING,not side))
                        end.set_piece_at(cells[1],c.Piece(defender,side))
                        if extra=='defender-pawn': end.set_piece_at(cells[2],c.Piece(c.PAWN,side))
                        if extra=='attacker': end.set_piece_at(cells[2],c.Piece(rng.choice([c.ROOK,c.BISHOP,c.QUEEN,c.KNIGHT,c.PAWN]),not side))
                        if not end.is_valid() or end.is_check()!=(kind!='quiet'): continue
                        if kind!='quiet' and set(end.checkers())!={square}: continue
                        has_slider = any(end.piece_type_at(m.from_square) in (c.ROOK,c.BISHOP,c.QUEEN) for m in end.legal_moves)
                        if counts[has_slider]>=COUNT or (kind=='quiet' and not has_slider): continue
                        key = helpers['REF']['fen'](end)
                        if key in seen: continue
                        original = prior(c,end,square,rng)
                        if not original: continue
                        name = f"other-{kind}-{'w' if side else 'b'}-{c.piece_symbol(defender)}-{extra}-{int(has_slider)}-{counts[has_slider]}"
                        row = helpers['describe'](c,*original,name,kind,require_check=kind!='quiet')
                        assert row and row['successor']==key
                        row['features'].append(kind)
                        seen.add(key)
                        counts[has_slider]+=1
                        yield row
                    else:
                        raise ValueError((kind,side,defender,extra,counts))

def special(c):
    # Nonchecking turns whose slider is immobilized by a pin or by friendly
    # material, plus matching positions where the slider really has a reply.
    examples = [
        ('diagonal-pin-rook', {'a1':'K','c3':'R','f8':'k','d5':'q'}, 'd5d4', False),
        ('file-pin-bishop', {'a1':'K','a3':'B','h7':'k','b6':'r'}, 'b6a6', False),
        ('rank-pin-rook', {'a1':'K','c1':'R','f8':'k','f2':'r'}, 'f2f1', True),
        ('diagonal-pin-queen', {'a1':'K','c3':'Q','h6':'k','d5':'q'}, 'd5d4', True),
        ('corner-own-pawn', {'a1':'B','c1':'K','b2':'P','g5':'k','h4':'n'}, 'h4f5', False),
        ('corner-own-king-and-pawn', {'a8':'R','b8':'K','a7':'P','g5':'k','h4':'n'}, 'h4f5', False),
    ]
    for name,pieces,uci,has_slider in examples:
        base = c.Board(None)
        base.turn = c.BLACK
        for square,piece in pieces.items():
            base.set_piece_at(c.parse_square(square),c.Piece.from_symbol(piece))
        for swap in (False,True):
            for reflect in (False,True):
                before=base.mirror() if swap else base.copy(stack=False)
                if reflect: before=before.transform(c.flip_horizontal)
                def square(value):
                    file,rank=c.square_file(value),c.square_rank(value)
                    return c.square(7-file if reflect else file,7-rank if swap else rank)
                raw=c.Move.from_uci(uci)
                move=c.Move(square(raw.from_square),square(raw.to_square))
                key=f"quiet-{name}-swap{int(swap)}-reflect{int(reflect)}"
                row=helpers['describe'](c,before,move,key,'quiet-targeted',require_check=False)
                assert row and bool(row['sliderReplies'])==has_slider,(key,before.fen(),move.uci())
                row['features'].extend(['quiet','targeted'])
                yield row


def freeze(archive,create):
    with tempfile.TemporaryDirectory(prefix='slider-other-turns-') as temp:
        engine = helpers['REF']['load_chess'](archive,Path(temp))
        rows = [*positions(engine),*special(engine)]
    encoded = helpers['stable'](rows)
    record = {'sourceSha256':helpers['REF']['PIN'],'seed':SEED,'samplesPerStratum':COUNT,
              'boards':len(rows),'uniqueSuccessors':len({row['successor'] for row in rows}),
              'families':dict(Counter(row['family'] for row in rows)),
              'features':dict(sorted(Counter(f for row in rows for f in row['features']).items())),
              'inputsAndRepliesSha256':sha256(encoded).hexdigest()}
    packed=HERE/'boards.json.gz'
    meta=HERE/'freeze.json'
    if create:
        with packed.open('xb') as f: f.write(gzip.compress(encoded,compresslevel=9,mtime=0))
        with meta.open('x') as f: f.write(json.dumps(record,indent=2)+'\n')
    assert gzip.decompress(packed.read_bytes())==encoded and json.loads(meta.read_bytes())==record
    return record


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive',type=Path)
    parser.add_argument('--create',action='store_true')
    args=parser.parse_args()
    print(json.dumps(freeze(args.archive,args.create),indent=2))
