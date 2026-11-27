"""Full-write controls for mixed material on either side of a bishop pin."""
from campaign_corpus import HERE, read, run

# Adding the rook on d8 pins the c8 bishop to its king. Both boards still
# have exactly two defending sliders. Both colors are covered by reflection.
CONTROLS = [
    ('free-bishop', 'k1b5/3Q4/1K6/8/2bB4/8/8/8 w - -', 'd7b7', ['c8b7']),
    ('pinned-bishop', 'k1bR4/3Q4/1K6/8/2bB4/8/8/8 w - -', 'd7b7', []),
    ('free-bishop-reflected', '8/8/8/2Bb4/8/1k6/3q4/K1B5 b - -', 'd2b2', ['c1b2']),
    ('pinned-bishop-reflected', '8/8/8/2Bb4/8/1k6/3q4/K1Br4 b - -', 'd2b2', []),
]


def score(rules, reference, evaluate):
    fixtures,answers,replies=[],{},[]
    for name,fen,uci,legal in CONTROLS:
        winner='host' if ' w ' in fen else 'guest'
        for status in ['draw','won']:
            key=name+'-'+status
            fixtures.append(dict(id=key,fen=fen,uci=uci,claim=dict(status=status,winner=winner if status=='won' else '')))
            answers[key]=status==('playing' if legal else 'won')
            replies.append(legal)
    writes=run('bun','--no-install',HERE/'project.mjs','writes',data=fixtures)
    for r,legal in zip(run('bun','--no-install',HERE/'reference.mjs',data=writes),replies,strict=True):
        assert r['eligible'] and r['all']==legal and r['outcome']==('playing' if legal else 'checkmate')
    rows=evaluate(writes,answers,rules,reference)
    return {'cases':len(rows),'rows':rows, 'disagreements':[k for k,v in rows.items() if v['status']!='match']}


def score_originals(rules, reference, evaluate):
    originals=read(HERE/'native/mixed-slider/cover.json')['cases'].values()
    fixtures=[{k:r[k] for k in ('id','fen','uci','claim')} for r in originals]
    writes=run('bun','--no-install',HERE/'project.mjs','writes',data=fixtures)
    native=run('bun','--no-install',HERE/'reference.mjs',data=writes)
    for board, row in zip(originals,native,strict=True):
        assert row['eligible'] and row['all']==board['replies'] and row['sliding'] and row['outcome']=='playing'
    return evaluate(writes,{r['id']:False for r in fixtures},rules,reference)
