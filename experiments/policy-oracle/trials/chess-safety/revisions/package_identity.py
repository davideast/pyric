"""Test live attribution through two real, separately packaged public compiler entry points."""
import argparse
import gzip
from hashlib import sha256
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

sys.dont_write_bytecode = True
HERE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(HERE))
from replay import build_recorded_package
from score import score

WRAPPER=r'''export * from './index.js';
import {compileFunction as baseline} from './index.js';
export function compileFunction(source,...options) {
  const compiled=baseline(source,...options);
  if (/^function packedSafe\(/.test(source)) {
    const original=compiled.firestoreModule.bind(compiled);
    compiled.firestoreModule=()=>original().replace(/\btext\b/g,'packedBoardText');
  }
  return compiled;
}
'''

def renamed(path, dest):
    with tarfile.open(path,'r:gz') as archive, dest.open('wb') as raw:
        with gzip.GzipFile(filename='',fileobj=raw,mode='wb',mtime=0) as compressed:
            with tarfile.open(fileobj=compressed,mode='w|',format=tarfile.GNU_FORMAT) as out:
                for item in archive:
                    value=archive.extractfile(item).read() if item.isfile() else None
                    if item.name=='package/package.json':
                        data=json.loads(value)
                        data['exports']['./experimental/policy']['import']='./dist/policy/qualification.mjs'
                        value=json.dumps(data,indent=2).encode();item.size=len(value)
                    out.addfile(item,io.BytesIO(value) if value is not None else None)
                info=tarfile.TarInfo('package/dist/policy/qualification.mjs')
                body=WRAPPER.encode();info.size=len(body)
                out.addfile(info,io.BytesIO(body))

def verify(variant):
    expected=json.loads((HERE/'scores'/f'{variant}-through-7.json').read_bytes())
    reports=[]
    with tempfile.TemporaryDirectory(prefix='chess-identity-') as scratch:
        temp=Path(scratch)
        pkg=build_recorded_package(variant,temp)
        # Change only gzip level, preserving the identical npm distribution once unpacked.
        repack=temp/'repacked.tgz'
        repack.write_bytes(gzip.compress(gzip.decompress(pkg.read_bytes()),compresslevel=1,mtime=0))
        rename=temp/'renamed.tgz';renamed(pkg,rename)
        for tag,file in [('repacked',repack),('parameterRename',rename)]:
            found=score(file,7,variant,board_policy=True)
            assert found['passed'] and found['candidateSha256']!=expected['candidateSha256'],tag
            for plane in ('kingSafety','standaloneBoard','linkedWrites'):
                assert found[plane]==expected[plane],(tag,plane,found['diagnostics'])
            digest=found['linkedRulesSha256']
            assert (digest==expected['linkedRulesSha256'])==(tag=='repacked')
            cloud=json.loads(subprocess.check_output(['bun',HERE/'live/run.mjs','lookup',digest]))
            assert cloud['rulesSha256']==digest
            if tag=='repacked': assert cloud['status']=='measured' and cloud['distinctCases']>0
            else:
                assert not ({r['receipt'] for r in cloud['captures']} & set(reports[0]['controllerReceipts']))
            reports.append({'control':tag,'packageSha256':found['candidateSha256'],'linkedRulesSha256':digest,'matchedCoreCases':len(found['linkedWrites']),
                'production':cloud['status'],'controllerReceipts':[r['receipt'] for r in cloud['captures']]})
    return reports

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--variant',default='combined-pattern-fast-packed-v5')
    print(json.dumps(verify(parser.parse_args().variant),indent=2))
