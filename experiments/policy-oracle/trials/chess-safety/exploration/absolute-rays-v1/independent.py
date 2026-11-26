"""Verify every starting position, knight jump, result and hypothetical successor with python-chess."""
import gzip
import hashlib
import json
from pathlib import Path
import runpy
import sys
import tempfile

sys.dont_write_bytecode = True
here = Path(__file__).resolve().parent
ref = runpy.run_path(str(here.parents[2] / 'chess/reference/generate.py'))
with tempfile.TemporaryDirectory(prefix='ray-referee-') as temp:
    chess = ref['load_chess'](Path(sys.argv[1]),Path(temp))
    payload = gzip.decompress((here/'corpus.json.gz').read_bytes())
    frozen = json.loads((here/'freeze.json').read_bytes())
    assert hashlib.sha256(payload).hexdigest() == frozen['inputsSha256']
    cases = json.loads(payload)
    pinned = safe = 0
    for row in cases:
        board = chess.Board(row['fen'])
        assert board.is_valid(), row['id']
        move = chess.Move.from_uci(row['uci'])
        assert board.is_pseudo_legal(move), row['id']
        assert board.is_legal(move) == row['nativeAdmission'], row['id']
        assert board.is_pinned(board.turn, move.from_square) != row['nativeAdmission'], row['id']
        board.push(move)
        assert ref['fen'](board) == row['successor'], row['id']
        if row['nativeAdmission']:
            safe += 1
        else:
            pinned += 1
    assert safe == pinned == frozen['pairs']
    print(json.dumps({'authority':'pinned python-chess', 'inputsSha256':frozen['inputsSha256'],
                      'sourceValid':len(cases), 'successors':len(cases), 'safe':safe, 'pinned':pinned},indent=2))
