"""Local full-write controls for lone-pawn replies unique to the pawn."""
from campaign_corpus import HERE, run

# Each pair reflects the ranks and swaps the colors.
BOARDS = (
    ('double', '8/8/k7/7r/K7/4r3/3P4/8 b - -', 'h5h4', 'd2d4'),
    ('double', '8/3p4/4R3/k7/7R/K7/8/8 w - -', 'h4h5', 'd7d5'),
    ('ep', '2b5/5p2/3k4/6P1/4K3/2b3q1/8/8 b - -', 'f7f5', 'g5f6'),
    ('ep', '8/8/2B3Q1/4k3/6p1/3K4/5P2/2B5 w - -', 'f2f4', 'g4f3'),
)


def score(rules, reference, evaluate, chess=None):
    cases, expected, boards, replies = [], {}, [], []
    for name, fen, move, reply in BOARDS:
        if chess:
            board = chess.Board(fen+' 0 1')
            assert board.is_valid() and board.is_legal(chess.Move.from_uci(move))
            board.push_uci(move)
            answer = chess.Move.from_uci(reply)
            assert list(board.legal_moves) == [answer]
            assert board.is_en_passant(answer) == (name=='ep')
        winner = 'host' if fen.split()[1]=='w' else 'guest'
        boards.append({'fen':fen,'move':move,'onlyReply':reply})
        for status in ['playing','draw','won']:
            key = f'{name}-{winner}-{status}'
            cases.append(dict(id=key,fen=fen,uci=move,claim=dict(status=status,winner=winner if status=='won' else '')))
            expected[key] = status=='playing'
            replies.append(reply)
    writes = run('bun','--no-install',HERE/'project.mjs','writes',data=cases)
    native = run('bun','--no-install',HERE/'reference.mjs',data=writes)
    for row, reply in zip(native,replies,strict=True):
        assert row['eligible'] and row['all']==[reply] and row['outcome']=='playing'
    rows = evaluate(writes,expected,rules,reference)
    return {'boards':boards,'localDecisions':{key:r['decision'] for key,r in rows.items()},
            'disagreements':[key for key,r in rows.items() if r['status']!='match']}
