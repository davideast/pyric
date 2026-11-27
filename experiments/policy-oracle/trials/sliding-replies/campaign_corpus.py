"""Load exact signed inputs and independently frozen native chess answers."""
import gzip
import hashlib
import json
from pathlib import Path
import runpy
import subprocess
import sys

HERE = Path(__file__).resolve().parent
OLD = HERE.parent / 'chess-safety'
ROOT = HERE.parents[1]
PRIOR = '5365dc5183a2ef4d8a9af8443e4d35323fd7a4794e602c7a6fff36220a7e8380'
RULES = OLD/'artefacts/knight-endgame-paired-pawn-combined-bare-fixed-comma-packed-v5.rules'
FAMILIES = ('rook','bishop','queen')


COHORTS = (*FAMILIES, 'queen-bishop', 'two-knights', 'lone-pawn', 'mixed-slider')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_bytes())


def digest(value):
    return sha(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())


def run(*args, data=None):
    payload = json.dumps(data).encode() if data is not None else None
    return json.loads(subprocess.check_output(args, input=payload, cwd=HERE))


def load(through):
    # The old replay validates its original native source and all position freezes.
    sys.path.insert(0,str(OLD))
    try:
        original,_ = runpy.run_path(str(OLD/'replay.py'))['native_replay']()
    finally:
        sys.path.remove(str(OLD))
    requests, answers, prior, groups = {}, {}, {}, {}
    for name in ('comma-chess-safety-full','comma-held-rook-promotion'):
        folder=OLD/'live/receipts'/PRIOR
        proof=read(folder/(name+'.pin.json'))
        compressed=(folder/(name+'.json.gz')).read_bytes()
        assert sha(compressed)==proof['receiptGzipSha256']
        data=json.loads(gzip.decompress(compressed))
        assert data['rulesSha256']==PRIOR and data['privateReceipt']==proof['controllerSha256']
        for row in data['rows']:
            key=row['id']
            assert key not in requests
            before,=row['before']
            patch,=row['submitted']
            assert before['path']==patch['path'] and patch['op']=='update'
            requests[key]={'description':key, 'path':before['path'], 'method':'update',
                'auth':{'uid':row['actor']}, 'resource':before['data'],
                'data':before['data']|patch['data'], 'expectation':'ALLOW'}
            prior[key]=row['observed']
            answers[key]=original[key]
    assert len(requests)==190 and sum(answers.values())==92
    groups['original-190']=list(requests)
    for family in COHORTS[:COHORTS.index(through)+1]:
        d=HERE/'native'/family
        inputs=read(d/'positions.json')
        truth=run('bun','--no-install',OLD/'reference/native.mjs',d/'positions.json')
        assert truth==read(d/'native.json'), f'Frozen native evidence differs for {family}'
        submitted=run('bun','--no-install',HERE/'project.mjs','writes',data=inputs)
        ids=[]
        for fixture,ref,req in zip(inputs,truth['cases'],submitted,strict=True):
            key=fixture['id']
            assert ref['id']==req['description']==key and key not in ids
            if key in requests:
                assert requests[key]==req and answers[key]==ref['nativeAdmission'],key
            requests[key]=req
            answers[key]=ref['nativeAdmission']
            ids.append(key)
        groups[family]=ids
    return list(requests.values()),answers,prior,groups
