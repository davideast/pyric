"""Reproduce the cumulative chess oracle offline, or score another compiler package."""
import argparse
from collections import Counter, defaultdict
from gzip import decompress
from hashlib import sha256
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
from corpus import BATCHES, HERE, OLD, load
from score import score

REFERENCE = runpy.run_path(str(HERE.parent / 'for-of/replay.py'))
DISCOVERY = runpy.run_path(str(HERE / 'exploration/replay.py'))
DEFAULT = 'quick-packed-v5'


def read(path):
    return json.loads(path.read_bytes())


def observed(*args):
    return json.loads(subprocess.check_output(args, cwd=HERE))


def equal(result, expected, label):
    if result != expected:
        raise ValueError(f'Evidence changed for {label}')


def native_replay():
    cases, batches, _ = load(7)
    native = {c['id']: c['nativeAdmission'] for c in cases}
    for inputs, answers in [('positions','native'),('cost-position','cost-native'),('path-cost-controls','path-native')]:
        data = json.loads(subprocess.check_output(['bun','reference/native.mjs',inputs+'.json'],cwd=OLD))
        equal(data, read(OLD/'reference'/(answers+'.json')), 'file-pin '+inputs)
    for batch in BATCHES:
        folder = HERE/'batches'/batch/'v1'
        equal(observed('bun','reference/native.mjs',folder/'positions.json'),read(folder/'native.json'),batch+' native')
        equal(observed('bun','reference/mutations.mjs',batch),read(folder/'mutations.json'),batch+' mutation sensitivity')
    for folder in sorted((HERE/'exploration').glob('*/controls/native.json')):
        data = observed('bun','reference/native.mjs',folder.with_name('positions.json'))
        equal(data, read(folder), folder.parent.parent.name+' controls')
        for c in data['cases']:
            native[c['id']] = c['nativeAdmission']
    rights = HERE/'exploration/rights-claims-v1'
    wanted = {c['id'] for c in read(rights/'controls.json')}
    right_rows = json.loads(decompress((rights/'corpus.json.gz').read_bytes()))
    for c in right_rows:
        if c['id'] in wanted:
            native[c['id']] = c['nativeAdmission']
    equal(wanted - native.keys(), set(), 'successor rights controls')
    return native, batches


def hosted(native, digest, archive):
    # lookup verifies all completed receipts and permits unmeasured, queued releases.
    # Count repeated requests for the same exact bytes only once per case.
    args = ['--archive',archive] if archive else []
    data = observed('bun','live/run.mjs','lookup',digest,*args)
    joins, seen = defaultdict(Counter), set()
    for capture in data['captures']:
        for row in capture['decisions']:
            allowed = row['verdict'] == 'ALLOW'
            equal(row['versionChanged'],allowed,'stored match version '+row['id'])
            if row['id'] not in seen:
                truth = native.get(row['id'])
                outcome = ('unscored' if truth is None else 'match' if allowed == truth
                           else 'false-allow' if allowed else 'false-refusal')
                joins[row['batch']][outcome] += 1
                seen.add(row['id'])
    return {'rulesSha256':digest,'status':data['status'],'distinctCases':len(seen),'comparison':joins,
            'receipts':[c['receipt'] for c in data['captures']], 'managementFailures':data['managementFailures']}


def replay(args, temp):
    native, batches = native_replay()
    equal(observed(sys.executable,'registry/leaves.py'),{'claims':7,'cases':84},'registry coverage')
    equal(observed('bun','exploration/hosted-holdout-v1/freeze.mjs'),{'moves':10,'writes':30,'allowed':10},'hosted triads')
    for name, digest in REFERENCE['PINS'].items():
        equal(sha256((REFERENCE['VENDOR']/name).read_bytes()).hexdigest(),digest,name)
    equal(observed(sys.executable,'controls.py'),read(HERE/'scores/controls.json'),'candidate isolation controls')
    equal(observed('bun','reachable/v1/corpus.mjs'),read(HERE/'reachable/v1/freeze.json'),'historical successors')
    equal(observed('bun','terminal/table-v2/freeze.mjs'),read(HERE/'terminal/table-v2/native.json'),'three-piece outcomes')
    geometry = observed('bun','terminal/table-v2/prove.mjs')
    pkg = args.candidate_package
    if not pkg:
        pkg = temp/'candidate.tgz'
        subprocess.run([sys.executable,HERE/'terminal/v1/pack-split.py',pkg],check=True,stdout=subprocess.DEVNULL)
    bundle = temp/'complete.rules'
    core = score(pkg,7,args.variant,bundle,board_policy=True)
    result = {'packageSha256':core['candidateSha256'],'variant':args.variant,'coreBatches':core['batches'],
              'corePass':core['passed'],'diagnostics':core['diagnostics'],'nativeEndgames':geometry,
              'originalFilePins':len(batches['00-legacy-file'])}
    if not args.candidate_package and args.variant == DEFAULT:
        equal(core,read(HERE/'scores'/f'{DEFAULT}-through-7.json'),'qualified complete score and per-write local diagnostics')
    digest = core['linkedRulesSha256']
    if not digest:
        result['hosted'] = {'status':'unmeasured','rulesSha256':None}
        return result, False
    equal(sha256(bundle.read_bytes()).hexdigest(),digest,'exported release bytes')
    sdk = REFERENCE['install_rules'](REFERENCE['VENDOR']/'pyric-rules-0.1.0.tgz',temp/'ref')/'@pyric/rules'
    discovery = DISCOVERY['run'](bundle,sdk,True)
    result['discovery'] = {k:v for k,v in discovery.items() if k != 'reports'}
    history = {}
    for mode in ['played','legal']:
        detail = observed('bun','reachable/v1/measure.mjs',sdk,bundle,mode)
        equal(detail['rulesSha256'],digest,'historical Rules')
        history[mode] = {k:v for k,v in detail.items() if k not in ('byTrace','highestAllowed')}
    result['history'] = history
    result['hosted'] = hosted(native,digest,args.archive)
    if not args.candidate_package:
        # All retained deployments can be replayed from the same entry point. A plan can
        # exist before a receipt if an activation failed before Firestore saw any writes.
        result['releaseComparisons'] = [hosted(native,p.stem,args.archive) for p in sorted((HERE/'live/reviews').glob('*.json'))]
    target = result['hosted']
    matches = all(set(counts) <= {'match'} for counts in target.get('comparison',{}).values())
    return result, core['passed'] and discovery['allMatch'] and all(x['falseRefusals']==0 for x in history.values()) and matches


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--candidate-package',type=Path,help='offline @pyric/rules tarball scored in isolation')
    p.add_argument('--variant',default=DEFAULT)
    p.add_argument('--archive',type=Path,help='optionally authenticate each private Firestore journal')
    p.add_argument('--report',type=Path,help='also retain the JSON report at this path')
    args = p.parse_args()
    with tempfile.TemporaryDirectory(prefix='chess-safety-replay-') as scratch:
        result, matches = replay(args,Path(scratch))
    result['fullyMatchesMeasuredCases'] = matches
    output = json.dumps(result,indent=2)+'\n'
    if args.report:
        args.report.write_text(output)
    print(output,end='')
    return int(args.candidate_package is not None and not matches)


if __name__ == '__main__':
    sys.exit(main())
