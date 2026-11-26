"""Verify each registry leaf against the independent campaign freeze and exact SDK proposals."""
import argparse
from gzip import GzipFile
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
TRIAL = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(TRIAL))
from corpus import BATCHES, load

ROOT = TRIAL.parents[1]
CLAIMS = ROOT/'suites/arcade/chess/claims'
SOURCE = {'repo':'https://github.com/davideast/arcade','revision':'66e14d4f4b0aeab22c05db8d748704dde053d2e5','path':'games/chess/src/chess.ts'}
RUNNER = b"import {join} from 'node:path';\nimport {pathToFileURL} from 'node:url';\nconst {replay}=await import(pathToFileURL(join(process.env.ORACLE_ROOT,'trials/chess-safety/registry/evaluate.mjs')));\nconsole.log(JSON.stringify(await replay(new URL('.',import.meta.url))));\n"

def formatted(value):
    return (json.dumps(value,indent=2)+'\n').encode()

def compressed(value):
    buf = BytesIO()
    with GzipFile(fileobj=buf,mode='wb',mtime=0) as archive:
        archive.write(json.dumps(value,separators=(',',':')).encode())
    return buf.getvalue()

def run(create):
    _, groups, requests = load(7)
    lookup = {r['description']:r for r in requests}
    labels = ['rank and diagonal pins','king destinations and defended captures','responses to check and double check',
              'en passant exposing the king','attacks on the three castling squares','composed move and king-safety checks',
              'submitted mate, stalemate and ongoing claims']
    def write(path, data):
        if create:
            path.parent.mkdir(parents=True,exist_ok=True)
            with path.open('xb') as stream:
                stream.write(data)
        elif path.read_bytes()!=data:
            raise ValueError(f'Registry binding changed for {path}')
    for batch, label in zip(BATCHES,labels,strict=True):
        claim = CLAIMS/('king-safety-'+batch.split('-',1)[1])/'v1'
        probe = claim/'probes/paired-moves/v1'
        case_ids = groups[batch]
        declaration = formatted({'description':'For the registered positions covering '+label+', admit the submitted move exactly when native Arcade admits the move and its claimed result.','authority':'native-model'})
        write(claim/'claim.json',declaration)
        write(claim/'obligations/move-admission.json',formatted({'probe':'paired-moves/v1'}))
        raw = (TRIAL/'batches'/batch/'v1/native.json').read_bytes()
        write(probe/'raw/arcade-native.json',raw)
        writes = compressed([lookup[key] for key in case_ids]); write(probe/'writes.json.gz',writes)
        write(probe/'replay.mjs',RUNNER)
        pins = {n:sha256(b).hexdigest() for n,b in [('replay.mjs',RUNNER),('writes.json.gz',writes)]}
        for item in ['trials/chess-safety/registry/evaluate.mjs','trials/chess-safety/artefacts/quick-packed-v5.rules','trials/chess/bundle/artifacts/stronger.rules']:
            pins['@oracle/'+item] = sha256((ROOT/item).read_bytes()).hexdigest()
        recipe = formatted({'source':SOURCE,'cases':case_ids,'pins':pins,'replay':'replay.mjs'});write(probe/'recipe.json',recipe)
        values = {r['id']:r['nativeAdmission'] for r in json.loads(raw)['cases']}
        obs = {'authority':'native-model','inputDigest':sha256(declaration+b'\0'+recipe).hexdigest(),'results':values,
               'evidence':{'path':'raw/arcade-native.json','sha256':sha256(raw).hexdigest(),
                           'pointers':{key:f'/cases/{i}/nativeAdmission' for i,key in enumerate(case_ids)}}}
        write(probe/'observations/arcade-native.json',formatted(obs))
    return {'claims':len(BATCHES),'cases':sum(len(groups[b]) for b in BATCHES)}

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--freeze',action='store_true',help='create new leaves exclusively')
    print(json.dumps(run(p.parse_args().freeze)))
