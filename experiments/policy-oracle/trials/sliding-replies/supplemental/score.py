"""Reproduce the wider local score and reduce its first cost and chess disagreements."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile

HERE=Path(__file__).resolve().parent
TRIAL=HERE.parent
sys.path.insert(0,str(TRIAL))
from campaign_corpus import PRIOR, RULES

EXPLORATION=TRIAL.parent/'chess-safety/exploration'
def read(file): return json.loads(file.read_bytes())
def run(command,data):
    return json.loads(subprocess.check_output(command,input=json.dumps(data).encode(),cwd=TRIAL))

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--rules',type=Path,required=True)
    p.add_argument('--reference',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--python-chess-archive',type=Path,help='independently verify each minimized move and its complete reply list')
    args=p.parse_args()
    source=args.rules.resolve(strict=True);ref=args.reference.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='sliding-supplement-') as temp:
        root=Path(temp); report=root/'wide.json'
        subprocess.run(['python3','-B',EXPLORATION/'replay.py','--rules',source,'--reference',ref,'--report',report,
                            '--extended-endings','--bare-defender','--knight-replies'],check=True,stdout=subprocess.DEVNULL)
        wide=read(report)
        assert hashlib.sha256(source.read_bytes()).hexdigest()==wide['rulesSha256']
        assert wide['cases']==15905 and sum(wide['outcomes'].values())==15905
        corpus=EXPLORATION/'v1'; raw=gzip.decompress((corpus/'corpus.json.gz').read_bytes())
        assert hashlib.sha256(raw).hexdigest()==read(corpus/'freeze.json')['sha256']
        ordered=json.loads(raw)
        first={v['first']['case']['id']:v['first']['result'] for v in wide['reports']['v1']['divergences'].values()}
        seen=set();requests=[];ids={};observations={}
        for candidate in ordered:
            case=candidate['id']; result=first.get(case)
            if not result or result['kind'] in seen: continue
            seen.add(result['kind'])
            req=run(['bun','--no-install',HERE/'write.mjs'],candidate)
            assert req['description']==case
            requests.append(req);ids[result['kind']]=[case]
            observations[case]={'native':'ALLOW' if candidate['nativeAdmission'] else 'DENY','decision':result['actual'],
                               'status':result['status'],'diagnostic':result['cause']}
        minimal_report=root/'case.json'
        minimal_report.write_text(json.dumps({'compile':{'rulesSha256':wide['rulesSha256']},'groups':ids,'local':{'rows':observations}}))
        reduced=run(['bun','--no-install',TRIAL/'minimize.mjs',ref,source,minimal_report],requests)
    scores={k:wide[k] for k in ('authority','rulesSha256','cases','outcomes','cohorts')}
    scores['scope']='Local comparisons counted by frozen corpus ID across eleven cohorts. Cases may repeat a document under another ID.'
    scores['firstInFrozenOrder']=requests[0]['description'] if requests else None
    scores['reductions']=reduced
    minimal_requests=[]
    for item in reduced['reductions']:
        case=item['smallest']
        minimal_requests.append(run(['bun','--no-install',HERE/'write.mjs'],{
            'id':item['id'], 'fen':case['fen'], 'uci':case['uci'], 'claim':case['claim']}))
    baseline=TRIAL.parent/'chess-safety/baseline.mjs'
    old=run(['bun','--no-install',baseline,ref,RULES],minimal_requests)
    new=run(['bun','--no-install',baseline,ref,source],minimal_requests)
    assert old['sha256']==PRIOR and new['sha256']==wide['rulesSha256']
    comparisons=[]
    for item,prior_row,new_row in zip(reduced['reductions'],old['rows'],new['rows'],strict=True):
        compact=item['smallest']
        assert prior_row['id']==new_row['id']==item['id']
        assert (new_row['decision'],new_row.get('error'),new_row['cost'])==(
            compact['decision'],compact['diagnostic'],compact['expressions'])
        comparisons.append({'id':item['id'],'native':compact['native'],'prior':prior_row,'selected':new_row})
    scores['minimizedReleaseComparison']={'priorRulesSha256':PRIOR,'rows':comparisons}
    if args.python_chess_archive:
        referee=runpy.run_path(str(TRIAL.parent/'chess/reference/generate.py'))
        verified={}
        with tempfile.TemporaryDirectory(prefix='sliding-reduced-referee-') as temp:
            chess=referee['load_chess'](args.python_chess_archive,Path(temp))
            for item in reduced['reductions']:
                case=item['smallest']
                board=chess.Board(case['fen']+' 0 1')
                move=chess.Move.from_uci(case['uci'])
                assert board.is_valid() and board.is_legal(move)==case['nativeLegal']
                if not case['nativeLegal']:
                    assert case['native']=='DENY' and case['replies'] is None
                    verified[item['id']]=None
                    continue
                board.push(move)
                replies=sorted(m.uci() for m in board.legal_moves)
                assert board.is_valid() and referee['fen'](board)==case['successor'] and replies==case['replies']
                assert board.is_check()==case['checkedDefender'] and referee['adjudicate'](board)==case['outcome']
                verified[item['id']]=replies
        scores['independentReducedPositions']={'refereeSourceSha256':referee['PIN'],'legalReplies':verified}
    args.output.write_text(json.dumps(scores,indent=2)+'\n')

if __name__=='__main__': main()
