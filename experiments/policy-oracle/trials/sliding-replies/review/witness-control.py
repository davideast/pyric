"""Check whether a destination encoding defect escapes boolean role and status checks."""
import argparse
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path
import re
import subprocess
import tempfile

HERE=Path(__file__).resolve().parent


def measure(sdk,rules):
    return json.loads(subprocess.check_output(['bun','--no-install',HERE/'witness.mjs',sdk,rules,'--focused']))


def control(sdk,source):
    original=source.read_text()
    # In the integer result, keeping the destination marker adds one to the
    # reported mailbox column. Both branches keep their original expression cost.
    pattern=r"""(\bfirst\.replace\('X\.\*',\s*)''(\)\.size\(\))"""
    faulty,count=re.subn(pattern,lambda m:m[1]+"'X'"+m[2],original)
    if not count: raise ValueError('Expected an emitted numeric destination encoder')
    baseline=measure(sdk,source)
    with tempfile.TemporaryDirectory(prefix='sliding-encoding-mutant-') as folder:
        path=Path(folder)/'wrong-destination.rules';path.write_text(faulty)
        mutant=measure(sdk,path)
    assert baseline['rulesSha256']!=mutant['rulesSha256']
    signed=[]
    for a,b in zip(baseline['routes'],mutant['routes'],strict=True):
        assert a['id']==b['id']
        if (a['local'],a['error'],a['expressions'])!=(b['local'],b['error'],b['expressions']): signed.append(a['id'])
    lost=[]
    counts=Counter()
    for before,after in zip(baseline['focused'],mutant['focused'],strict=True):
        assert before['id']==after['id'] and before['supported']==after['supported']
        counts[after['outcome']]+=1
        if before['supported'] and before['outcome']=='legal-witness' and after['outcome']=='illegal-witness':
            lost.append({'id':before['id'],'original':before['move'],'faulty':after['move'],'native':before['expected']})
    assert lost and not signed,(lost,signed)
    return {'authority':'pinned independent local evaluator; diagnostic control only',
            'originalRulesSha256':sha256(original.encode()).hexdigest(),'faultyRulesSha256':sha256(faulty.encode()).hexdigest(),
            'destinationEncodersChanged':count,'fullClaimRoutesCompared':len(baseline['routes']),
            'changedFullClaimDecisionErrorOrCost':signed,'wronglyEncodedLegalWitnesses':len(lost),
            'focusedFaultyOutcomes':dict(counts),'firstDivergence':lost[0]}


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('pinned_sdk',type=Path);p.add_argument('complete_rules',type=Path)
    a=p.parse_args();print(json.dumps(control(a.pinned_sdk,a.complete_rules),indent=2))
