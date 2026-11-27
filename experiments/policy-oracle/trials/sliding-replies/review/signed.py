"""Independently re-adjudicate raw signed documents and compare their complete server snapshots."""
import argparse
from collections import Counter
from datetime import datetime
import gzip
from hashlib import sha256
import json
from pathlib import Path
import re
import runpy
import sys
import tempfile

sys.dont_write_bytecode = True
TRIAL = Path(__file__).resolve().parents[1]
OLD = TRIAL.parent/'chess-safety'
ORACLE = TRIAL.parents[1]
PREVIOUS = '5365dc5183a2ef4d8a9af8443e4d35323fd7a4794e602c7a6fff36220a7e8380'
OLD_RULES = OLD/'artefacts/knight-endgame-paired-pawn-combined-bare-fixed-comma-packed-v5.rules'
OLD_PLANS = ('comma-chess-safety-full','comma-held-rook-promotion')
NEW_PLANS = ('sliding-part-1','sliding-part-2')
SIGNED = runpy.run_path(str(OLD/'reference/signed-inputs.py'))
REF = SIGNED['external']


def digest(data):
    return sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_bytes())


def timestamp(stamp):
    return datetime.fromisoformat(stamp.replace('Z','+00:00'))


def public_form(value, roles, run):
    if isinstance(value,dict):
        return {key:public_form(sub,roles,run) for key,sub in value.items()}
    if isinstance(value,list):
        return [public_form(sub,roles,run) for sub in value]
    if isinstance(value,str):
        return roles.get(value,value.replace('chess/'+run,'chess/match'))
    return value


def read_capture(folder,name,rules,private):
    public_bytes = (folder/(name+'.json.gz')).read_bytes()
    pin = read(folder/(name+'.pin.json'))
    assert digest(public_bytes)==pin['receiptGzipSha256']
    evidence = json.loads(gzip.decompress(public_bytes))
    receipt = pin['controllerSha256']
    raw_bytes = (private/(receipt+'.json')).read_bytes()
    assert digest(raw_bytes)==evidence['privateReceipt']==receipt
    original = json.loads(raw_bytes)
    assert original['mode']==evidence['mode']==name
    assert original['rulesSha256']==evidence['rulesSha256']==rules
    run = original['runId']
    directory = private/run
    journals = sorted(directory.glob('[0-9]*-*.json'))
    assert digest(b''.join(file.read_bytes() for file in journals))==evidence['journalSha256']
    assert read(directory/'completed.json')['receipt']==receipt
    events = [read(file) for file in journals]
    assert [e['data'] for e in events if e['kind']=='chess-attempt']==original['rows']
    confirmations = [e['data'] for e in events if e['kind']=='propagation-confirmed']
    phases = [c['phase'] for c in confirmations]
    assert phases==['initially-closed','open','restored-closed']
    for confirmation,public_phase in zip(confirmations,evidence['phases'],strict=True):
        proof=confirmation['proof']
        assert public_phase=={'phase':confirmation['phase'],'receipt':confirmation['digest'],
                              'rulesSha256':proof['rulesSha256'],'releaseUpdateTime':proof['releaseUpdateTime'],
                              'verifiedAt':proof['verifiedAt']}
        assert proof['databaseUid']==original['target']['uid']==evidence['targetDatabaseUid']
    closed = digest((ORACLE/'arcade/v1/rules/closed.rules').read_bytes())
    assert [(p['phase'],p['rulesSha256']) for p in evidence['phases']]==list(zip(phases,[closed,rules,closed]))
    closure = evidence['closure']
    assert closure['signedRead']==closure['signedWrite']==evidence['signedOutRead']=='DENY'
    assert closure['leaseReleased'] and closure['version']==evidence['phases'][-1]['releaseUpdateTime']
    controls=[e['data'] for e in events if e['kind']=='propagation-control' and e['data']['phase']=='restored-closed']
    assert controls and all(c['beforeRead']==c['write']==c['afterRead']=='DENY' for c in controls[-2:])
    signed_out,=[e['data'] for e in events if e['kind']=='unauthenticated-read']
    restored,=[e['data'] for e in events if e['kind']=='closed']
    released,=[e['data'] for e in events if e['kind']=='released']
    assert signed_out['observed']=='DENY' and released['runId']==run
    assert restored['rulesetName']==original['target']['closedRuleset']==evidence['restored']
    assert restored['rulesSha256']==closed and restored['verifiedAt']==closure['verifiedAt']
    actors = {e['data']['uid']:e['data']['role'] for e in events if e['kind']=='identity'}
    assert len(actors)==3 and set(actors.values())=={'host','guest','observer'}
    for raw,public in zip(original['rows'],evidence['rows'],strict=True):
        row = {k:v for k,v in raw.items() if k not in ('proof','end','expected')}
        label = public['id']
        assert public_form(row,actors,run)==public,label
        assert raw['proof']['rulesSha256']==raw['end']['rulesSha256']==rules,label
        before, = raw['before']
        after, = raw['after']
        update, = raw['submitted']
        assert raw['actor']==before['data'][before['data']['currentTurn']] and public['reader']=='observer',label
        assert before['path']==after['path']==update['path'] and update['op']=='update',label
        assert before['created']==after['created'],label
        if raw['observed']=='ALLOW':
            assert after['data']==(before['data']|update['data']) and timestamp(after['version'])>timestamp(before['version']),label
        else:
            assert raw['observed']=='DENY' and after==before,label
    return evidence,{'capture':name,'caseCount':len(original['rows']),'controllerSha256':receipt,
                     'journalSha256':evidence['journalSha256'],'snapshotAndVersionVerified':True,
                     'restoredAndReleased':True}


def release(rules,private):
    if rules==PREVIOUS:
        folder=OLD/'live/receipts'/rules
        assert digest(OLD_RULES.read_bytes())==rules
        names=OLD_PLANS
        planned=None
    else:
        release=TRIAL/'live/releases'/rules
        if not (release/'plan.json').exists(): return {},[]
        plan=read(release/'plan.json')
        assert digest((release/'firestore.rules').read_bytes())==rules==plan['rulesSha256']
        assert plan['expectedCases']==238 and plan['previousRulesSha256']==PREVIOUS
        planned={c['name']:c['ids'] for c in plan['chunks']}
        assert list(planned)==list(NEW_PLANS) and list(map(len,planned.values()))==[120,118]
        assert len(set(planned[NEW_PLANS[0]]+planned[NEW_PLANS[1]]))==238
        folder=release/'receipts'
        names=tuple(name for name in NEW_PLANS if (folder/(name+'.pin.json')).exists())
    rows={}
    sources=[]
    for name in names:
        evidence,source=read_capture(folder,name,rules,private)
        if planned:
            assert [r['id'] for r in evidence['rows']]==planned[name]
        for row in evidence['rows']:
            assert row['id'] not in rows
            rows[row['id']]=row
        sources.append(source)
    return rows,sources


def input_shape(row):
    return [row['actor'],row['reader'],row['probe'],
            [{'path':old['path'],'data':old['data']} for old in row['before']],row['submitted']]


def compare(rules,private,archive):
    prior,old_sources=release(PREVIOUS,private)
    assert len(prior)==190
    current,sources=(prior,old_sources) if rules==PREVIOUS else release(rules,private)
    old_native,_=SIGNED['native_replay']()
    native={key:old_native[key] for key in prior}
    focused={row['id']:row for group in ('rook','bishop','queen')
             for row in read(TRIAL/'native'/group/'native.json')['cases']}
    native.update({key:row['nativeAdmission'] for key,row in focused.items()})
    assert len(native)==238 and len(focused)==54 and len(set(prior)&set(focused))==6
    assert set(current)<=native.keys()
    changes={'repaired':[],'regressed':[],'stillDisagree':[]}
    adjudications={}
    mismatches={}
    invalid=[]
    checked=Counter()
    with tempfile.TemporaryDirectory(prefix='slide-signed-audit-') as tmp:
        engine=REF['load_chess'](archive,Path(tmp))
        for key,row in current.items():
            before=row['before'][0]['data']
            proposed=row['submitted'][0]['data']
            accepted,valid,diffs=SIGNED['adjudicate'](engine,row['actor'],before,proposed)
            assert accepted==native[key],(key,diffs)
            if not valid: invalid.append(key)
            if key in focused:
                f=focused[key]
                board=SIGNED['board_from_doc'](engine,before)
                assert REF['fen'](board)==f['fen'],key
                candidate=proposed['lastMove']
                move=engine.Move.from_uci(candidate['from']+candidate['to']+candidate['promotion'])
                assert move.uci()==f['uci'] and board.is_legal(move),key
                board.push(move)
                assert REF['fen'](board)==f['successor']==REF['fen'](SIGNED['board_from_doc'](engine,before|proposed)),key
                assert sorted(m.uci() for m in board.legal_moves)==f['replies'],key
                assert (proposed['status'],proposed['winner'])==(f['claim']['status'],f['claim']['winner']),key
            want='ALLOW' if accepted else 'DENY'
            actual=row['observed']
            agree=want==actual
            checked[('match' if agree else 'false-allow' if actual=='ALLOW' else 'false-refusal')]+=1
            adjudications[key]={'native':want,'observed':actual,'differingFields':diffs,
                                'signedInputSha256':SIGNED['hash_json'](input_shape(row))}
            if not agree: mismatches[key]={'native':want,'observed':actual}
            if key in prior:
                assert input_shape(prior[key])==input_shape(row),key
                before_matches=prior[key]['observed']==want
                if before_matches!=agree: changes['repaired' if agree else 'regressed'].append(key)
                elif not agree: changes['stillDisagree'].append(key)
    return {'rulesSha256':rules,'source':'private authenticated controller journals; independent chess rules on exact signed operands',
            'status':'unmeasured' if not current else 'historical' if rules==PREVIOUS else 'measured' if len(current)==238 else 'partial',
            'distinctWrites':len(current),'nativeRefereeSha256':REF['PIN'],'nativeComparedOnActualDocuments':len(adjudications),
            'priorIdenticalSignedOperands':len(set(prior)&set(current)),'focusCasesWithExactSuccessorAndCompleteReplies':len(set(focused)&set(current)),
            'nativeVersusFirestore':dict(checked),'captures':sources,'mismatches':mismatches,'oldCorpusChanges':changes,
            'invalidSourcePositions':invalid,'perCaseAdjudicationsSha256':SIGNED['hash_json'](adjudications)}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('rules_digest')
    parser.add_argument('private_archive',type=Path)
    parser.add_argument('python_chess_archive',type=Path)
    args=parser.parse_args()
    if not re.fullmatch(r'[0-9a-f]{64}',args.rules_digest): parser.error('Expected a full SHA-256 digest')
    print(json.dumps(compare(args.rules_digest,args.private_archive,args.python_chess_archive),indent=2))
