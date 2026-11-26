"""Judge archived authenticated chess proposals independently from the SDK's write decision."""
import argparse
from collections import Counter
import gzip
from hashlib import sha256
import json
from pathlib import Path
import re
import runpy
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
from replay import native_replay

external = runpy.run_path(str(HERE.parent/'chess/reference/generate.py'))


def hash_json(value):
    return sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def input_rows(digest):
    """The referee receives only the signed actor, previous match and proposed patch."""
    for record in sorted((HERE/'live/receipts'/digest).glob('*.json.gz')):
        data = record.read_bytes()
        pin = json.loads(record.with_suffix('').with_suffix('.pin.json').read_bytes())
        if sha256(data).hexdigest()!=pin['receiptGzipSha256']:
            raise ValueError(f'Archived signed submissions changed for {record.name}')
        receipt = json.loads(gzip.decompress(data))
        if receipt['rulesSha256']!=digest or receipt['privateReceipt']!=pin['controllerSha256']:
            raise ValueError(f'Unexpected source identity for {record.name}')
        for item in receipt['rows']:
            assert len(item['before'])==len(item['submitted'])==1
            patch=item['submitted'][0]
            assert patch['op']=='update' and patch['path']==item['before'][0]['path']
            yield item['id'], item['actor'], item['before'][0]['data'], patch['data']


def board_from_doc(chess,match):
    board=chess.Board.empty()
    assert set(match['board'])==set(chess.SQUARE_NAMES)
    for name,value in match['board'].items():
        if value:
            color,piece=value
            board.set_piece_at(chess.parse_square(name),chess.Piece.from_symbol(piece.upper() if color=='w' else piece))
    board.turn=match['currentTurn']=='host'
    board.set_castling_fen(match['castling'] or '-')
    board.ep_square=chess.parse_square(match['enPassant']) if match['enPassant'] else None
    return board


def adjudicate(chess,actor,before,patch):
    board=board_from_doc(chess,before)
    source_valid=board.is_valid()
    move_fields=patch['lastMove']
    move=chess.Move.from_uci(move_fields['from']+move_fields['to']+move_fields['promotion'])
    if not board.is_legal(move):
        return False,source_valid,['illegal-move']
    board.push(move)
    squares={}
    for index in chess.SQUARES:
        piece=board.piece_at(index)
        squares[chess.square_name(index)]=('w' if piece.color else 'b')+piece.symbol().lower() if piece else ''
    changes=[sq for sq in squares if before['board'][sq]!=squares[sq] and sq not in (move_fields['from'],move_fields['to'])]
    status={'playing':'playing','checkmate':'won','stalemate':'draw'}[external['adjudicate'](board)]
    expected={**before,'board':squares,'prevBoard':before['board'],'castling':board.castling_xfen().replace('-',''),
              'prevCastling':before['castling'],'enPassant':chess.square_name(board.ep_square) if board.ep_square is not None else '',
              'prevEnPassant':before['enPassant'],'currentTurn':'host' if board.turn else 'guest',
              'winner':before['currentTurn'] if status=='won' else '','status':status,'moveCount':before['moveCount']+1,
              'lastMove':{'from':chess.square_name(move.from_square),'to':chess.square_name(move.to_square),
                          'promotion':chess.piece_symbol(move.promotion) if move.promotion else '','extra':sorted(changes)}}
    proposed={**before,**patch}
    different=sorted(k for k in expected.keys()|proposed.keys() if expected.get(k)!=proposed.get(k))
    if actor!=before[before['currentTurn']]:
        different.append('actor')
    return not different,source_valid,different


def verify(chess,native,digest):
    if not re.fullmatch(r"[0-9a-f]{64}",digest):
        raise ValueError("Expected a complete Rules SHA-256 digest")
    results={}
    for key,actor,before,patch in input_rows(digest):
        verdict,valid,changed=adjudicate(chess,actor,before,patch)
        row={'admission':verdict,'validSource':valid,'mismatches':changed,'input':hash_json([actor,before,patch])}
        if key in results and results[key]!=row:
            raise ValueError(f'Different signed inputs for repeated case {key}')
        if verdict!=native[key]:
            raise ValueError(f'Native and independent judgment differ for {key}: {changed}')
        results[key]=row
    return {'rulesSha256':digest,'status':'compared' if results else 'unmeasured','distinctInputs':len(results),'nativeAgreement':len(results),
            'invalidSourcePositions':[k for k,r in results.items() if not r['validSource']],
            'admitted':sum(r['admission'] for r in results.values()),
            'refused':sum(not r['admission'] for r in results.values()),
            'differenceFields':dict(Counter(f for r in results.values() for f in r['mismatches'])),
            'judgmentsSha256':hash_json(results)}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive',type=Path)
    parser.add_argument('digest',nargs='+')
    args=parser.parse_args()
    native,_=native_replay()
    with tempfile.TemporaryDirectory(prefix='chess-signed-native-') as tmp:
        chess=external['load_chess'](args.archive,Path(tmp))
        print(json.dumps({'authority':'pinned python-chess on the submitted documents','refereeSha256':external['PIN'],
                          'releases':[verify(chess,native,digest) for digest in args.digest]},indent=2))
