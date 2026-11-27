"""Exercise the package entry point with an equivalent repack and a faulty witness encoding."""
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


def repack(source,dest,bad):
    touched=0
    with tarfile.open(source,'r:gz') as old,dest.open('wb') as raw:
        with gzip.GzipFile(filename='',fileobj=raw,mode='wb',mtime=1,compresslevel=6) as stream:
            with tarfile.open(fileobj=stream,mode='w|',format=tarfile.GNU_FORMAT) as new:
                for member in old:
                    data=old.extractfile(member).read() if member.isfile() else None
                    if bad and member.name=='package/dist/policy/index.js':
                        marker=b"const fn = parse(source, 'PureFunction');"
                        assert data.count(marker)==1
                        # All legal encoded replies still compare >= 0. Only the square is wrong.
                        data=data.replace(marker, b"source = source.replace(/origin\\s*\\*\\s*80/g, 'origin * 79');\n    "+marker)
                        member.size=len(data)
                        touched+=1
                    new.addfile(member,io.BytesIO(data) if data is not None else None)
    assert touched==int(bad)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--variant',required=True)
    parser.add_argument('--report',type=Path,required=True)
    args=parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='sliding-compiler-controls-') as t:
        root=Path(t)
        package=root/'qualified.tgz'
        subprocess.run([sys.executable,'-B',HERE.parent/'chess-safety/mobility/pack.py','--split',package],check=True,stdout=subprocess.DEVNULL)
        assert hashlib.sha256(package.read_bytes()).hexdigest()==PIN
        scores={}
        baseline=None
        for name in ('equivalent-repack','wrong-witness'):
            pkg=root/(name+'.tgz');repack(package,pkg,name=='wrong-witness')
            report=root/(name+'.json')
            result=subprocess.run([sys.executable,'-B',HERE/'replay.py','--candidate-package',pkg,'--variant',args.variant,
                                   '--report',report,'--summary'],capture_output=True,text=True)
            if not report.is_file():raise RuntimeError(result.stderr)
            r=json.loads(report.read_bytes())
            assert r['packageSha256']!=PIN and r['compile']['status']=='emitted'
            if baseline is None:
                baseline=r
            else:
                assert r['packageSha256']!=baseline['packageSha256']
                assert r['compile']['rulesSha256']!=baseline['compile']['rulesSha256']
                assert r['standalone']==baseline['standalone']
                assert {k:v['decision'] for k,v in r['local']['rows'].items()}=={k:v['decision'] for k,v in baseline['local']['rows'].items()}
                assert r['compiledWitness']['verifiedFocused']<baseline['compiledWitness']['verifiedFocused']
                assert r['live']['status']=='unmeasured' and not r['passes'] and result.returncode==1
            witness=r['compiledWitness']
            scores[name]={'packageSha256':r['packageSha256'],'rulesSha256':r['compile']['rulesSha256'],
                          'exitCode':result.returncode,'standalone':r['standalone']['outcomes'],
                          'local':r['local']['groups'],'witnessBoards':witness['requiredFocused'],
                          'correctWitnesses':witness['verifiedFocused'],
                          'firstWrongWitness':next((row for row in witness['focused'] if row['supported'] and
                                                   row['outcome'] not in ('legal-witness','correct-absence')),None)}
        pin=json.loads((HERE/'revisions'/(args.variant+'.json')).read_bytes())
        assert scores['equivalent-repack']['rulesSha256']==pin['compile']['rulesSha256']
    args.report.write_text(json.dumps({'variant':args.variant,'controls':scores},indent=2)+'\n')

if __name__=='__main__': main()
