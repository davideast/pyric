"""Score equivalent and deliberately faulty compiler packages through the public replay command."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

HERE=Path(__file__).resolve().parent.parent
PIN='98995632ebf810afa49c3e03ee7fc0bac31e3c8ff841327ffa8a3eddda2a9356'


def repack(source,dest,mode):
    mutations={
        'wrong-witness': br"source = source.replace(/origin\s*\*\s*80/g, 'origin * 79');",
        'ignore-blockers': b'''if (source.startsWith('function slideRecipe')) source = source.replaceAll('(?:,', '(?:[,prnbqkSPNOK]');''',
        'skip-post-reply-king-safety': b'''if (source.startsWith('function slideFailurePattern(')) source = "function slideFailurePattern(white) { return '[^;]*S[^;]*;'; }";''',
    }
    touched=0
    with tarfile.open(source,'r:gz') as old,dest.open('wb') as raw:
        with gzip.GzipFile(filename='',fileobj=raw,mode='wb',mtime=1,compresslevel=6) as stream:
            with tarfile.open(fileobj=stream,mode='w|',format=tarfile.GNU_FORMAT) as new:
                for member in old:
                    data=old.extractfile(member).read() if member.isfile() else None
                    if mode in mutations and member.name=='package/dist/policy/index.js':
                        marker=b"const fn = parse(source, 'PureFunction');"
                        assert data.count(marker)==1
                        data=data.replace(marker,mutations[mode]+b'\n    '+marker)
                        member.size=len(data)
                        touched+=1
                    new.addfile(member,io.BytesIO(data) if data is not None else None)
    assert touched==int(mode in mutations)


def score_package(package,variant,report):
    result=subprocess.run([sys.executable,'-B',HERE/'replay.py','--candidate-package',package,
                           '--variant',variant,'--report',report,'--summary'],capture_output=True,text=True)
    if not report.is_file(): raise RuntimeError(result.stderr)
    scored=json.loads(report.read_bytes())
    assert result.returncode==int(not scored['passes'])
    return scored,result.returncode


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--variant',required=True)
    parser.add_argument('--report',type=Path,required=True)
    parser.add_argument('--geometry',action='store_true',help='also test illegal jumps and replies that expose the king on the batched solver')
    args=parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='sliding-compiler-controls-') as t:
        root=Path(t)
        package=root/'qualified.tgz'
        subprocess.run([sys.executable,'-B',HERE.parent/'chess-safety/mobility/pack.py','--split',package],check=True,stdout=subprocess.DEVNULL)
        assert hashlib.sha256(package.read_bytes()).hexdigest()==PIN
        scores={}
        baseline=None
        modes=['equivalent-repack','wrong-witness']
        if args.geometry: modes.extend(['ignore-blockers','skip-post-reply-king-safety'])
        for name in modes:
            pkg=root/(name+'.tgz');repack(package,pkg,name)
            report=root/(name+'.json')
            r,exit_code=score_package(pkg,args.variant,report)
            assert r['packageSha256']!=PIN and r['compile']['status']=='emitted'
            changed=[]
            if baseline is None:
                baseline=r
            else:
                assert r['packageSha256']!=baseline['packageSha256']
                assert r['compile']['rulesSha256']!=baseline['compile']['rulesSha256']
                assert r['standalone']==baseline['standalone']
                changed=[k for k,v in r['local']['rows'].items() if v['decision']!=baseline['local']['rows'][k]['decision']]
                if name=='wrong-witness': assert not changed
                else: assert changed
                assert r['compiledWitness']['verifiedFocused']<baseline['compiledWitness']['verifiedFocused']
                assert r['live']['status']=='unmeasured' and not r['passes'] and exit_code==1
            witness=r['compiledWitness']
            if args.geometry and name in ('ignore-blockers','skip-post-reply-king-safety'):
                negative=next(row for row in witness['focused'] if row['id']==(
                    'bishop-e5-d6-blocker' if name=='ignore-blockers' else 'bishop-b7-pinned'))
                assert negative['expected']==[] and negative['outcome']=='illegal-witness'
            scores[name]={'packageSha256':r['packageSha256'],'rulesSha256':r['compile']['rulesSha256'],
                          'exitCode':exit_code,'passes':r['passes'],'localConforms':r['localConforms'],
                          'live':{k:r['live'][k] for k in ('status','distinctCases','nativeMatches')},
                          'standalone':r['standalone']['outcomes'],
                          'local':r['local']['groups'],'witnessBoards':witness['requiredFocused'],
                          'changedClaimDecisions':len(changed),'firstChangedClaim':changed[0] if changed else None,
                          'correctWitnesses':witness['verifiedFocused'],
                          'firstWrongWitness':next((row for row in witness['focused'] if row['supported'] and
                                                   row['outcome'] not in ('legal-witness','correct-absence')),None)}
        pin=json.loads((HERE/'revisions'/(args.variant+'.json')).read_bytes())
        assert scores['equivalent-repack']['rulesSha256']==pin['compile']['rulesSha256']
        evidence={'variant':args.variant,'controls':scores}
        if args.geometry:
            vendor=HERE.parents[1]/'arcade/vendor/pyric-rules-0.1.0.tgz'
            stock,exit_code=score_package(vendor,args.variant,root/'stock.json')
            assert stock['compile']['status']=='cannot-compile' and stock['live']['distinctCases']==0
            errors=[line for line in stock['compile']['error'].splitlines() if line.startswith('error: ')]
            assert errors and exit_code==1
            evidence['stockCompiler']={'packageSha256':stock['packageSha256'],'exitCode':exit_code,
                'compile':stock['compile']['status'],'diagnostic':errors[0],
                'standalone':stock['standalone']['outcomes'],'liveCases':0}
    args.report.write_text(json.dumps(evidence,indent=2)+'\n')

if __name__=='__main__': main()
