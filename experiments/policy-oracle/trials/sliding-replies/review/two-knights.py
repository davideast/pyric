"""Compare the exact nine signed writes and isolate the v17 two-knight residuals."""
import argparse
from collections import Counter
import json
from pathlib import Path
import runpy
import tempfile

AUDIT = runpy.run_path(str(Path(__file__).with_name('signed.py')))
TRIAL = AUDIT['TRIAL']
BASELINE = '833a0fe29435df2456f0a3636aeea03dc33405f1193f22c424428efe469fdae8'
read = AUDIT['read']


def residuals(digest):
    directory = TRIAL/'review/scores'/digest
    wide = read(directory/'wide.json')
    failures = read(directory/'residuals.json')
    assert wide['rulesSha256'] == failures['rulesSha256'] == digest
    assert wide['cases'] == 15905
    for name, cohort in wide['cohorts'].items():
        assert failures['cohorts'][name] == {k: cohort[k] for k in ('cases', 'decisionsSha256')}
    records = {r['writeSha256']: r for r in failures['records']}
    assert len(records) == failures['distinctWrites']
    return records


# The two historical cases have shorter probe labels. Compare the SDK inputs themselves.
def operands(row):
    actor, reader, _, before, submitted = AUDIT['input_shape'](row)
    return [actor, reader, before, submitted]


def compare(digest, archive, chess, *, family='two-knights', baseline_digest=BASELINE,
            defending_material=None, expected_targets=25):
    if defending_material is None:
        defending_material = [chess.KNIGHT, chess.KNIGHT]
    candidate = TRIAL/'live/releases'/digest
    cases = read(TRIAL/'native'/family/'native.json')['cases']
    baseline, before_proof = AUDIT['read_capture'](TRIAL/'supplemental'/family, family, baseline_digest, archive)
    fixed, after_proof = AUDIT['read_capture'](candidate/'receipts', family, digest, archive)
    rows = []
    for case, old, new in zip(cases, baseline['rows'], fixed['rows'], strict=True):
        assert old['id'] == new['id'] == case['id']
        assert AUDIT['same_json'](operands(old), operands(new))
        allowed, valid, _ = AUDIT['exact_judgment'](chess, new['actor'], new['before'][0]['data'], new['submitted'][0]['data'])
        assert valid and allowed == case['nativeAdmission']
        rows.append({'id': case['id'], 'claim': case['claim']['status'], 'native': 'ALLOW' if allowed else 'DENY',
                     'before': old['observed'], 'after': new['observed']})
    old, new = residuals(baseline_digest), residuals(digest)
    target = {}
    for key, record in old.items():
        observation = record['observation']
        if not observation['obligation'].startswith('reject-playing-after-'): continue
        board = chess.Board(observation['fen']+' 0 1')
        board.push_uci(observation['uci'])
        material = sorted(p.piece_type for p in board.piece_map().values() if p.color == board.turn)
        if material == sorted([chess.KING, *defending_material]):
            assert board.is_checkmate() or board.is_stalemate()
            target[key] = {'id': record['occurrences'][0]['id'], 'native': 'mate' if board.is_checkmate() else 'stalemate',
                           'fixed': key not in new}
    assert len(target) == expected_targets
    return {'baselineRulesSha256': baseline_digest, 'candidateRulesSha256': digest, 'live': rows,
            'captures': [before_proof, after_proof], 'wideLocal': {'caseCount': 15905, 'before': len(old),
            'after': len(new), 'newDisagreements': sorted(new.keys()-old.keys()),
            'outsideGroupFixed': sorted(old.keys()-new.keys()-target.keys()),
            'targetFixed': dict(Counter(r['native'] for r in target.values() if r['fixed'])), 'targetCases': target}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('rules_sha256')
    parser.add_argument('private_archive', type=Path)
    parser.add_argument('chess_source', type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        chess = AUDIT['REF']['load_chess'](args.chess_source, Path(tmp))
        print(json.dumps(compare(args.rules_sha256, args.private_archive, chess), indent=2))
