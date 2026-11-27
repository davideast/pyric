"""Rebuild the native evidence, optionally re-adjudicating it with the sealed chess source."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
TRIALS = HERE.parent.parent
COHORTS = ('rook', 'bishop', 'queen')
EXTERNAL = runpy.run_path(str(TRIALS / 'chess/reference/generate.py'))


def read(path):
    return json.loads(path.read_bytes())


def file_hash(path):
    return sha256(path.read_bytes()).hexdigest()


def independent(chess, positions, native):
    cases = native['cases']
    assert len(positions) == len(cases) and len(positions) % 3 == 0
    boards = []
    for start in range(0, len(positions), 3):
        trio = positions[start:start+3]
        claims = [row['claim']['status'] for row in trio]
        assert claims == ['playing', 'draw', 'won']
        sample = trio[0]
        game = chess.Board(sample['fen'] + ' 0 1')
        move = chess.Move.from_uci(sample['uci'])
        assert game.is_valid() and game.is_legal(move), sample['id']
        before_check = game.is_check()
        mover = game.turn
        game.push(move)
        assert game.is_valid() and game.is_check(), sample['id']
        status = EXTERNAL['adjudicate'](game)
        accepted = {'playing': 'playing', 'checkmate': 'won', 'stalemate': 'draw'}[status]
        winner = ('host' if mover else 'guest') if accepted == 'won' else ''
        replies = sorted(reply.uci() for reply in game.legal_moves)
        successor = EXTERNAL['fen'](game)
        for offset, proposal in enumerate(trio):
            row = cases[start+offset]
            assert all(row[k] == proposal[k] for k in ('id', 'fen', 'uci', 'claim'))
            assert (row['fen'], row['uci']) == (sample['fen'], sample['uci'])
            assert row['nativeLegal'] and row['kingSafe'] and row['beforeCheck'] == before_check
            assert row['successor'] == successor and row['replies'] == replies and row['outcome'] == status
            expected = {'status': accepted, 'winner': winner}
            assert row['expected'] == expected and row['nativeAdmission'] == (proposal['claim'] == expected)
        after_reply = {}
        for reply in replies:
            game.push_uci(reply)
            after_reply[reply] = EXTERNAL['fen'](game)
            game.pop()
        boards.append({
            'id': sample['id'].removesuffix('-playing'), 'source': sample['fen'], 'move': sample['uci'],
            'successor': successor, 'checkers': sorted(chess.square_name(sq) for sq in game.checkers()),
            'replies': replies, 'afterReply': after_reply, 'acceptedClaim': accepted,
        })
    return {'authority': 'hash-pinned python-chess', 'sourceSha256': EXTERNAL['PIN'],
            'boards': boards, 'claims': len(cases)}


def verify(archive=None, record=False):
    results = {}
    with tempfile.TemporaryDirectory(prefix='slider-independent-native-') as temp:
        chess = EXTERNAL['load_chess'](archive, Path(temp)) if archive else None
        for cohort in COHORTS:
            directory = HERE / cohort
            positions = directory / 'positions.json'
            native = directory / 'native.json'
            independent_file = directory / 'independent.json'
            freeze = directory / 'freeze.json'
            rebuilt = json.loads(subprocess.check_output(
                ['bun', '--no-install', TRIALS/'chess-safety/reference/native.mjs', positions]))
            assert rebuilt == read(native), f'Arcade native output changed: {cohort}'
            if chess:
                result = independent(chess, read(positions), rebuilt)
                if record:
                    with independent_file.open('x') as target:
                        target.write(json.dumps(result, indent=2)+'\n')
                assert result == read(independent_file), f'Independent chess evidence changed: {cohort}'
            hashes = {path.name: file_hash(path) for path in (positions, native, independent_file)}
            if record:
                with freeze.open('x') as target:
                    target.write(json.dumps(hashes, indent=2)+'\n')
            assert hashes == read(freeze), f'Frozen cohort hashes changed: {cohort}'
            rows = rebuilt['cases']
            results[cohort] = {'boards': len(rows)//3, 'claims': len(rows),
                               'admitted': sum(row['nativeAdmission'] for row in rows), 'files': hashes}
    mutants = json.loads(subprocess.check_output(['bun', '--no-install', HERE/'mutations.mjs']))
    assert mutants == read(HERE/'mutations.json'), 'Faulty implementation evidence changed'
    return {'arcadeReplayed': True, 'independentReplayed': bool(archive), 'cohorts': results,
            'firstDivergences': {k: v['firstDivergence'] for k,v in mutants['observations'].items()}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--python-chess-archive', type=Path, help='hash-pinned chess-1.11.2 sdist')
    parser.add_argument('--record', action='store_true', help='create new independent evidence files once')
    args = parser.parse_args()
    if args.record and not args.python_chess_archive:
        parser.error('--record requires --python-chess-archive')
    print(json.dumps(verify(args.python_chess_archive,args.record), indent=2))
