"""Make a concise receipt for an independent qualification through the public replay command."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
import subprocess

SELECTED = '5365dc5183a2ef4d8a9af8443e4d35323fd7a4794e602c7a6fff36220a7e8380'
BASELINE = '523c4c137aa00c2c764264aa6c2cefeda7c692561544da45d4fcccf3a2056fda'

def receipt(checkout, report, scorecard, *, scheduler=None):
    def git(*args):
        return subprocess.check_output(['git',*args],cwd=checkout,text=True).strip()
    revision=git('rev-parse','HEAD')
    assert not git('status','--short','--untracked-files=all')
    r=json.loads(report.read_bytes())
    assert r['qualification']['status']=='reproduced'
    assert r['qualification']['rulesSha256']==r['hosted']['rulesSha256']==r['sealedReferee']['rulesSha256']==SELECTED
    assert r['targetCompilation']['status']=='compiled' and r['hosted']['status']=='measured'
    assert r['management']['privateJournalChecked'] and r['sealedReferee']['status']=='scored'
    judging={c['rulesSha256']:c for c in r['independentSignedInputs']['releases']}
    assert len(judging)==2
    gold=judging[BASELINE]
    for row in judging.values():
        assert row['distinctInputs']==row['nativeAgreement']==190
        assert row['judgmentsSha256']==gold['judgmentsSha256'] and not row['invalidSourcePositions']
    comparisons={}
    for label,rules in [('priorStrongerBaseline',BASELINE),('selected',SELECTED)]:
        release,=[v for v in r['releaseComparisons'] if v['sha256']==rules]
        assert release['productionCases']==190
        bins=release['batches'].values()
        totals={k:sum(b.get(k,0) for b in bins) for k in ('cases','nativeMatches','falseAllows','falseRefusals','localVerdictMatches')}
        assert totals['cases']==190 and totals['falseAllows']+totals['falseRefusals']+totals['nativeMatches']==190
        comparisons[label]={'rulesSha256':rules,**totals}
    assert r['localConformance'] is False and r['matchesObservedProductionCases'] is False
    proof={'checkout':revision,'tree':git('rev-parse','HEAD^{tree}'),'cleanAfterReplay':True,
        'command':'python3 replay.py --sealed-referee <private referee> --archive <archived controller journals> --report <json> --scorecard <markdown>',
        'packageSha256':r['packageSha256'],'qualification':r['qualification'],'targetCompilation':r['targetCompilation']['status'],
        'nativeSignedInputs':{'inputs':190,'legalSubmissions':gold['admitted'],'illegalSubmissions':gold['refused'],
            'judgmentsSha256':gold['judgmentsSha256'],'thirdRefereeSha256':r['independentSignedInputs']['refereeSha256']},
        'productionComparedToNative':comparisons,'privateJournalChecked':r['management']['privateJournalChecked'],
        'localHoldout':r['discovery']['outcomes'],'localHistory':{k:{f:v[f] for f in ('writes','allow','falseRefusals')} for k,v in r['history'].items()},
        'localLifecycle':{'completePrefixes':r['lifecycle']['completePrefixes'],'outcomes':r['lifecycle']['outcomes']},
        'localSealed':r['sealedReferee']['groups'],'localConformance':r['localConformance'],
        'matchesObservedProductionCases':r['matchesObservedProductionCases'],'reportSha256':sha256(report.read_bytes()).hexdigest(),
        'scorecardSha256':sha256(scorecard.read_bytes()).hexdigest()}
    if scheduler:
        status=json.loads(scheduler.read_bytes())
        assert status['stage']=='finished' and status['exitCode']==0 and status['reported']
        assert status['revision']==revision and status['unexpectedWorkingTreeChanges']==[]
        assert r['qualification']['historicalProofs']==45
        helpers=r['archivedBareHelpers']
        expected_helpers={
            'd582f74aa912fcc158a052712d54927bd1df68fdfb5ef1331cfe4254e2ef6fd4':'685cd932bae8f58e3d2556c817842c9cb17b0650de9cc6c61f4c3e72874be32d',
            SELECTED:'2168fdfc41b45810330f448fde875de612c5929d075fbfbf01857a86d5beedfe'}
        assert {h['bundleSha256']:h['helperScopeSha256'] for h in helpers}==expected_helpers
        for h in helpers:
            assert h['positions']==1791552 and h['claims']==5374656 and h['runtimeErrors']==h['mismatches']==0
        proof['archivedBareHelpers']=[{f:h[f] for f in ('bundleSha256','helperScopeSha256','nativeSha256','positions','claims','mismatches','runtimeErrors')}
            for h in helpers]
        recovery,=[entry for entry in r['management']['unqualified'] if entry['reason']=='management-401-during-restore']
        assert recovery['attempted']==85 and recovery['scored']==0 and recovery['leaseReleased']
        assert len(recovery['closedRounds'])==2
        assert all(all(check[f]=='DENY' for f in ('beforeRead','write','afterRead')) and check['unchangedVersion']
            for check in recovery['closedRounds'])
        proof['interruptedCapture']={f:recovery[f] for f in ('controllerSha256','recoveryJournalSha256','attempted','scored','restoredRulesSha256',
            'restoredReleaseVersion','leaseReleased','restorationControl','closedRounds')}
        proof['reservedFinalReplay']={'scheduledFor':'2026-11-26T18:37:30Z','finishedAt':status['utc'],'exitCode':0}
    return proof

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('checkout',type=Path); p.add_argument('report',type=Path); p.add_argument('scorecard',type=Path)
    p.add_argument('--scheduler',type=Path)
    a=p.parse_args()
    print(json.dumps(receipt(a.checkout,a.report,a.scorecard,scheduler=a.scheduler),indent=2))
