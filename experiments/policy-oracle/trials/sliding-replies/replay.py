"""Score a Pyric compiler on immutable reply and full Arcade write inputs."""
import argparse
import base64
from collections import Counter
import json
from pathlib import Path
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
        files.add(REL+'/emit-worker.mjs')
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


def replay(args,scratch):
    requests,answers,prior,groups=load(args.through)
    positions,expected,by_id=prepare(requests)
    package=args.candidate_package
    if package is None:
        package=scratch/'compiler.tgz'
        subprocess.run([sys.executable,OLD/'mobility/pack.py','--split',package],check=True,stdout=subprocess.DEVNULL)
        if sha(package.read_bytes())!=DEFAULT_PACKAGE_SHA: raise ValueError('Recorded compiler package changed')
    package_sha,outputs,install_error=candidate_outputs(package,args.variant,list(positions.values()))
    standalone=check_standalone(outputs,install_error,list(positions),expected,by_id,groups)
    assert sha(RULES.read_bytes())==PRIOR
    ref_pkg=TOOLS['VENDOR']/'pyric-rules-0.1.0.tgz'
    assert sha(ref_pkg.read_bytes())==TOOLS['PINS'][ref_pkg.name]
    reference=TOOLS['install_rules'](ref_pkg,scratch/'reference')/'@pyric/rules'
    original=evaluate(requests,answers,RULES,reference)
    assert all(original[k]['decision']==v for k,v in prior.items())
    assert aggregate(original,groups['original-190'])['outcomes']=={'match':182,'false-allow':7,'false-refusal':1}

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
    result={'variant':args.variant,'through':args.through,'packageSha256':package_sha,'standalone':standalone,
            'requestSha256':digest(requests),'nativeSha256':digest(answers),'groups':groups,
            'prior':{'rulesSha256':PRIOR,'signedNativeMatches':182,'distinctSigned':190,
                     'localGroups':{g:aggregate(original,ids) for g,ids in groups.items()}}}
    if not path.exists():
        result.update(compile={'status':'install-error' if install_error else 'link-error' if str(error).startswith('link-error:') else 'cannot-compile','error':error},
                      live={'status':'unmeasured','rulesSha256':None,'distinctCases':0},passes=False)
        return result
    rules_sha=sha(path.read_bytes())
    if args.emit: args.emit.write_bytes(path.read_bytes())
    result['compile']={'status':'emitted','rulesSha256':rules_sha,'bytes':path.stat().st_size}
    try:
        local=original if rules_sha==PRIOR else evaluate(requests,answers,path,reference)
    except subprocess.CalledProcessError as error:
        result.update(local={'status':'evaluator-error','error':str(error)},live={'status':'unmeasured','rulesSha256':rules_sha,'distinctCases':0},passes=False)
        return result
    result['local']={'rows':local,'groups':{g:aggregate(local,ids) for g,ids in groups.items()},
                     'changes':{g:difference(original,local,ids) for g,ids in groups.items()}}
    live=run('bun','--no-install',HERE/'live/run.mjs','lookup',rules_sha,
             *(['--archive',args.archive.resolve()] if args.archive else []))
    assert live['rulesSha256']==rules_sha
    observed={row['id']:row['verdict'] for row in live['rows']}
    assert len(observed)==live['distinctCases']
    joined={key:{'decision':observed[key],
            'status':'match' if observed[key]==local[key]['native'] else 'false-allow' if observed[key]=='ALLOW' else 'false-refusal'}
            for key in observed.keys() & local.keys()}
    result['live']=live|{'groups':{g:dict(Counter(joined[k]['status'] for k in ids if k in joined))
                                        for g,ids in groups.items()},
                         'nativeMatches':sum(row['status']=='match' for row in joined.values()),
                         'localDisagreements':[k for k in joined if observed[k]!=local[k]['decision']]}
    result['passes']=all(r['status']=='match' for r in local.values()) and all(r['status']=='match' for r in standalone['positions'].values()) and all(row['status']=='match' for row in joined.values())
    return result


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--candidate-package',type=Path)
    p.add_argument('--variant')
    p.add_argument('--through',choices=FAMILIES,default='queen')
    p.add_argument('--archive',type=Path,help='verify private production journals in addition to portable receipts')
    p.add_argument('--emit',type=Path,help='retain complete emitted Arcade Rules')
    p.add_argument('--report',type=Path)
    p.add_argument('--record',action='store_true',help='retain an immutable local revision observation')
    p.add_argument('--summary',action='store_true')
    args=p.parse_args()
    if args.variant is None: args.variant=(HERE/'selected-variant.txt').read_text().strip()
    if args.candidate_package: args.candidate_package=args.candidate_package.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='sliding-reply-replay-') as name:
        r=replay(args,Path(name))
    if args.record:
        if args.candidate_package: raise ValueError('Recorded revision packages are rebuilt from the pinned source')
        record(r,HERE/'revisions')
    elif not args.candidate_package:
        pin=HERE/'revisions'/(args.variant+'.json')
        if pin.exists() and read(pin)['through']==args.through and read(pin)!=projection(r):
            raise ValueError(f'Archived local revision changed: {args.variant}')
    output=json.dumps(r,indent=2)+'\n'
    if args.report: args.report.write_text(output)
    if args.summary:
        print(json.dumps({'variant':r['variant'],'compile':r['compile'],'standalone':r['standalone']['outcomes'],
                          'local':r.get('local',{}).get('groups'),'live':{k:r['live'][k] for k in ('status','distinctCases')}},indent=2))
    else: print(output,end='')
    return int(bool(args.candidate_package) and not r['passes'])


if __name__=='__main__':
    sys.exit(main())
