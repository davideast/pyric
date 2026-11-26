"""Re-score every historical candidate registered here on all eight frozen core cohorts."""
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path
import sys
import tempfile

sys.dont_write_bytecode = True
HERE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(HERE))
from replay import build_recorded_package
from score import score


def verify():
    results=[]
    with tempfile.TemporaryDirectory(prefix='chess-revision-matrix-') as temp:
        work=Path(temp)
        for archive in sorted((HERE/'scores').glob('*-through-*.json')):
            old=json.loads(archive.read_bytes())
            digest=old['linkedRulesSha256']
            if not digest:
                # The original monolithic table is retained as a compiler-limit
                # witness. It has no deployable bytes. The tiled revision has its own score.
                if archive.name!='indexed-packed-v5-through-7.json' or '8192 characters' not in str(old['diagnostics']):
                    raise ValueError('Unexpected uncompiled archived program '+str(archive))
                results.append({'archive':archive.name,'variant':old['variant'],'historicalCompileBoundary':'function source exceeds 8192 characters','linkedRulesSha256':None})
                continue
            variant=old['variant'];package=build_recorded_package(variant,work)
            if sha256(package.read_bytes()).hexdigest()!=old['candidateSha256']:
                raise ValueError('Historical package changed: '+variant)
            report=score(package,7,variant,board_policy=True)
            if report['linkedRulesSha256']!=digest:
                raise ValueError('Linked release changed: '+variant+' '+str(report['diagnostics']))
            for group in ['kingSafety','linkedWrites','standaloneBoard']:
                if group in old and report[group][:len(old[group])]!=old[group]:
                    raise ValueError('Frozen case decisions or classifications changed: '+archive.name+' '+group)
            rows=report['linkedWrites']
            results.append({'archive':archive.name,'variant':variant,'linkedRulesSha256':digest,
                'standalone':dict(Counter(r['status'] for r in report['kingSafety'])),
                'standaloneBoard':dict(Counter(r['status'] for r in report['standaloneBoard'])),
                'linked':dict(Counter(r['status'] for r in rows)),
                'byBatch':{k:s['linkedWrites']['counts'] for k,s in report['batches'].items()},
                'firstDivergence':next((dict(r) for r in rows if r['status']!='match'),None)})
    return results

if __name__=='__main__':
    print(json.dumps(verify(),indent=2))
