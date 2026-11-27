"""Regrade a committed oracle tree from a clean local Git archive using its pinned inputs."""
import argparse
from datetime import datetime, timezone
from hashlib import sha256
import io
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tarfile
import tempfile

ORACLE=Path('experiments/policy-oracle')
TRIAL=Path('trials/sliding-replies')
PRIOR='5365dc5183a2ef4d8a9af8443e4d35323fd7a4794e602c7a6fff36220a7e8380'


def digest(data):
    return sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_bytes())


def retained_fields(current,earlier):
    # The audit may add profiles. An observation already recorded under this SHA
    # must reproduce, including every row in ordered witness and receipt arrays.
    if isinstance(earlier,dict):
        return isinstance(current,dict) and all(key in current and retained_fields(current[key],value)
                                              for key,value in earlier.items())
    return current==earlier


def run(args):
    git=lambda *parts: subprocess.check_output(['git','-C',args.repo,*parts])
    commit=git('rev-parse','--verify','--end-of-options',args.commit+'^{commit}').decode().strip()
    archive=git('archive','--format=tar',commit,ORACLE)
    snapshot={'sourceCommit':commit,'oracleTreeGitObject':git('rev-parse',f'{commit}:{ORACLE}').decode().strip(),
              'sourceArchiveSha256':digest(archive),'startUtc':datetime.now(timezone.utc).isoformat()}
    with tempfile.TemporaryDirectory(prefix='sliding-clean-snapshot-') as folder:
        root=Path(folder)
        with tarfile.open(fileobj=io.BytesIO(archive)) as members:
            for member in members:
                name=Path(member.name)
                assert not name.is_absolute() and '..' not in name.parts and (member.isreg() or member.isdir())
                members.extract(member,root,filter='data')
        oracle=root/ORACLE
        trial=oracle/TRIAL
        def check(*argv):
            child=subprocess.run(argv,cwd=trial,text=True,capture_output=True)
            if child.returncode:
                sys.stderr.write(child.stderr[-2400:])
                raise subprocess.CalledProcessError(child.returncode,argv)
            return json.loads(child.stdout)
        variant=(trial/'selected-variant.txt').read_text().strip() if args.variant=='selected' else args.variant
        live=args.private_archive.resolve(strict=True)
        referee=args.chess_source.resolve(strict=True)
        rules=root/'candidate.rules'
        report=root/'replay.json'
        check(sys.executable,'-B','replay.py','--variant',variant,'--through','queen','--archive',live,
              '--python-chess-archive',referee,'--witness-panel','--emit',rules,'--report',report,'--summary',
              *(['--with-history'] if args.with_history else []))
        main=read(report)
        w=main['compiledWitness']
        sha=main['compile']['rulesSha256']
        assert sha==digest(rules.read_bytes())==w['rulesSha256']
        assert len(main['local']['rows'])==238 and main['local']['groups']['original-190']['cases']==190
        assert len(w['focused'])==18 and len(w['routes'])==54
        snapshot.update(variant=variant,rulesSha256=sha,packageSha256=main['packageSha256'],requestSha256=main['requestSha256'],
                        nativeSha256=main['nativeSha256'],standalone=main['standalone']['outcomes'],requestCount=len(main['local']['rows']),
                        localGroups=main['local']['groups'],localConforms=main['localConforms'],overallConforms=main['passes'],
                        signedStatus=main['live']['status'],signedCases=main['live']['distinctCases'],signedAgreements=main['live']['nativeMatches'],
                        signedLocalDifferences=main['live']['localDisagreements'],focusWitnesses={'required':w['requiredFocused'],'verified':w['verifiedFocused']},
                        focusedDerivationCounts=w['fullWriteDerivation']['counts'],rayPanel=w['panel']['scopes'],otherTurnsPanel=w['otherTurns']['scopes'])
        for directory,flag,field in [('panel',None,'panel'),('other-turns','--other-turns','otherTurns'),('roster','--roster','rosterControls')]:
            frozen=read(trial/'review'/directory/'freeze.json')
            rebuilt=check(sys.executable,'-B',trial/'review'/directory/'generate.py',referee)
            arcade=check('bun','--no-install','review/panel/arcade.mjs',*([flag] if flag else []))
            assert frozen==rebuilt and arcade==read(trial/'review'/directory/'arcade.json')
            assert frozen['inputsAndRepliesSha256']==arcade['inputsAndRepliesSha256']==w[field]['inputsAndRepliesSha256']
            snapshot['refereeSourceSha256']=frozen['sourceSha256']
        roster=w['rosterControls']
        snapshot['roster']={'boards':len(roster['scores']),'fullWrites':len(roster['routes']),'disagreements':[
            {key:row[key] for key in ('id','expected','local','error','expressions')} for row in roster['routes']
            if row['error'] or row['expected']!=row['local']]}
        evidence=trial/'review/scores'/sha
        if (evidence/'witness.json').exists():
            assert retained_fields(w,read(evidence/'witness.json'))
        snapshot['recordedWitnessReproduced']=(evidence/'witness.json').exists()
        tools=runpy.run_path(str(oracle/'trials/for-of/replay.py'))
        package=oracle/'arcade/vendor/pyric-rules-0.1.0.tgz'
        assert digest(package.read_bytes())==tools['PINS'][package.name]
        sdk=tools['install_rules'](package,root/'review-sdk')/'@pyric/rules'
        if (evidence/'wrong-destination.json').exists():
            sensitivity=check(sys.executable,'-B','review/witness-control.py',sdk,rules)
            assert sensitivity==read(evidence/'wrong-destination.json')
            snapshot['signPreservingWrongDestination']=sensitivity
        if (evidence/'dense-geometry.json').exists():
            dense_freeze=check(sys.executable,'-B','protocol/dense-panel.py',referee)
            dense=check('bun','--no-install','protocol/dense-probe.mjs',sdk,rules)
            assert dense['nativeInputsSha256']==dense_freeze['inputsAndNativeRepliesSha256']
            if (evidence/'dense.json').exists(): assert dense==read(evidence/'dense.json')
            geometry=check(sys.executable,'-B','review/dense-geometry.py',sdk,rules,referee)
            assert geometry==read(evidence/'dense-geometry.json')
            snapshot['denseProof']={'boards':dense['boards'],'outcomes':dense['outcomes'],
                                    'unqualifiedGeometries':geometry['boards'],'incorrectTriggers':geometry['incorrectTriggers']}
        signed=check(sys.executable,'-B','review/signed.py',sha,live,referee)
        assert signed['distinctWrites']==snapshot['signedCases'] and signed['nativeVersusFirestore'].get('match',0)==snapshot['signedAgreements']
        snapshot['independentSignedAudit']=signed
        before=check(sys.executable,'-B','review/signed.py',PRIOR,live,referee)
        assert before['distinctWrites']==190 and before['nativeVersusFirestore']=={'match':182,'false-allow':7,'false-refusal':1}
        snapshot['previousPrivateJournalsVerified']=before['distinctWrites']
        if args.with_history:
            history=main['revisionHistory']
            assert {r['variant'] for r in history}=={p.stem for p in (trial/'revisions').glob('*.json')}
            snapshot['frozenHistory']=history
    snapshot['finishedUtc']=datetime.now(timezone.utc).isoformat()
    return snapshot


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('repo',type=Path)
    p.add_argument('commit',help='immutable Git SHA or local ref resolved at start')
    p.add_argument('variant',help='compiler variant or selected to use selected-variant.txt from that commit')
    p.add_argument('private_archive',type=Path)
    p.add_argument('chess_source',type=Path)
    p.add_argument('report',type=Path)
    p.add_argument('--with-history',action='store_true')
    args=p.parse_args()
    result=run(args)
    args.report.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({key:result[key] for key in ('sourceCommit','variant','rulesSha256','requestCount','focusWitnesses',
                                                'signedStatus','signedCases','signedAgreements','overallConforms')}))
