"""Reproduce the wider local score and reduce its first cost and chess disagreements."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

HERE=Path(__file__).resolve().parent
TRIAL=HERE.parent
EXPLORATION=TRIAL.parent/'chess-safety/exploration'
def read(file): return json.loads(file.read_bytes())
def run(command,data):
    return json.loads(subprocess.check_output(command,input=json.dumps(data).encode(),cwd=TRIAL))

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--rules',type=Path,required=True)
    p.add_argument('--reference',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--from-report',type=Path,help='reuse complete results from the pinned exploration CLI')
    args=p.parse_args()
    source=args.rules.resolve(strict=True);ref=args.reference.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='sliding-supplement-') as temp:
        root=Path(temp); report=args.from_report or root/'wide.json'
        if not args.from_report:
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
        assert requests
        minimal_report=root/'case.json'
        minimal_report.write_text(json.dumps({'compile':{'rulesSha256':wide['rulesSha256']},'groups':ids,'local':{'rows':observations}}))
        reduced=run(['bun','--no-install',TRIAL/'minimize.mjs',ref,source,minimal_report],requests)
    scores={k:wide[k] for k in ('authority','rulesSha256','cases','outcomes','cohorts')}
    scores['scope']='Local comparisons counted by frozen corpus ID across eleven cohorts. Cases may repeat a document under another ID.'
    scores['firstInFrozenOrder']=requests[0]['description']
    scores['reductions']=reduced
    args.output.write_text(json.dumps(scores,indent=2)+'\n')

if __name__=='__main__': main()
