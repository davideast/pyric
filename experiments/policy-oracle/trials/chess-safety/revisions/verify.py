"""Re-score every historical candidate registered here on all eight frozen core cohorts."""
import argparse
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
HERE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(HERE))
from replay import REFERENCE, build_recorded_package
from score import score


def verify(selected):
    results=[]
    with tempfile.TemporaryDirectory(prefix='chess-revision-matrix-') as temp:
        work=Path(temp)
        archives=sorted((HERE/'scores').glob('*-through-*.json'))
        if selected:
            unknown=set(selected)-{a.name for a in archives}
            if unknown:
                raise ValueError(f'Unknown historical revisions: {sorted(unknown)}')
            archives=[a for a in archives if a.name in selected]
        for archive in archives:
            old=json.loads(archive.read_bytes())
            digest=old['linkedRulesSha256']
            if not digest:
                # The original monolithic table is retained as a compiler-limit
                # witness. It has no deployable bytes. The tiled revision has its own score.
                if archive.name!='indexed-packed-v5-through-7.json' or '8192 characters' not in str(old['diagnostics']):
                    raise ValueError('Unexpected uncompiled archived program '+str(archive))
                package=build_recorded_package(old['variant'],work)
                if sha256(package.read_bytes()).hexdigest()!=old['candidateSha256']:
                    raise ValueError('Indexed compiler package changed')
                sdk=REFERENCE['install_rules'](package,work/'indexed-limit')/'@pyric/rules'
                measured=json.loads(subprocess.check_output(['bun',HERE/'terminal/table-v2/source-boundary.mjs',sdk]))
                if measured!=json.loads((HERE/'terminal/table-v2/source-boundary.json').read_bytes()):
                    raise ValueError('Monolithic table compiler boundary changed')
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
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--only',action='append',default=[],help='one archived score filename; may repeat')
    parser.add_argument('--record',action='store_true',help='add a missing per-revision record')
    args=parser.parse_args()
    earlier={row['archive']:row for row in json.loads((HERE/'revisions/scores.json').read_bytes())}
    result=verify(args.only)
    for row in result:
        name=row['archive']
        leaf=HERE/'revisions/results'/name
        if name in earlier:
            expected=earlier[name]
        elif leaf.is_file():
            expected=json.loads(leaf.read_bytes())
        elif args.record:
            leaf.parent.mkdir(exist_ok=True)
            with leaf.open('x') as target:
                target.write(json.dumps(row,indent=2)+'\n')
            expected=row
        else:
            raise ValueError(f'Missing per-revision evidence: {name}')
        if expected!=row:
            raise ValueError(f'Historical replay changed: {name}')
    print(json.dumps(result,indent=2))
