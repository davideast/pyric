"""Compare independently retained Firestore writes with the same Rules in the pinned local evaluator."""
from collections import Counter, defaultdict
from gzip import decompress
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys

sys.dont_write_bytecode = True
from corpus import HERE


def compare(native, sdk, captures):
    releases = []
    for review in sorted((HERE/'live/reviews').glob('*.json')):
        spec = json.loads(review.read_bytes())
        digest = spec['rulesSha256']
        hosted = captures.get(digest, {'status':'unmeasured','captures':[]})
        source = (HERE/'live'/spec['file']).resolve()
        if sha256(source.read_bytes()).hexdigest()!=digest:
            raise ValueError(f'Review changed for {digest}')
        batches, distinct, disagreements = defaultdict(Counter), {}, []
        for capture in hosted['captures']:
            name = capture['plan']
            receipt = HERE/'live/receipts'/digest/(name+'.json.gz')
            raw = json.loads(decompress(receipt.read_bytes()))
            if raw['privateReceipt']!=capture['receipt'] or len(raw['rows'])!=len(capture['decisions']):
                raise ValueError(f'Unexpected raw journal for {name}')
            requests = []
            for row in raw['rows']:
                before = row['before'][0]['data']
                patch = row['submitted'][0]
                requests.append({'description':row['id'],'auth':{'uid':row['actor']},'method':'update','path':patch['path'],
                                 'resource':before,'data':{**before,**patch['data']},'expectation':'ALLOW'})
            local = json.loads(subprocess.check_output(['bun',HERE/'baseline.mjs',sdk,source],input=json.dumps(requests).encode()))
            if local['sha256']!=digest or len(local['rows'])!=len(requests):
                raise ValueError('Local evaluator did not reproduce original Rules or number of requests')
            for server, sim, row in zip(capture['decisions'],local['rows'],raw['rows'],strict=True):
                key = row['id']; batch = server['batch']
                if key!=sim['id'] or key!=server['id'] or row['observed']!=server['verdict']:
                    raise ValueError(f'Case identity or live verdict changed for {key}')
                outcome = {'batch':batch,'native':('ALLOW' if native[key] else 'DENY') if key in native else 'unscored',
                           'production':server['verdict'],'local':sim['decision'],'localError':sim.get('error'),
                           'localExpressions':sim['cost']}
                if key in distinct:
                    if distinct[key]!=outcome:
                        raise ValueError(f'Repeated case produced different answers for {key}')
                    continue
                distinct[key] = outcome
                bins = batches[batch]; bins['cases']+=1
                bins['nativeMatches']+=outcome['native']==outcome['production']
                bins['localVerdictMatches']+=outcome['local']==outcome['production']
                bins['localErrors']+=bool(outcome['localError'])
                bins['unscoredNative']+=key not in native
                bins['falseAllows']+=outcome['production']=='ALLOW' and outcome['native']=='DENY'
                bins['falseRefusals']+=outcome['production']=='DENY' and outcome['native']=='ALLOW'
                if outcome['native']!=outcome['production'] or outcome['local']!=outcome['production'] or outcome['localError']:
                    disagreements.append({'id':key,**outcome,'receipt':str(receipt.relative_to(HERE)),'versions':[row['before'][0]['version'],row['after'][0]['version']]})
        releases.append({'rules':str(source.relative_to(HERE)) if source.is_relative_to(HERE) else spec['file'],
                         'sha256':digest,'receipts':[c['receipt'] for c in hosted['captures']],
                         'status':hosted['status'],'productionCases':len(distinct),'batches':batches,
                         'examples':{k:v for k,v in distinct.items() if k.startswith(('holdout-black-queen-corner-','sole-pawn-w-','actual-fourth-ply-','knight-reply-477','knight-reply-483','rook-safe','rook-exposed','rook-c5-after-queen-','rook-h5-after-queen-','promote-capturing-rook-right-'))},
                         'disagreements':disagreements})
    return releases
