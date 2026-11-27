"""Find the fewest original pieces that preserve each reduced local disagreement."""
import argparse
from collections import Counter
from hashlib import sha256
from itertools import combinations
import json
from pathlib import Path
import runpy
import subprocess
import sys
from tempfile import TemporaryDirectory

TRIAL = Path(__file__).resolve().parents[1]
PREVIOUS = TRIAL.parent / 'chess-safety'
REFEREE = runpy.run_path(str(TRIAL.parent / 'chess/reference/generate.py'))


def json_command(argv, data):
    return json.loads(subprocess.check_output(argv, input=json.dumps(data).encode()))


def score(rules, digest, reference, fixtures):
    writes = json_command(['bun', '--no-install', TRIAL/'supplemental/write.mjs'], fixtures)
    rows = []
    # The evaluator retains full expression traces. Score small batches and keep only their verdicts.
    for offset in range(0, len(writes), 32):
        result = json_command(['bun', '--no-install', PREVIOUS/'baseline.mjs', reference, rules], writes[offset:offset+32])
        assert result['sha256'] == digest
        rows.extend(result['rows'])
    assert [r['id'] for r in rows] == [f['id'] for f in fixtures]
    return rows


def measure(chess, reduction, rules, digest, reference):
    start = reduction['start']
    assert start['nativeLegal'] and start['kingSafe']
    original = chess.Board(start['fen'] + ' 0 1')
    move = chess.Move.from_uci(start['uci'])
    fixed = {chess.parse_square(name) for name in reduction['fixedSquares']}
    optional = sorted(set(original.piece_map()) - fixed)
    native, fixtures = {}, []
    examined = 0
    for count in range(len(optional) + 1):
        for keep in combinations(optional, count):
            examined += 1
            board = original.copy(stack=False)
            for square in set(optional).difference(keep):
                board.remove_piece_at(square)
            if not board.is_valid() or board.castling_rights != original.castling_rights or board.ep_square != original.ep_square:
                continue
            if board.is_check() != original.is_check() or not board.is_legal(move):
                continue
            fen, pieces = REFEREE['fen'](board), len(board.piece_map())
            board.push(move)
            outcome = REFEREE['adjudicate'](board)
            if not board.is_valid() or board.is_check() != start['checkedDefender'] or outcome != start['outcome']:
                continue
            replies = sorted(m.uci() for m in board.legal_moves)
            if len(start['replies']) == 1 and replies != start['replies']:
                continue
            status = {'playing':'playing', 'stalemate':'draw', 'checkmate':'won'}[outcome]
            winner = ('host' if original.turn else 'guest') if status == 'won' else ''
            assert (start['native'] == 'ALLOW') == (start['claim'] == {'status':status, 'winner':winner})
            key = reduction['id'] + '-' + str(len(fixtures))
            fixtures.append({'id':key, 'fen':fen, 'uci':start['uci'], 'claim':start['claim']})
            native[key] = {'fen':fen, 'replies':replies, 'pieces':pieces, 'successor':REFEREE['fen'](board)}
    assert examined == 2**len(optional)
    failures = []
    for row in score(rules, digest, reference, fixtures):
        if (row['decision'], row.get('error')) == (start['decision'], start['diagnostic']):
            failures.append(native[row['id']] | {'decision':row['decision'], 'diagnostic':row.get('error'), 'expressions':row['cost']})
    smallest = reduction['smallest']
    assert any(row['fen'] == smallest['fen'] and row['expressions'] == smallest['expressions'] for row in failures)
    same_replies = [row for row in failures if row['replies'] == smallest['replies']]
    all_counts = Counter(row['pieces'] for row in failures)
    exact_counts = Counter(row['pieces'] for row in same_replies)
    minimum, exact_minimum = min(all_counts), min(exact_counts)
    return {'id':reduction['id'], 'source':start['fen'], 'uci':start['uci'], 'claim':start['claim'],
            'optionalSquares':[chess.square_name(i) for i in optional], 'subsets':examined, 'chessQualified':len(fixtures),
            'failuresByPieceCount':dict(all_counts), 'minimumPieces':minimum,
            'minimumWitnesses':[row for row in failures if row['pieces'] == minimum],
            'matchingReducedReplyListByPieceCount':dict(exact_counts), 'minimumWithExactReplyList':exact_minimum,
            'minimumExactReplyWitnesses':[row for row in same_replies if row['pieces'] == exact_minimum]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, required=True, help='installed pinned @pyric/rules evaluator')
    parser.add_argument('--python-chess-archive', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    reference = args.reference.resolve(strict=True)
    subprocess.run([sys.executable, '-B', PREVIOUS/'exploration/v1/verify-simulator.py', reference], check=True)
    prior = json.loads((TRIAL/'supplemental/selected.json').read_bytes())
    digest = prior['rulesSha256']
    rules = TRIAL/'live/releases'/digest/'firestore.rules'
    assert sha256(rules.read_bytes()).hexdigest() == digest
    with TemporaryDirectory(prefix='sliding-subsets-') as temp:
        chess = REFEREE['load_chess'](args.python_chess_archive, Path(temp))
        rows = [measure(chess, reduction, rules, digest, reference) for reduction in prior['reductions']['reductions']]
    evidence = {'candidateRulesSha256':digest, 'refereeSourceSha256':REFEREE['PIN'],
                'scope':'All subsets of pieces on the original starting squares. Both kings, mover, destination occupant, castling and en passant rights are held fixed. Compare only positions with the original legality, predecessor and successor check, native outcome, claim and same Rules failure class.',
                'reductions':rows}
    args.output.write_text(json.dumps(evidence, indent=2)+'\n')


if __name__ == '__main__':
    main()
