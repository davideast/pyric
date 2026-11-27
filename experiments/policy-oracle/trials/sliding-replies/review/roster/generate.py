"""Freeze second-rook and knight-only controls independently of the candidate Rules."""
import argparse
import gzip
from hashlib import sha256
import json
from pathlib import Path
import runpy
import sys
import tempfile
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
helpers=runpy.run_path(str(HERE.parent/'panel/generate.py'))
SOURCE=[
    ('slider-and-knight-only-evasion','k7/8/Kn6/7r/6Q1/8/8/8 w - -','g4g8','knight'),
    ('sole-knight-only-evasion','k7/8/Kn6/8/6Q1/8/8/8 w - -','g4g8','knight'),
    ('sole-knight-stalemate','kn6/2R5/1K6/8/8/8/8/8 w - -','c7c8','stalemate'),
    ('sole-knight-quiet-escape','kn6/7R/1K6/8/8/8/8/8 w - -','h7h6','quiet'),
    ('extra-knight-excluded','k7/8/Kn3n2/7r/6Q1/8/8/8 w - -','g4g8','excluded'),
]
panel=json.loads(gzip.decompress((HERE.parent/'panel/boards.json.gz').read_bytes()))
for source,identifier in [('only-second-rook','sample-w-edge-q-r-defender-1-0'),('two-rook-origins','sample-w-corner-b-r-defender-1-0')]:
    one,=[row for row in panel if row['id']==identifier]
    SOURCE.append((source,one['fen'],one['uci'],source))


def freeze(archive,create):
    rows=[]
    with tempfile.TemporaryDirectory(prefix='slide-roster-') as temp:
        c=helpers['REF']['load_chess'](archive,Path(temp))
        for name,fen,uci,kind in SOURCE:
            for swap in (False,True):
                before=c.Board(fen)
                unflipped=c.Move.from_uci(uci)
                move=unflipped
                if swap:
                    before=before.mirror()
                    move=c.Move(c.square_mirror(unflipped.from_square),c.square_mirror(unflipped.to_square))
                b=before.copy(stack=False);b.push(move)
                row=helpers['describe'](c,before,move,name+('-mirrored' if swap else ''),kind,require_check=b.is_check())
                assert row,(name,before.fen(),move)
                if kind=='knight':
                    assert row['sliderReplies']==[] and len(row['replies'])==1
                    assert all(b.piece_type_at(r.from_square)==c.KNIGHT for r in b.legal_moves)
                if kind=='stalemate': assert b.is_stalemate()
                if kind=='quiet': assert row['replies'] and all(b.piece_type_at(r.from_square)==c.KNIGHT for r in b.legal_moves)
                if kind=='only-second-rook':
                    assert len(row['sliderReplies'])==1
                    if not swap: assert row['sliderReplies']==['d4g4']
                if kind=='two-rook-origins': assert len({m[:2] for m in row['sliderReplies']})==2
                if kind=='excluded': assert row['defenderMaterial']=='nnr'
                row['status']='won' if b.is_checkmate() else 'draw' if b.is_stalemate() else 'playing'
                rows.append(row)
    encoded=helpers['stable'](rows)
    record={'sourceSha256':helpers['REF']['PIN'],'inputsAndRepliesSha256':sha256(encoded).hexdigest(),
            'boards':len(rows),'catalog':'two original panel positions and five separately authored positions, each color-mirrored'}
    if create:
        with (HERE/'boards.json').open('xb') as f:f.write(encoded+b'\n')
        with (HERE/'freeze.json').open('x') as f:f.write(json.dumps(record,indent=2)+'\n')
    assert (HERE/'boards.json').read_bytes()==encoded+b'\n' and json.loads((HERE/'freeze.json').read_bytes())==record
    return record


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('archive',type=Path);p.add_argument('--create',action='store_true')
    a=p.parse_args();print(json.dumps(freeze(a.archive,a.create),indent=2))
