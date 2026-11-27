"""Audit exact signed operands and measure the v19 missed-slider cohort by write hash."""
import argparse
import json
from pathlib import Path
import runpy
import sys
import tempfile

HERE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(HERE))
from campaign_corpus import OLD, read, run
from mixed_slider_controls import CONTROLS, score, score_originals

selection=runpy.run_path(str(HERE/'review/mixed-slider-cover.py'))
audit=selection['AUDIT']
baseline=selection['BASELINE']

def compare(digest,archive,chess,reference):
    proof=selection['cover'](chess)
    assert proof==read(HERE/'native/mixed-slider/cover.json')
    live,captures=audit['compare_live'](digest,archive,chess,'mixed-slider',baseline)
    old,new=audit['residuals'](baseline),audit['residuals'](digest)
    target=proof['cases']
    wrong={k:v['id'] for k,v in target.items() if k in new}
    for name,fen,uci,legal in CONTROLS:
        board=chess.Board(fen+' 0 1')
        assert board.is_valid() and board.is_legal(chess.Move.from_uci(uci))
        board.push_uci(uci)
        assert sorted(m.uci() for m in board.legal_moves)==legal and board.is_checkmate()==(not legal)
    evaluate=runpy.run_path(str(HERE/'replay.py'))['evaluate']
    rules=HERE/'live/releases'/digest/'firestore.rules'
    # Replay each earlier failure also as a complete write. An evaluator error
    # or budget refusal cannot earn credit for rejecting a false claim.
    direct=score_originals(rules,reference,evaluate)
    assert all(r['status']=='match' for r in direct.values()) == (not wrong)
    def ep(version):
        return run('bun','--no-install',OLD/'exploration/en-passant-evasions-v1/score.mjs',reference,
                   HERE/'live/releases'/version/'firestore.rules','--verdict-digest')
    first,last=map(ep,(baseline,digest))
    assert first['corpusSha256']==last['corpusSha256']
    return {'baseline':baseline,'candidate':digest,'live':live,'captures':captures,'minimumBoards':proof['minimumBoards'],
        'wideLocal':{'count':15905,'before':len(old),'after':len(new),'targetFixed':len(target)-len(wrong),
            'targetRemaining':wrong,'newDisagreements':sorted(new.keys()-old.keys()),
            'outsideGroupFixed':sorted(old.keys()-new.keys()-target.keys()),'targetWrites':direct},
        'pinnedSliderControls':score(rules,reference,evaluate),'enPassantReplay':{'cases':last['writes'],
            'beforeVerdicts':first['verdictsSha256'],'afterVerdicts':last['verdictsSha256']}}

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('digest')
    for arg in ('archive','chess','reference'): p.add_argument(arg,type=Path)
    args=p.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        engine=audit['AUDIT']['REF']['load_chess'](args.chess,Path(tmp))
        print(json.dumps(compare(args.digest,args.archive,engine,args.reference),indent=2))
