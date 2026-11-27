"""Measure equivalent castling-rights predicates in the *complete* Arcade write."""

from pathlib import Path
import argparse
from collections import Counter
import sys
from hashlib import sha256
import json
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
OLD = HERE.parents[1]/'chess-safety'
ORIGINAL = """(old.castling == '' || kind != 'k' && !(fromSquare in ['a1', 'a8', 'h1', 'h8']) && !(toSquare in ['a1', 'a8', 'h1', 'h8']) && old.castling.matches('K?Q?k?q?') ? next.castling == old.castling : next.castling == (old.castling.matches('K?Q?k?q?') ? castle ? old.castling.replace(color == 'w' ? '[KQ]' : '[kq]', '') : _games_chess_chess_helpers__dropRights(old.castling, piece, fromSquare, toSquare) : keptRights(old.castling, piece, fromSquare, toSquare)))"""
CORNER = "{'h1':'K','a1':'Q','h8':'k','a8':'q'}"
CANONICAL = "old.castling.matches('K?Q?k?q?')"
DROP = "_games_chess_chess_helpers__dropRights(old.castling, piece, fromSquare, toSquare)"
NORMALIZE = 'keptRights(old.castling, piece, fromSquare, toSquare)'
SLOW = f"next.castling == ({CANONICAL} ? {DROP} : {NORMALIZE})"

def choices():
    # The singleton test only accepts consumption of the entire set of held rights.
    # Looking up a corner in either direction will return its own single letter.
    ordinary = "kind != 'k' && !(fromSquare in ['a1','a8','h1','h8']) && !(toSquare in ['a1','a8','h1','h8'])"
    spent = f"next.castling == '' && old.castling == {CORNER}.get(toSquare, '')"
    corners = "old.castling == 'K' ? 'h1' : old.castling == 'Q' ? 'a1' : old.castling == 'k' ? 'h8' : old.castling == 'q' ? 'a8' : ''"
    paired = f"next.castling == '' && ({corners}) in [fromSquare,toSquare]"
    simple = f"(old.castling == '' ? next.castling == '' : {SLOW})"
    fallback = f"({ordinary} && {CANONICAL} ? next.castling == old.castling : {SLOW})"
    return {
        'original': ORIGINAL,
        'single-destination': f"(old.castling == '' ? next.castling == '' : {spent} || {fallback})",
        'single-either-corner': f"(old.castling == '' ? next.castling == '' : {paired} || {fallback})",
        'canonical-before-drop': simple,
    }

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for key in ('rules','reference','report'): parser.add_argument('--'+key,type=Path,required=True)
    parser.add_argument('--wide',action='store_true',help='also replay legal rights moves, invalid rights claims, and promotions')
    args=parser.parse_args()
    sys.path.insert(0,str(HERE.parent))
    from campaign_corpus import load
    requests,answers,_,_=load('queen')
    subprocess.run([sys.executable,'-B',OLD/'exploration/v1/verify-simulator.py',args.reference],check=True)
    pristine=args.rules.read_text()
    assert pristine.count(ORIGINAL)==1
    cases=requests
    inputs=json.dumps(cases).encode()
    assert len(cases)==238
    output={}
    before={}
    with tempfile.TemporaryDirectory(prefix='sliding-rights-comparison-') as name:
        path=Path(name)/'firestore.rules'
        for label,clause in choices().items():
            path.write_text(pristine.replace(ORIGINAL,clause))
            raw=subprocess.check_output(['bun','--no-install',OLD/'baseline.mjs',args.reference.resolve(),path],input=inputs)
            scores=json.loads(raw)
            assert scores['sha256']==sha256(path.read_bytes()).hexdigest()
            assert [r['id'] for r in scores['rows']]==[r['description'] for r in cases]
            by_id={r['id']:r for r in scores['rows']}
            if label=='original': before=by_id
            summary=Counter()
            for r in by_id.values():
                expected='ALLOW' if answers[r['id']] else 'DENY'
                summary['match' if r['decision']==expected and not r.get('error') else
                        'false-allow' if r['decision']=='ALLOW' else 'false-refusal' if expected=='ALLOW' else 'evaluation-error']+=1
            out={'rulesSha256':scores['sha256'],'sourceSha256':sha256(clause.encode()).hexdigest(),
                 'decisionsAndCostsSha256':sha256(raw).hexdigest(),'cases':len(by_id),'outcomes':dict(summary),
                 'changed':[r for k,r in by_id.items() if before[k]['decision']!=r['decision']],
                 'heldPromotion':by_id['promote-capturing-rook-right-held']}
            if args.wide and label!='single-either-corner':
                cohorts={}
                for name,runner,flags in [('rights','v1/score.mjs',['--rights']),('rights-claims','rights-claims-v1/score.mjs',[]),
                                          ('promotions','v1/score.mjs',['--promotions'])]:
                    measured=json.loads(subprocess.check_output(['bun','--no-install',runner,args.reference.resolve(),path,*flags],
                                        cwd=OLD/'exploration'))
                    assert measured['rulesSha256']==scores['sha256']
                    counts=Counter(measured.get('stats',{}))
                    if not counts:
                        for group in measured['groups'].values(): counts.update(group['outcomes'])
                    cohorts[name]={'cases':sum(counts.values()),'outcomes':dict(counts),
                                   'decisionsSha256':measured.get('scoreSha256') or measured['decisionsSha256']}
                out['wider']=cohorts
            output[label]=out
    args.report.write_text(json.dumps(output,indent=2)+'\n')

if __name__=='__main__': main()
