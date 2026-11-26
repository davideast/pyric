"""Audit exact signed match snapshots against separate native chess answers, entirely offline."""
import argparse
from collections import Counter
from datetime import datetime
import gzip
from hashlib import sha256
import json
from pathlib import Path
import runpy
import tempfile

STOCK = '523c4c137aa00c2c764264aa6c2cefeda7c692561544da45d4fcccf3a2056fda'
SELECTED = '5365dc5183a2ef4d8a9af8443e4d35323fd7a4794e602c7a6fff36220a7e8380'

def digest(data):
    return sha256(data).hexdigest()

def json_file(path):
    return json.loads(path.read_bytes())

def hash_object(value):
    return digest(json.dumps(value,sort_keys=True,separators=(',',':')).encode())

def stamp(text):
    return datetime.fromisoformat(text.replace('Z','+00:00'))

def read_release(trial, archive, rules):
    rows, journals = {}, []
    for path in sorted((trial/'live/receipts'/rules).glob('*.json.gz')):
        evidence=json.loads(gzip.decompress(path.read_bytes()))
        pin=json_file(path.with_name(path.name.removesuffix('.json.gz')+'.pin.json'))
        assert digest(path.read_bytes())==pin['receiptGzipSha256']
        raw_bytes=(archive/(pin['controllerSha256']+'.json')).read_bytes()
        assert digest(raw_bytes)==evidence['privateReceipt']==pin['controllerSha256']
        raw=json.loads(raw_bytes)
        assert raw['rulesSha256']==evidence['rulesSha256']==rules
        run=archive/raw['runId']
        files=sorted(run.glob('[0-9]*-*.json'))
        assert digest(b''.join(p.read_bytes() for p in files))==evidence['journalSha256']
        events=[json_file(p) for p in files]
        assert [evt['data'] for evt in events if evt['kind']=='chess-attempt']==raw['rows']
        assert [e['data']['phase'] for e in events if e['kind']=='propagation-confirmed']==['initially-closed','open','restored-closed']
        assert evidence['closure']['signedRead']==evidence['closure']['signedWrite']=='DENY'
        assert evidence['closure']['leaseReleased']
        assert json_file(run/'completed.json')['receipt']==pin['controllerSha256']
        actors={e['data']['role']:e['data']['uid'] for e in events if e['kind']=='identity'}
        assert len(set(actors.values()))==3
        def redact(value):
            if isinstance(value,dict):
                return {field:redact(v) for field,v in value.items()}
            if isinstance(value,list):
                return [redact(v) for v in value]
            if isinstance(value,str):
                for role,uid in actors.items():
                    if value==uid:
                        return role
                return value.replace('chess/'+raw['runId'],'chess/match')
            return value
        for observed,public in zip(raw['rows'],evidence['rows'],strict=True):
            name=observed['id']
            assert redact({k:v for k,v in observed.items() if k not in ('proof','end','expected')})==public,name
            assert name not in rows and name==public['id']
            before,=observed['before'];after,=observed['after'];submission,=observed['submitted']
            assert observed['actor']==actors['host'] and observed['reader']==actors['observer']
            assert observed['proof']['rulesSha256']==observed['end']['rulesSha256']==rules
            assert before['path']==after['path']==submission['path']
            assert before['created']==after['created']
            assert before['data'][before['data']['currentTurn']]==observed['actor']
            assert observed['observed']==public['observed']
            if observed['observed']=='ALLOW':
                assert after['data']==before['data']|submission['data']
                assert stamp(after['version'])>stamp(before['version'])
            else:
                assert observed['observed']=='DENY' and before==after
            rows[name]={'before':public['before'][0]['data'],'update':public['submitted'][0]['data'],
                        'rawBefore':before,'rawAfter':after,'decision':observed['observed']}
        journals.append({'controller':evidence['privateReceipt'],'journal':evidence['journalSha256'],'writes':len(raw['rows'])})
    return rows,journals

def chess_fen(chess,doc):
    board=chess.Board(None)
    assert len(doc['board'])==64
    for square,piece in doc['board'].items():
        if piece:
            assert len(piece)==2 and piece[0] in 'wb'
            board.set_piece_at(chess.parse_square(square),chess.Piece.from_symbol(piece[1].upper() if piece[0]=='w' else piece[1]))
    board.turn=doc['currentTurn']=='host'
    board.set_castling_fen(doc['castling'] or '-')
    board.ep_square=chess.parse_square(doc['enPassant']) if doc['enPassant'] else None
    return ' '.join(board.fen(en_passant='fen').split()[:4])

def audit(trial,archive,referee):
    stock,stock_journals=read_release(trial,archive,STOCK)
    selected,selected_journals=read_release(trial,archive,SELECTED)
    assert len(stock)==190 and stock.keys()==selected.keys()
    for k in stock:
        assert stock[k]['before']==selected[k]['before'] and stock[k]['update']==selected[k]['update'],k
    external=runpy.run_path(str(trial.parent/'chess/reference/generate.py'))
    result={'source':'private controller receipts and journals; public native answers verified with independently pinned python-chess',
            'signedInputsInCommon':len(stock),'payloadsSha256':hash_object({k:[v['before'],v['update']] for k,v in stock.items()}),
            'snapshots':{},'native':{},'signed':{}}
    for name,rules,rows,journals in [('stock',STOCK,stock,stock_journals),('selected',SELECTED,selected,selected_journals)]:
        result['snapshots'][name]={'rulesSha256':rules,'journals':journals,'decisions':dict(Counter(r['decision'] for r in rows.values()))}
    with tempfile.TemporaryDirectory() as temp:
        chess=external['load_chess'](referee,Path(temp))
        result['nativeRefereeSha256']=external['PIN']
        for cohort in ('held-rook-promotion-v1','rook-interposition-v1'):
            for native in json_file(trial/'exploration'/cohort/'controls/native.json')['cases']:
                name=native['id']; source=stock[name]; before=source['before']; update=source['update']
                assert chess_fen(chess,before)==native['fen']
                game=chess.Board(native['fen']); move=chess.Move.from_uci(native['uci'])
                assert game.is_valid() and move in game.legal_moves
                game.push(move)
                assert external['fen'](game)==chess_fen(chess,before|update)==native['successor']
                replies=sorted(m.uci() for m in game.legal_moves)
                assert replies==native['replies']
                status='won' if game.is_checkmate() else 'draw' if game.is_stalemate() else 'playing'
                winner=before['currentTurn'] if status=='won' else ''
                assert (update['status'],update['winner'])==(native['claim']['status'],native['claim']['winner'])
                assert native['expected']=={'status':status,'winner':winner}
                assert native['nativeAdmission']==((status,winner)==(update['status'],update['winner']))
                result['native'][name]={'fen':native['fen'],'move':native['uci'],'replyMoves':replies,
                    'correctStatus':status,'submittedStatus':update['status'],'admit':native['nativeAdmission']}
                for label,rows in [('stock',stock),('selected',selected)]:
                    value=rows[name]; old=value['rawBefore']; new=value['rawAfter']
                    result['signed'].setdefault(label,{})[name]={'decision':value['decision'],'versionBefore':old['version'],
                        'versionAfter':new['version'],'beforeFullMatchSha256':hash_object(old['data']),
                        'afterFullMatchSha256':hash_object(new['data'])}
    return result

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('trial',type=Path);p.add_argument('private_archive',type=Path);p.add_argument('python_chess_archive',type=Path)
    a=p.parse_args()
    print(json.dumps(audit(a.trial.resolve(),a.private_archive,a.python_chess_archive),indent=2))
