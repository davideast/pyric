"""Re-adjudicate both live captures, the original 20 residuals, and special pawn replies."""
import argparse
import json
from pathlib import Path
import runpy
import sys
import tempfile

TRIAL = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(TRIAL))
from campaign_corpus import OLD, run
from pawn_controls import score

MATERIAL = runpy.run_path(str(TRIAL/'review/two-knights.py'))
evaluate = runpy.run_path(str(TRIAL/'replay.py'))['evaluate']
BASELINE = 'aa2da0c0522d4de0a8006a51591508ce4912c7bb40a102665d23f3a7bd27d341'


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('rules_sha256')
    parser.add_argument('private_archive', type=Path)
    parser.add_argument('chess_source', type=Path)
    parser.add_argument('reference_rules_package', type=Path)
    args=parser.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        chess=MATERIAL['AUDIT']['REF']['load_chess'](args.chess_source,Path(tmp))
        data=MATERIAL['compare'](args.rules_sha256,args.private_archive,chess,family='lone-pawn',
                                 baseline_digest=BASELINE,defending_material=[chess.PAWN],expected_targets=20)
        rules=TRIAL/'live/releases'/args.rules_sha256/'firestore.rules'
        data['specialReplies']=score(rules,args.reference_rules_package,evaluate,chess)
        corpus=OLD/'exploration/en-passant-evasions-v1/score.mjs'
        def ep_summary(digest):
            result=run('bun','--no-install',corpus,args.reference_rules_package,
                       TRIAL/'live/releases'/digest/'firestore.rules','--verdict-digest')
            return {k:result[k] for k in ('rulesSha256','corpusSha256','writes','verdictsSha256')}
        before,after=map(ep_summary,(BASELINE,args.rules_sha256))
        assert (before['corpusSha256'],before['writes'])==(after['corpusSha256'],after['writes'])
        data['enPassantSequenceReplay']={'before':before,'after':after,
            'identicalDecisions':before['verdictsSha256']==after['verdictsSha256']}
        print(json.dumps(data,indent=2))
