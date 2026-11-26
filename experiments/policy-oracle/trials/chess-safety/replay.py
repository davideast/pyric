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
from score import score, score_rows, summarize
from receipt_comparison import compare
from scorecard import ROOK_MOVES, render
from qualification import check as verify_qualification, verify_thresholds

REFERENCE = runpy.run_path(str(HERE.parent / 'for-of/replay.py'))
DISCOVERY = runpy.run_path(str(HERE / 'exploration/replay.py'))
DEFAULT = 'knight-endgame-paired-pawn-combined-bare-fixed-comma-packed-v5'


def read(path):
    return json.loads(path.read_bytes())


def observed(*args):
    command = ('bun','--no-install',*args[1:]) if args[0]=='bun' else args
    return json.loads(subprocess.check_output(command, cwd=HERE))


def equal(result, expected, label):
    if result != expected:
        raise ValueError(f'Evidence changed for {label}')


def native_replay(control_files=None):
    if control_files is None:
        control_files = sorted((HERE/'exploration').glob('*/controls/positions.json'))
    cases, batches, _ = load(7)
    native = {c['id']: c['nativeAdmission'] for c in cases}
    for inputs, answers in [('positions','native'),('cost-position','cost-native'),('path-cost-controls','path-native')]:
        data = json.loads(subprocess.check_output(['bun','reference/native.mjs',inputs+'.json'],cwd=OLD))
        equal(data, read(OLD/'reference'/(answers+'.json')), 'file-pin '+inputs)
    for batch in BATCHES:
        folder = HERE/'batches'/batch/'v1'
        equal(observed('bun','reference/native.mjs',folder/'positions.json'),read(folder/'native.json'),batch+' native')
        equal(observed('bun','reference/mutations.mjs',batch),read(folder/'mutations.json'),batch+' mutation sensitivity')
    for positions in control_files:
        folder = positions.with_name('native.json')
        data = observed('bun','reference/native.mjs',positions)
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
    named = HERE/'reachable/lifecycle-v1/named/v1'
    equal(observed('bun',named/'freeze.mjs'),{'cases':4,'admitted':2},'genuine fourth ply and matched knight moves')
    for case in read(named/'native.json')['cases']:
        native[case['id']] = case['nativeAdmission']
    return native, batches


def hosted(native, digest, data, observations):
    # lookup verifies all completed receipts and permits unmeasured, queued releases.
    # Count repeated requests for the same exact bytes only once per case.
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
            'receipts':[c['receipt'] for c in data['captures']], 'managementFailures':[f for f in observations['managementFailures'] if f['intendedRulesSha256']==digest],
            'unqualified':[f for f in observations['unqualified'] if f['rulesSha256']==digest]}


def score_controls(native, sdk, rules, digest, control_files):
    reports = {}
    for filename in control_files:
        requests = observed('bun','inputs.mjs',filename)
        local = json.loads(subprocess.check_output(['bun',HERE/'baseline.mjs',sdk,rules],input=json.dumps(requests).encode()))
        equal(local['sha256'],digest,'same Rules for supplemental write controls')
        ids = [r['description'] for r in requests]
        equal([r['id'] for r in local['rows']],ids,'supplemental control order')
        cases = [{'id':key,'nativeAdmission':native[key]} for key in ids]
        reports[filename.parent.parent.name] = summarize(score_rows(cases,local['rows'],'nativeAdmission'))
    return reports


def build_recorded_package(variant, temp):
    target = temp/'candidate.tgz'
    def build(*args):
        subprocess.run([sys.executable,*args],cwd=HERE,check=True,stdout=subprocess.DEVNULL)
    if variant in ('king-reply', 'king-reply-v2', 'king-reply-v3', 'king-reply-v4', 'king-reply-v5'):
        build('mobility/pack.py',target)
    elif 'combined-' in variant:
        build('mobility/pack.py','--split',target)
    elif variant.startswith('indexed-'):
        source = temp/'split.tgz'
        build('terminal/v1/pack-split.py',source)
        build('terminal/table-v2/pack.py',source,target)
    elif variant.startswith(('quick-','reply-','table-','pattern-')):
        build('terminal/v1/pack-split.py',target)
    elif 'packed' in variant:
        build('policy/pack-candidate.py',target)
    else:
        return HERE.parent/'ordered-guards/vendor/pyric-rules-ordered-guards.tgz'
    return target


def replay(args, temp):
    control_files = sorted((HERE/'exploration').glob('*/controls/positions.json'))
    native, batches = native_replay(control_files)
    equal(observed(sys.executable,'registry/leaves.py'),{'claims':7,'cases':84},'registry coverage')
    equal(observed('bun','exploration/hosted-holdout-v1/freeze.mjs'),{'moves':10,'writes':30,'allowed':10},'hosted triads')
    for name, digest in REFERENCE['PINS'].items():
        equal(sha256((REFERENCE['VENDOR']/name).read_bytes()).hexdigest(),digest,name)
    equal(observed(sys.executable,'controls.py'),read(HERE/'scores/controls.json'),'candidate isolation controls')
    equal(observed(sys.executable,'board_controls.py'),read(HERE/'scores/board-controls.json'),'malformed board API controls')
    equal(observed('bun','reachable/v1/corpus.mjs'),read(HERE/'reachable/v1/freeze.json'),'historical successors')
    equal(observed('bun','terminal/table-v2/freeze.mjs'),read(HERE/'terminal/table-v2/native.json'),'three-piece outcomes')
    geometry = observed('bun','terminal/table-v2/prove.mjs')
    pkg = args.candidate_package
    if not pkg:
        pkg = build_recorded_package(args.variant,temp)
    bundle = temp/'complete.rules'
    core = score(pkg,7,args.variant,bundle,board_policy=True)
    result = {'packageSha256':core['candidateSha256'],'variant':args.variant,'coreBatches':core['batches'],
              'corePass':core['passed'],'diagnostics':core['diagnostics'],'nativeEndgames':geometry,
              'originalFilePins':len(batches['00-legacy-file'])}
    emitted_dir = HERE/'terminal/emitted-bare-v1'
    verify_shards = runpy.run_path(str(emitted_dir/'summarize.py'))['checked_archive']
    result['archivedBareHelpers'] = [verify_shards(leaf.parent) for leaf in sorted(emitted_dir.glob('*/summary.json'))]
    result['primaryNative'] = {name:{'allow':sum(native[key] for key in ids),'deny':sum(not native[key] for key in ids)}
                             for name,ids in batches.items()}
    result['rookMoves'] = [row for row in core['linkedWrites'] if row['id'] in ROOK_MOVES]
    result['coreDiagnostics'] = {}
    for plane in ('kingSafety','standaloneBoard','linkedWrites'):
        rows = core[plane]
        errors = Counter(row['error'] for row in rows if row.get('error'))
        result['coreDiagnostics'][plane] = {'outcomes':dict(Counter(row['status'] for row in rows)),
            'errors':dict(errors),'firstResourceLimit':next((row for row in rows if row.get('error')=='resource-limit'),None)}
    if not args.candidate_package and args.variant == DEFAULT:
        equal(core,read(HERE/'scores'/f'{DEFAULT}-through-7.json'),'qualified complete score and per-write local diagnostics')
    digest = core['linkedRulesSha256']
    if not digest:
        result.update({'hosted':{'status':'unmeasured','rulesSha256':None},'releaseComparisons':[],
                       'localConformance':False,'matchesObservedProductionCases':None})
        return result, False
    equal(sha256(bundle.read_bytes()).hexdigest(),digest,'exported release bytes')
    target_scan = observed(sys.executable,'compiler-boundaries/regex-literal-v1/inspect.py',bundle)
    equal(target_scan['rulesSha256'],digest,'complete source scanned for literal constraints')
    result['targetRegexLiterals'] = target_scan
    sdk = REFERENCE['install_rules'](REFERENCE['VENDOR']/'pyric-rules-0.1.0.tgz',temp/'ref')/'@pyric/rules'
    discovery = DISCOVERY['run'](bundle,sdk,True,extended_endings=True,bare_defender=True,knight_replies=True)
    result['discovery'] = {k:v for k,v in discovery.items() if k != 'reports'}
    reference_report = temp/'scored-cohorts.json'
    reference_report.write_text(json.dumps(result['discovery']))
    result['residuals'] = observed('bun','exploration/residuals-v1/measure.mjs',sdk,bundle,reference_report)
    rays = HERE/'exploration/absolute-rays-v1'
    equal(observed('bun',rays/'freeze.mjs'),read(rays/'freeze.json'),'absolute pin ray geometry and successors')
    result['absolutePinRays'] = observed('bun','exploration/self-check-v1/measure.mjs',sdk,bundle,'absolute-rays-v1')
    equal(result['absolutePinRays']['rulesSha256'],digest,'absolute pin ray release')
    result['supplementalControls'] = score_controls(native,sdk,bundle,digest,control_files)
    named = read(HERE/'reachable/lifecycle-v1/named/v1/inputs.json')['cases']
    requests = [{'description':case['id'],'method':'update','path':'chess/oracle','auth':{'uid':case['before'][case['before']['currentTurn']]},
                 'resource':case['before'],'data':case['pending'],'expectation':'ALLOW'} for case in named]
    named_run = json.loads(subprocess.check_output(['bun',HERE/'baseline.mjs',sdk,bundle],input=json.dumps(requests).encode()))
    equal(named_run['sha256'],digest,'genuine fourth-ply release')
    equal([r['id'] for r in named_run['rows']],[c['id'] for c in named],'genuine snapshot identity')
    truths = [{'id':case['id'],'nativeAdmission':native[case['id']]} for case in named]
    result['namedSnapshots'] = score_rows(truths,named_run['rows'],'nativeAdmission')
    ep = HERE/'exploration/en-passant-evasions-v1'
    equal(observed('bun',ep/'freeze.mjs'),read(ep/'freeze.json'),'en passant double-push predecessors')
    pair_count = observed('bun',ep/'pairs.mjs')['pairedBoards']
    result['enPassantContinuations'] = observed('bun',ep/'score.mjs',sdk,bundle)
    equal(result['enPassantContinuations']['rulesSha256'],digest,'en passant continuation rules')
    equal(result['enPassantContinuations']['pairs'],pair_count,'paired en passant sample')
    history = {}
    for mode in ['played','legal']:
        detail = observed('bun','reachable/v1/measure.mjs',sdk,bundle,mode)
        equal(detail['rulesSha256'],digest,'historical Rules')
        history[mode] = {k:v for k,v in detail.items() if k not in ('byTrace','highestAllowed')}
    result['history'] = history
    lifecycle = HERE/'reachable/lifecycle-v1'
    equal(observed('bun',lifecycle/'freeze.mjs'),read(lifecycle/'freeze.json'),'actual match histories and heads')
    run = observed('bun',lifecycle/'measure.mjs',sdk,bundle)
    equal(run['rulesSha256'],digest,'match lifecycle Rules')
    result['lifecycle'] = {k:v for k,v in run.items() if k!='byTrace'}
    result['sealedReferee'] = {'status':'not-run'}
    sealed_pass = True
    if args.sealed_referee:
        folder = HERE/'reachable/sealed-v1'
        frozen = read(folder/'freeze.json')
        equal(observed('bun',folder/'authority.mjs',args.sealed_referee),frozen,'sealed exact successors')
        held = observed('bun',folder/'measure.mjs',args.sealed_referee,sdk,bundle)
        equal(held['rulesSha256'],digest,'sealed tested Rules')
        result['sealedReferee'] = {'status':'scored',**held}
        ray_proof = observed(sys.executable,rays/'independent.py',args.sealed_referee/'chess-1.11.2.tar.gz')
        equal(ray_proof,read(rays/'third-referee.json'),'independent chess reference on every absolute pin twin')
        sealed_pass = not held['first']
    journal_args = ['--archive',args.archive] if args.archive else []
    observations = observed('bun','live/run.mjs','observed',*journal_args)
    captures = {r['rulesSha256']:r for r in observations['releases']}
    result['hosted'] = hosted(native,digest,captures.get(digest,{'status':'unmeasured','captures':[]}),observations)
    result['management'] = {k:observations[k] for k in ['managementFailures','unqualified','privateJournalChecked','compilerRejections','compileDiagnostics']}
    diagnostics = [r for r in observations['compileDiagnostics'] if r['rulesSha256']==digest]
    if len(diagnostics)>1:
        raise ValueError('Expected one official static diagnostic for these bytes')
    target_compilation = diagnostics[0]['state'] if diagnostics else ('compiled' if result['hosted']['distinctCases'] else 'unmeasured')
    result['targetCompilation'] = {'status':target_compilation,'staticTest':diagnostics[0] if diagnostics else None,
        'publicationRejections':[r for r in observations['compilerRejections'] if r['intendedRulesSha256']==digest]}
    if target_compilation=='compile-error' and result['hosted']['distinctCases']:
        raise ValueError('Conflicting official compiler and data-plane evidence for identical bytes')
    result['targetCompilerControls'] = verify_thresholds(observations['compileDiagnostics'])
    result['openings'] = []
    for pin in sorted((HERE/'live/openings').glob('*/*.pin.json')):
        name = pin.name.removesuffix('.pin.json')
        result['openings'].append({'plan':name,'rulesSha256':pin.parent.name,
            **observed('bun','live/opening.mjs','replay',name,*([args.archive] if args.archive else []))})
    if not args.candidate_package or args.scorecard:
        # All retained deployments can be replayed from the same entry point. A plan can
        # exist before a receipt if an activation failed before Firestore saw any writes.
        result['releaseComparisons'] = compare(native,sdk,captures)
    if args.sealed_referee:
        digests = sorted({digest,'523c4c137aa00c2c764264aa6c2cefeda7c692561544da45d4fcccf3a2056fda'})
        result['independentSignedInputs'] = observed(sys.executable,'reference/signed-inputs.py',
            args.sealed_referee/'chess-1.11.2.tar.gz',*digests)
    if args.archive and args.sealed_referee:
        audit = HERE/'exploration/independent-review'
        matched = observed(sys.executable,audit/'matched-signed.py',HERE,args.archive,
            args.sealed_referee/'chess-1.11.2.tar.gz')
        equal(matched,read(audit/'matched-signed.json'),'independent raw 190-case comparison')
        result['matchedSignedAudit'] = {'inputs':matched['signedInputsInCommon'],
            'payloadsSha256':matched['payloadsSha256']}
    target = result['hosted']
    local_pass = (sealed_pass and run['matchedAll'] and core['passed'] and discovery['allMatch']
                  and all(r['status']=='match' for r in result['namedSnapshots'])
                  and result['absolutePinRays']['stats']=={'match':read(rays/'freeze.json')['writes']} and not result['enPassantContinuations']['first']
                  and all(r['counts']=={'match':r['cases']} for r in result['supplementalControls'].values())
                  and all(x['allow']==x['writes'] for x in history.values()))
    matches = all(set(counts) <= {'match'} for counts in target['comparison'].values()) if target['distinctCases'] else None
    result['localConformance'] = local_pass
    result['matchesObservedProductionCases'] = matches
    return result, local_pass and matches is not False and target_compilation!='compile-error'


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--candidate-package',type=Path,help='offline @pyric/rules tarball scored in isolation')
    p.add_argument('--variant',default=DEFAULT)
    p.add_argument('--sealed-referee',type=Path,help='also score the prior private chess reference archive')
    p.add_argument('--archive',type=Path,help='optionally authenticate each private Firestore journal')
    p.add_argument('--historical-revisions', action='store_true', help='also rebuild and rescore each saved compiler revision')
    p.add_argument('--report',type=Path,help='also retain the JSON report at this path')
    p.add_argument('--summary',action='store_true',help='print a compact human-readable result instead of the full JSON')
    p.add_argument('--scorecard',type=Path,help='also render the recorded release comparison in Markdown')
    args = p.parse_args()
    for name in ('candidate_package', 'sealed_referee', 'archive'):
        path = getattr(args, name)
        if path is not None:
            setattr(args, name, path.resolve(strict=True))
    with tempfile.TemporaryDirectory(prefix='chess-safety-replay-') as scratch:
        result, matches = replay(args,Path(scratch))
    result['passesScoredCases'] = matches
    if args.candidate_package is None and args.variant == DEFAULT:
        directory = HERE/'qualification/v1'/result['hosted']['rulesSha256']
        result['qualification'] = verify_qualification(result, directory)
    if args.historical_revisions:
        matrix = observed(sys.executable, 'revisions/verify.py')
        result['historicalRevisions'] = {
            'scored': len(matrix),
            'emitted': sum(bool(record.get('linkedRulesSha256')) for record in matrix),
            'archives': [record['archive'] for record in matrix],
        }
    output = json.dumps(result,indent=2)+'\n'
    if args.report:
        args.report.write_text(output)
    if args.scorecard:
        args.scorecard.write_text(render(result))
    if args.summary:
        print(f"{result['variant']} — {result['hosted'].get('rulesSha256') or 'no linked Rules'}")
        for plane in ('kingSafety','standaloneBoard','linkedWrites'):
            print(f"  Primary {plane}: {result['coreDiagnostics'][plane]['outcomes']}")
        if 'discovery' in result:
            print(f"  Additional cases: {result['discovery']['outcomes']}")
            print(f"  Absolute pin twins: {result['absolutePinRays']['stats']}")
            run=result['lifecycle']
            print(f"  Complete match histories: {run['completePrefixes']}/{run['traces']}; {run['outcomes']}")
        print(f"  Official compilation: {result.get('targetCompilation',{}).get('status','unmeasured')}")
        print(f"  Authenticated Firestore writes: {result['hosted'].get('distinctCases',0)} distinct "
              f"({result['hosted']['status']})")
        if 'historicalRevisions' in result:
            review = result['historicalRevisions']
            print(f"  Historical revisions reproduced: {review['scored']} ({review['emitted']} emitted Rules)")
        if args.scorecard:
            print(f"  Scorecard: {args.scorecard.resolve()}")
    else:
        print(output,end='')
    return int(args.candidate_package is not None and not matches)


if __name__ == '__main__':
    sys.exit(main())
