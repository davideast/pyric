"""Select a minimum cover of the missed sliding replies on the frozen v19 writes."""
from itertools import combinations
from pathlib import Path
import json
import runpy
import sys
import tempfile

AUDIT=runpy.run_path(str(Path(__file__).with_name('two-knights.py')))
BASELINE='031ff6cdfc8698e206156e248d6199d2b9c3253d5efd81852b91dd3e9b74a097'
TRIAL=AUDIT['TRIAL']

def cover(chess):
    rows={}
    for key,record in AUDIT['residuals'](BASELINE).items():
        o=record['observation']
        if not o['obligation'].startswith('refute-'): continue
        b=chess.Board(o['fen']+' 0 1')
        b.push_uci(o['uci'])
        replies=sorted(b.legal_moves,key=lambda m:m.uci())
        assert [m.uci() for m in replies]==o['legalReplies']
        types={b.piece_at(m.from_square).symbol().lower() for m in replies}
        if not types.intersection('brq'): continue
        material=''.join(sorted(p.symbol().lower() for p in b.piece_map().values() if p.color==b.turn))
        tags={'material-'+material,'claim-'+o['claim']['status']}
        for m in replies:
            piece=b.piece_at(m.from_square).symbol().lower()
            role=('capture-checker' if m.to_square in b.checkers() else 'interpose') if b.is_check() else ('capture' if b.is_capture(m) else 'quiet')
            tags.add(piece+'-'+role)
            if len(replies)==1: tags.add('sole-'+piece+'-'+role)
        rows[key]={'id':record['occurrences'][0]['id'],'fen':o['fen'],'uci':o['uci'],'claim':o['claim'],'tags':sorted(tags),'replies':[m.uci() for m in replies]}
    assert len(rows)==13
    need=set.union(*(set(x['tags']) for x in rows.values()))
    # Prefer fewer pieces, then stable IDs, among equally small valid covers.
    def rank(keys):
        return sum(len(chess.Board(rows[k]['fen']+' 0 1').piece_map()) for k in keys),sorted(rows[k]['id'] for k in keys)
    for n in range(1,len(rows)+1):
        covers=[ks for ks in combinations(rows,n) if set.union(*(set(rows[k]['tags']) for k in ks))==need]
        if covers:
            selected=min(covers,key=rank)
            return {'obligations':sorted(need),'minimumBoards':n,'selected':list(selected),'cases':rows}

if __name__=='__main__':
    with tempfile.TemporaryDirectory() as t:
        chess=AUDIT['AUDIT']['REF']['load_chess'](Path(sys.argv[1]),Path(t))
        print(json.dumps(cover(chess),indent=2))
