"""Score a Pyric compiler on immutable reply and full Arcade write inputs."""
import argparse
import copy
import base64
from collections import Counter
import json
from pathlib import Path
from typing import NamedTuple
import re
import runpy
import subprocess
import sys
import tempfile

sys.dont_write_bytecode=True
from campaign_corpus import HERE, OLD, ROOT, FAMILIES, PRIOR, RULES, digest, load, read, run, sha

sys.path.insert(0,str(ROOT/'core'))
from candidate import MAX_PACKAGE
from offline_runtime import side
from history import projection, record

TOOLS=runpy.run_path(str(OLD.parent/'for-of/replay.py'))
REL=HERE.relative_to(ROOT).as_posix()
PKG='/oracle/arcade/runtime/node_modules/@pyric/rules'
BOARD_SOURCE='trials/chess/policies/chess.policy'
PUBLIC_API='trials/king-safety/policy/public-api.mjs'
DEFAULT_PACKAGE_SHA='98995632ebf810afa49c3e03ee7fc0bac31e3c8ff841327ffa8a3eddda2a9356'

def task(name,args):
    return {'engine':'bun','runner':'/oracle/'+REL+'/'+name,'args':args}


def chunks(value):
    encoded=base64.b64encode(json.dumps(value,separators=(',',':')).encode()).decode()
    return [encoded[i:i+30000] for i in range(0,len(encoded),30000)]


def candidate_outputs(package,variant,positions):
    files={REL+'/standalone.mjs',REL+'/sliding-replies.policy',BOARD_SOURCE,PUBLIC_API}
    jobs={'standalone':task('standalone.mjs',[PKG,*chunks(positions)])}
    if variant!='prior':
        manifest=read(HERE/'compiler/inputs.json')
        files.update(manifest)
        files.update(file.relative_to(ROOT).as_posix() for file in (HERE/'compiler').glob('*') if file.suffix in ('.mjs','.policy'))
        files.update(REL+'/'+file for file in ('emit-worker.mjs','policy-variant.mjs','protocol/dense.mjs','protocol/shared-status.mjs','protocol/lean.mjs','protocol/target-rays.mjs','protocol/file-check.mjs'))
        jobs['emit']=task('emit-worker.mjs',[PKG,variant])
    with package.open('rb') as stream:
        data=stream.read(MAX_PACKAGE+1)
    if len(data)>MAX_PACKAGE:
        raise ValueError('Submitted package exceeds offline worker limit')
    result=side(ROOT,data,jobs,reference=False,timeout=300,pinned_paths=files)
    if 'installError' in result:
        return sha(data),{},result['installError']
    return sha(data),result['tasks'],None


def prepare(requests):
    encoded=run('bun','--no-install',HERE/'project.mjs','positions',data=requests)
    native=run('bun','--no-install',HERE/'reference.mjs',data=requests)
    positions,expected,by_id={}, {}, {}
    for request,position,verdict in zip(requests,encoded,native,strict=True):
        if not verdict['eligible']:
            continue
        key=digest(position)
        if key in expected and expected[key]!=verdict:
            raise ValueError('Conflicting independent reply answers for the same position')
        positions[key]=position
        expected[key]=verdict
        by_id[request['description']]=key
    return positions,expected,by_id


def check_standalone(outputs,install_error,positions,expected,by_id,groups):
    worker=outputs.get('standalone',{})
    predictions=worker.get('output')
    err=install_error or worker.get('error')
    if not err and (not isinstance(predictions,list) or len(predictions)!=len(positions)):
        err='incomplete standalone output'
    rows={}
    for index,key in enumerate(positions):
        answer=expected[key]
        prediction=predictions[index] if not err else None
        error=err or (prediction.get('error') if isinstance(prediction,dict) else 'invalid standalone output')
        match=not error and prediction=={field:answer[field] for field in ('all','sliding','outcome')}
        rows[key]={'status':'standalone-error' if error else 'match' if match else 'disagreement',
                   'pyric':prediction,'native':{field:answer[field] for field in ('all','sliding','outcome')}}
        if error: rows[key]['error']=error
    return {'eligibleRequests':len(by_id),'distinctPositions':len(rows),'outcomes':dict(Counter(r['status'] for r in rows.values())),
            'positionByRequest':by_id,'positions':rows,
            'familyOutcomes':{group:dict(Counter(rows[by_id[k]]['status'] for k in ids if k in by_id)) for group,ids in groups.items()}}


def evaluate(requests,answers,rules_file,reference):
    measured=run('bun','--no-install',OLD/'baseline.mjs',reference,rules_file,data=requests)
    if measured['sha256']!=sha(rules_file.read_bytes()) or len(requests)!=len(measured['rows']):
        raise ValueError('Independent evaluator source or case count mismatch')
    rows={}
    for request,record in zip(requests,measured['rows'],strict=True):
        key=request['description']
        assert key==record['id']
        target='ALLOW' if answers[key] else 'DENY'
        decision=record['decision']
        if decision not in ('ALLOW','DENY'): raise ValueError('Missing Rules decision')
        if record.get('error') and target==decision:
            status='evaluation-error'
        elif target==decision:
            status='match'
        else:
            status='false-allow' if decision=='ALLOW' else 'false-refusal'
        rows[key]={'native':target,'decision':decision,'status':status,'localExpressions':record['cost']}
        if record.get('error'): rows[key]['diagnostic']=record['error']
    return rows


def aggregate(rows,ids):
    return {'cases':len(ids),'outcomes':dict(Counter(rows[k]['status'] for k in ids)),
            'diagnostics':dict(Counter(rows[k]['diagnostic'] for k in ids if 'diagnostic' in rows[k]))}


def difference(before,after,ids):
    return {'repaired':[k for k in ids if before[k]['status']!='match' and after[k]['status']=='match'],
            'regressed':[k for k in ids if before[k]['status']=='match' and after[k]['status']!='match'],
            'remaining':[k for k in ids if before[k]['status']!='match' and after[k]['status']!='match']}


def material_profile(variant):
    if variant=='prior': return None
    if variant.startswith('rook-'): return 'rook'
    if variant.startswith('bishop-'): return 'bishop'
    if variant.startswith('all-two-defenders-'): return 'queen-with-knight-or-rooks'
    generation=re.search(r'(?:^|-)v(\d+)(?:-|$)',variant)
    if generation and int(generation[1])>=9: return 'including-sole-knight'
    return 'queen'


class ReferenceSuite(NamedTuple):
    requests: list
    answers: dict
    groups: dict
    positions: dict
    expected: dict
    by_id: dict
    native_evidence: dict
    reference: Path
    original: dict
    default_package: Path


def reference_suite(args,scratch):
    # Only the immutable referee and its inputs are shared. Each compiler
    # revision still runs an isolated package, standalone policy and full writes.
    native_evidence=run(sys.executable,'-B',HERE/'native/verify.py',
                        *(['--python-chess-archive',args.python_chess_archive] if args.python_chess_archive else []))
    requests,answers,prior,groups=load(args.through)
    positions,expected,by_id=prepare(requests)
    default_package=scratch/'compiler.tgz'
    if not args.candidate_package or args.with_history:
        subprocess.run([sys.executable,OLD/'mobility/pack.py','--split',default_package],check=True,stdout=subprocess.DEVNULL)
        if sha(default_package.read_bytes())!=DEFAULT_PACKAGE_SHA: raise ValueError('Recorded compiler package changed')
    assert sha(RULES.read_bytes())==PRIOR
    ref_pkg=TOOLS['VENDOR']/'pyric-rules-0.1.0.tgz'
    assert sha(ref_pkg.read_bytes())==TOOLS['PINS'][ref_pkg.name]
    reference=TOOLS['install_rules'](ref_pkg,scratch/'reference')/'@pyric/rules'
    original=evaluate(requests,answers,RULES,reference)
    assert all(original[k]['decision']==v for k,v in prior.items())
    assert aggregate(original,groups['original-190'])['outcomes']=={'match':182,'false-allow':7,'false-refusal':1}
    return ReferenceSuite(requests,answers,groups,positions,expected,by_id,native_evidence,reference,original,default_package)


def replay(args,scratch,suite):
    requests,answers,groups=suite.requests,suite.answers,suite.groups
    positions,reference,original=suite.positions,suite.reference,suite.original
    package_sha,outputs,install_error=candidate_outputs(args.candidate_package or suite.default_package,args.variant,list(positions.values()))
    standalone=check_standalone(outputs,install_error,list(positions),suite.expected,suite.by_id,groups)
    release=outputs.get('emit',{})
    error=install_error or release.get('error')
    path=scratch/'complete.rules'
    if args.variant=='prior':
        path.write_bytes(RULES.read_bytes())
    elif not error:
        modules=release.get('output')
        if not isinstance(modules,dict) or not modules or sum(len(str(x)) for x in modules.values())>1024*1024:
            error='Compiler returned an invalid module map'
        else:
            linked=subprocess.run(['bun','--no-install',HERE/'link.mjs',reference,args.variant],
                                  input=json.dumps(modules),text=True,capture_output=True)
            if linked.returncode:
                error='link-error: '+linked.stderr[-1500:]
            else:
                path.write_text(json.loads(linked.stdout)['source'])
    result={'variant':args.variant,'through':args.through,'nativeEvidence':suite.native_evidence,'packageSha256':package_sha,'standalone':standalone,
            'requestSha256':digest(requests),'nativeSha256':digest(answers),'groups':groups,
            'nativeVerdicts':{key:'ALLOW' if allowed else 'DENY' for key,allowed in answers.items()},
            'prior':{'rulesSha256':PRIOR,'signedNativeMatches':182,'distinctSigned':190,
                     'localGroups':{g:aggregate(original,ids) for g,ids in groups.items()}}}
    if not path.exists():
        result.update(compile={'status':'install-error' if install_error else 'link-error' if str(error).startswith('link-error:') else 'cannot-compile','error':error},
                      live={'status':'unmeasured','rulesSha256':None,'distinctCases':0},passes=False)
        return result
    rules_sha=sha(path.read_bytes())
    if args.emit: args.emit.write_bytes(path.read_bytes())
    if args.example_dir:
        if args.variant=='prior': raise ValueError('Prior release has no compiled sliding-reply modules')
        example=run('bun','--no-install',HERE/'examples.mjs',args.variant,data={'modules':modules,'source':path.read_text()})
        directory=args.example_dir
        directory.mkdir(parents=True,exist_ok=True)
        for name,key in [('rook-pair.policy','pyric'),('rook-pair.rules','rules')]:
            (directory/name).write_text(example[key])
        result['example']={'functions':example['names'],'rulesSha256':rules_sha}
    result['compile']={'status':'emitted','rulesSha256':rules_sha,'bytes':path.stat().st_size}
    live=run('bun','--no-install',HERE/'live/run.mjs','lookup',rules_sha,
             *(['--archive',args.archive.resolve()] if args.archive else []))
    assert live['rulesSha256']==rules_sha
    observed={row['id']:row['verdict'] for row in live['rows']}
    assert len(observed)==live['distinctCases']
    joined={}
    for key in answers:
        if key in observed:
            decision=observed[key]
            match=(decision=='ALLOW')==answers[key]
            joined[key]={'decision':decision,'status':'match' if match else 'false-allow' if decision=='ALLOW' else 'false-refusal'}
    result['live']=live|{'groups':{g:dict(Counter(joined[k]['status'] for k in ids if k in joined))
                                  for g,ids in groups.items()},
                         'nativeMatches':sum(row['status']=='match' for row in joined.values()),
                         'disagreements':{k:v for k,v in joined.items() if v['status']!='match'}}
    try:
        local=original if rules_sha==PRIOR else evaluate(requests,answers,path,reference)
    except (subprocess.CalledProcessError,ValueError) as error:
        result.update(local={'status':'evaluator-error','error':str(error)},passes=False)
        return result
    result['local']={'rows':local,'overall':aggregate(local,list(answers)),'groups':{g:aggregate(local,ids) for g,ids in groups.items()},
                     'changes':{g:difference(original,local,ids) for g,ids in groups.items()}}
    result['live']['localDisagreements']=[k for k in joined if observed[k]!=local[k]['decision']]
    witness=run('bun','--no-install',HERE/'review/witness.mjs',reference,path,
                *([] if args.witness_panel else ['--focused']))
    assert witness['rulesSha256']==rules_sha
    selected={read(HERE/'native'/group/'independent.json')['boards'][i]['id']
              for group in groups if group in FAMILIES for i in range(len(groups[group])//3)}
    scored=[r for r in witness['focused'] if r['id'] in selected]
    assert len(scored)==len(selected)
    witness['verifiedFocused']=sum(r['supported'] is True and r['outcome'] in ('legal-witness','correct-absence') for r in scored)
    witness['requiredFocused']=len(scored)
    use=witness.get('fullWriteDerivation',{}).get('byBoard',{})
    witness['requiredWritePaths']=2*len(scored)
    witness['verifiedWritePaths']=sum(use.get(board,{}).get('verified',0) for board in selected)
    profile=material_profile(args.variant)
    witness['materialProfile']=profile
    witness['uncertainScope']={}
    scopes=('focused','panel','otherTurns') if args.witness_panel else ('focused',)
    if profile:
        for cohort in scopes:
            counts=witness.get('materialAudit',{}).get(cohort,{}).get('promises',{}).get(profile)
            if counts is None: witness['uncertainScope'][cohort]={'unverified':1}
            else:
                errors={k:v for k,v in counts.items() if k not in ('included','excluded') and v}
                if errors: witness['uncertainScope'][cohort]=errors
    witness['panelErrors']={}
    if args.witness_panel:
        roster=witness.get('rosterControls',{})
        if profile and roster:
            qualification=roster['materialAudit']['qualification'][profile]
            if not qualification['passes']: witness['uncertainScope']['roster']=qualification
            included={row['id'] for row in roster['scores'] if row['supported']}
            wrong=[row['id'] for row in roster['routes'] if row['id'].rsplit('-',1)[0] in included
                   and (row['local']!=row['expected'] or row['error'])]
            if wrong: witness['panelErrors']['rosterWrites']=wrong
        for cohort in ('panel','otherTurns'):
            statuses=witness.get(cohort,{}).get('scopes',{})
            errors={k:v for k,v in statuses.get('guard-true',{}).items() if k not in ('legal-witness','correct-absence') and v}
            if statuses.get('guard-error'): errors['guard-error']=sum(statuses['guard-error'].values())
            if errors: witness['panelErrors'][cohort]=errors
    if args.witness_panel and ('-dense3' in args.variant or '-boxed' in args.variant):
        measured=subprocess.run(['bun','--no-install',HERE/'protocol/dense-probe.mjs',reference,path],
                                capture_output=True,text=True)
        if measured.stdout:
            details=json.loads(measured.stdout)
            assert details['rulesSha256']==rules_sha
            result['densePanel']=details
        if measured.returncode:
            witness['panelErrors']['dense']=measured.stderr[-1000:] or result.get('densePanel',{}).get('outcomes')
    result['compiledWitness']=witness
    result['localConforms']=(witness['verifiedFocused']==len(scored)
                             and witness['verifiedWritePaths']==witness['requiredWritePaths']
                             and not witness['uncertainScope'] and not witness['panelErrors']) and all(r['status']=='match' for r in local.values()) and all(
        r['status']=='match' for r in standalone['positions'].values())
    result['passes']=result['localConforms'] and len(joined)==len(answers) and all(
        row['status']=='match' for row in joined.values())
    return result


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--candidate-package',type=Path)
    p.add_argument('--variant')
    p.add_argument('--through',choices=FAMILIES,default='queen')
    p.add_argument('--python-chess-archive',type=Path,help='re-adjudicate frozen native answers with the pinned chess sdist')
    p.add_argument('--archive',type=Path,help='verify private production journals in addition to portable receipts')
    p.add_argument('--emit',type=Path,help='retain complete emitted Arcade Rules')
    p.add_argument('--report',type=Path)
    p.add_argument('--example-dir',type=Path,help='extract exact rook policy sources and their emitted functions')
    p.add_argument('--scorecard',type=Path,help='write a Markdown table with independent, local and live verdicts')
    p.add_argument('--record',action='store_true',help='retain an immutable local revision observation')
    p.add_argument('--summary',action='store_true')
    p.add_argument('--with-history',action='store_true',help='also rebuild and regrade every archived compiler revision on all 238 writes')
    p.add_argument('--witness-panel',action='store_true',help='add 2,796 independent reply positions to the focused witness audit')
    args=p.parse_args()
    if args.variant is None: args.variant=(HERE/'selected-variant.txt').read_text().strip()
    if args.candidate_package:
        if args.variant=='prior': p.error('prior replays archived Rules. Select a compiler variant to score a package')
        args.candidate_package=args.candidate_package.resolve(strict=True)
    if args.python_chess_archive: args.python_chess_archive=args.python_chess_archive.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='sliding-reply-replay-') as name:
        scratch=Path(name)
        suite=reference_suite(args,scratch)
        r=replay(args,scratch,suite)
        if args.with_history:
            if args.through!='queen': p.error('--with-history requires the full corpus')
            entries=[]
            def order(path):
                version=re.search(r'-v(\d+)(?:-|$)',path.stem)
                return (int(version[1]) if version else 0,path.stem.endswith('-dense3'),path.stem)
            revisions=sorted((HERE/'revisions').glob('*.json'),key=order)
            for index,file in enumerate(revisions,start=1):
                frozen=read(file)
                if file.stem==args.variant:
                    scored=r
                else:
                    old=copy.copy(args)
                    old.variant=file.stem
                    old.emit=old.example_dir=None
                    old.witness_panel=False
                    # The prior row is the archived reference release.
                    if file.stem=='prior': old.candidate_package=None
                    directory=scratch/file.stem
                    directory.mkdir()
                    scored=replay(old,directory,suite)
                if (not args.candidate_package or file.stem=='prior') and projection(scored)!=frozen:
                    raise ValueError(f'Archived local revision changed: {file.stem}')
                entries.append({'variant':file.stem,'compile':scored['compile'],
                                'local':scored.get('local',{}).get('groups'),
                                'standalone':scored['standalone']['outcomes'],
                                'witnesses':scored.get('compiledWitness',{}).get('verifiedFocused'),
                                'overall':scored.get('local',{}).get('overall'),
                                'officialSource':sorted({row['state'] for row in scored['live'].get('compileDiagnostics',[])}),
                                'live':{k:scored['live'][k] for k in ('status','distinctCases')}})
                if args.summary:
                    print(f"Regraded {index}/{len(revisions)}: {file.stem}",file=sys.stderr,flush=True)
            r['revisionHistory']=entries
    if args.record:
        if args.candidate_package: raise ValueError('Recorded revision packages are rebuilt from the pinned source')
        record(r,HERE/'revisions')
    elif not args.candidate_package:
        pin=HERE/'revisions'/(args.variant+'.json')
        if pin.exists() and read(pin)['through']==args.through and read(pin)!=projection(r):
            raise ValueError(f'Archived local revision changed: {args.variant}')
    output=json.dumps(r,indent=2)+'\n'
    if args.report: args.report.write_text(output)
    if args.scorecard:
        from sliding_scorecard import render
        args.scorecard.write_text(render(r))
    if args.summary:
        print(json.dumps({'variant':r['variant'],'compile':r['compile'],'standalone':r['standalone']['outcomes'],
                          'compiledWitness':{k:r.get('compiledWitness',{}).get(k) for k in ('verifiedFocused','requiredFocused')},
                          'local':r.get('local',{}).get('groups'),'overall':r.get('local',{}).get('overall'),
                          'localConforms':r.get('localConforms',False),'passes':r['passes'],'live':{k:r['live'][k] for k in ('status','distinctCases')}},indent=2))
    else: print(output,end='')
    return int(bool(args.candidate_package) and not r['passes'])


if __name__=='__main__':
    sys.exit(main())
