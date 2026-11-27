"""Challenge the three-step diagonal proof on blocked, shortened, extended and non-diagonal checks."""
import argparse
from collections import Counter
import gzip
from hashlib import sha256
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
REF=runpy.run_path(str(HERE.parents[1]/'chess/reference/generate.py'))


def eligible(c,board):
    king=board.king(board.turn)
    return any(board.piece_type_at(sq) in (c.BISHOP,c.QUEEN) and
               abs(c.square_file(king)-c.square_file(sq))==abs(c.square_rank(king)-c.square_rank(sq))==3
               for sq in board.checkers())


def alter(c,source,square):
    king=source.king(source.turn)
    x,y=c.square_file(king),c.square_rank(king)
    dx=(c.square_file(square)-x)//3
    dy=(c.square_rank(square)-y)//3
    def at(n):
        f,r=x+n*dx,y+n*dy
        return c.square(f,r) if 0<=f<8 and 0<=r<8 else None
    for distance in (1,2):
        block=source.copy(stack=False)
        block.set_piece_at(at(distance),c.Piece(c.KNIGHT,source.turn))
        yield f'friendly-blocker-{distance}',block
    rook=source.copy(stack=False)
    rook.set_piece_at(square,c.Piece(c.ROOK,not source.turn))
    yield 'rook-replaces-diagonal-checker',rook
    for distance in (1,2,4,5):
        cell=at(distance)
        if cell is None or source.piece_at(cell): continue
        moved=source.copy(stack=False)
        piece=moved.remove_piece_at(square);moved.set_piece_at(cell,piece)
        yield f'checker-at-distance-{distance}',moved


def run(sdk,rules,archive,panel):
    original=gzip.decompress((panel/'dense-boards.json.gz').read_bytes())
    freeze=json.loads((panel/'dense-freeze.json').read_bytes())
    assert sha256(original).hexdigest()==freeze['inputsAndNativeRepliesSha256']
    rows={}
    with tempfile.TemporaryDirectory(prefix='sliding-dense-negatives-') as temp:
        c=REF['load_chess'](archive,Path(temp))
        for row in json.loads(original):
            b=c.Board(row['fen'])
            assert eligible(c,b)
            for family,variant in alter(c,b,c.parse_square(row['checker'])):
                if not variant.is_valid() or eligible(c,variant): continue
                fen=REF['fen'](variant)
                rows.setdefault(fen,{'fen':fen,'family':family,'nativeInCheck':variant.is_check()})
    encoded=json.dumps(list(rows.values()),sort_keys=True,separators=(',',':')).encode()
    report=json.loads(subprocess.check_output(['bun','--no-install',HERE/'dense-geometry.mjs',sdk,rules],input=encoded))
    assert report['boards']==len(rows) and report['inputsSha256']==sha256(encoded).hexdigest()
    assert report['rulesSha256']==sha256(rules.read_bytes()).hexdigest()
    return {'authority':'independent native attack geometry and the pinned local Rules evaluator',
            'sourceSha256':REF['PIN'],'positiveParentInputsSha256':sha256(original).hexdigest(),
            'geometryFamilies':dict(Counter(r['family'] for r in rows.values())),
            'nativeInCheck':sum(r['nativeInCheck'] for r in rows.values()),**report}


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('pinned_sdk',type=Path);p.add_argument('complete_rules',type=Path)
    p.add_argument('python_chess_archive',type=Path);p.add_argument('--panel',type=Path,default=HERE.parent/'protocol')
    a=p.parse_args();r=run(a.pinned_sdk,a.complete_rules,a.python_chess_archive,a.panel);print(json.dumps(r,indent=2))
    sys.exit(bool(r['incorrectTriggers'] or r['evaluationErrors']))
