"""Freeze deterministic legal checking moves before running the emitted slider helper."""
import argparse
from collections import Counter
import gzip
from hashlib import sha256
import json
from pathlib import Path
import random
import runpy
import sys
import tempfile
sys.dont_write_bytecode=True

HERE=Path(__file__).resolve().parent
TRIAL=HERE.parent.parent
REF=runpy.run_path(str(TRIAL.parent/'chess/reference/generate.py'))
SEED=570816
PER_STRATUM=6


def squares(c):
    values={'corner':[], 'edge':[], 'interior':[]}
    for sq in c.SQUARES:
        edges=(c.square_file(sq) in (0,7))+(c.square_rank(sq) in (0,7))
        values[('interior','edge','corner')[edges]].append(sq)
    return values


def describe(c, before, move, name, source):
    if not before.is_valid() or not before.is_legal(move):
        return None
    after=before.copy(stack=False)
    after.push(move)
    if not after.is_valid() or not after.is_check():
        return None
    replies=sorted(after.legal_moves, key=lambda m: m.uci())
    slider=[m for m in replies if after.piece_type_at(m.from_square) in (c.ROOK,c.BISHOP,c.QUEEN)]
    material=''.join(sorted(after.piece_at(sq).symbol().lower() for sq in after.piece_map()
                            if after.color_at(sq)==after.turn and after.piece_type_at(sq)!=c.KING))
    king=after.king(after.turn)
    category=next(k for k,values in squares(c).items() if king in values)
    attrs=['defender-'+('w' if after.turn else 'b'), category]
    if len(after.checkers())>1: attrs.append('double-check')
    if any(after.is_pinned(after.turn,sq) for sq in after.piece_map()
           if after.color_at(sq)==after.turn and after.piece_type_at(sq) in (c.ROOK,c.BISHOP,c.QUEEN)): attrs.append('pinned-slider')
    if any(after.is_capture(m) for m in slider): attrs.append('legal-capture')
    if any(not after.is_capture(m) for m in slider): attrs.append('legal-interposition')
    if any(after.piece_type_at(m.from_square)==c.KING for m in replies): attrs.append('king-reply')
    if not replies: attrs.append('mate')
    if len(slider)>1: attrs.append('multiple-slider-replies')
    return {'id':name,'family':source,'fen':REF['fen'](before),'uci':move.uci(),'successor':REF['fen'](after),
            'defenderMaterial':material,'features':attrs,'replies':[m.uci() for m in replies],
            'sliderReplies':[m.uci() for m in slider]}


def transformations(c):
    def identity(x,y): return x,y
    def quarter(x,y): return 7-y,x
    def half(x,y): return 7-x,7-y
    def three_quarters(x,y): return y,7-x
    def flip(x,y): return 7-x,y
    for fn in (identity,quarter,half,three_quarters):
        for reflected in (False,True):
            def transform(sq,fn=fn,reflected=reflected):
                x,y=c.square_file(sq),c.square_rank(sq)
                return c.square(*fn(*(flip(x,y) if reflected else (x,y))))
            yield transform


def transformed(c):
    for group in ('rook','bishop','queen'):
        inputs=json.loads((TRIAL/'native'/group/'positions.json').read_bytes())
        for row in inputs[::3]:
            base=c.Board(row['fen']); raw=c.Move.from_uci(row['uci'])
            for trans_i,transform in enumerate(transformations(c)):
                for swap in (False,True):
                    b=c.Board(None);b.turn=bool(base.turn)^swap
                    for sq,pc in base.piece_map().items():
                        b.set_piece_at(transform(sq),c.Piece(pc.piece_type,pc.color^swap))
                    move=c.Move(transform(raw.from_square),transform(raw.to_square))
                    key=f"{row['id'][:-8]}-t{trans_i}-swap{int(swap)}"
                    result=describe(c,b,move,key,'transformed-'+group)
                    # A geometric symmetry can alter pawn direction. Keep the legal
                    # boards with fresh independent answers, avoiding any assumption of invariance.
                    if result: yield result


def predecessor(c, end, checker, rng):
    # Rewind an ordinary checking slide. Verify the predecessor and forward move
    # separately. Discovered simultaneous attacks thus have a real source move.
    squares=list(end.attacks(checker));rng.shuffle(squares)
    for src in squares:
        if end.piece_at(src): continue
        before=end.copy(stack=False)
        piece=before.remove_piece_at(checker);before.set_piece_at(src,piece)
        before.turn=not end.turn
        move=c.Move(src,checker)
        if before.is_valid() and before.is_legal(move):
            return before,move


def samples(c):
    rng=random.Random(SEED);groups=squares(c);seen=set()
    # Six boards for each combination of defender color, king region, checker
    # type, defending slider type, auxiliary material and existence of a slider reply.
    for side in (c.WHITE,c.BLACK):
        for region,king_pool in groups.items():
            for checker in (c.ROOK,c.BISHOP,c.QUEEN):
                for defender in (c.ROOK,c.BISHOP,c.QUEEN):
                    for aux in ('none','attacker','defender'):
                        counts=Counter();attempts=0
                        while len(counts)<2 or min(counts.values())<PER_STRATUM:
                            attempts+=1
                            if attempts>50000: raise ValueError((side,region,checker,defender,aux,counts))
                            end=c.Board(None);end.turn=side;king=rng.choice(king_pool)
                            # Draw a checker guaranteed to share a geometrical ray with the king.
                            end.set_piece_at(king,c.Piece(checker,side))
                            checking_sq=rng.choice(list(end.attacks(king)))
                            end.set_piece_at(king,c.Piece(c.KING,side))
                            end.set_piece_at(checking_sq,c.Piece(checker,not side))
                            places=rng.sample([sq for sq in c.SQUARES if sq not in (king,checking_sq)],3)
                            end.set_piece_at(places[0],c.Piece(c.KING,not side))
                            end.set_piece_at(places[1],c.Piece(defender,side))
                            if aux!='none':
                                kind=rng.choice((c.PAWN,c.KNIGHT,c.BISHOP,c.ROOK,c.QUEEN))
                                end.set_piece_at(places[2],c.Piece(kind,side if aux=='defender' else not side))
                            if not end.is_valid() or checking_sq not in end.checkers(): continue
                            legal_slider=any(end.piece_type_at(m.from_square) in (c.ROOK,c.BISHOP,c.QUEEN) for m in end.legal_moves)
                            if counts[legal_slider]>=PER_STRATUM: continue
                            key=REF['fen'](end)
                            if key in seen: continue
                            prior=predecessor(c,end,checking_sq,rng)
                            if not prior: continue
                            label=f"sample-{'w' if side else 'b'}-{region}-{c.piece_symbol(checker)}-{c.piece_symbol(defender)}-{aux}-{int(legal_slider)}-{counts[legal_slider]}"
                            record=describe(c,*prior,label,'stratified-'+aux)
                            assert record and record['successor']==key
                            counts[legal_slider]+=1
                            seen.add(key)
                            yield record


def stable(values):
    return json.dumps(values,sort_keys=True,separators=(',',':')).encode()


def freeze(archive, output):
    with tempfile.TemporaryDirectory(prefix='sliding-witness-panel-') as tmp:
        c=REF['load_chess'](archive,Path(tmp))
        rows=list(transformed(c))+list(samples(c))
    assert len(set(row['id'] for row in rows))==len(rows)
    encoded=stable(rows);packed=gzip.compress(encoded,compresslevel=9,mtime=0)
    record={'authority':'pinned independent python-chess on legal predecessor turns','sourceSha256':REF['PIN'],'seed':SEED,
            'samplesPerStratum':PER_STRATUM,'boards':len(rows),'uniqueSuccessors':len({r['successor'] for r in rows}),
            'families':dict(sorted(Counter(r['family'] for r in rows).items())),
            'defenderMaterial':dict(sorted(Counter(r['defenderMaterial'] for r in rows).items())),
            'features':dict(sorted(Counter(f for r in rows for f in r['features']).items())),
            'inputsAndRepliesSha256':sha256(encoded).hexdigest()}
    if output:
        output.mkdir(exist_ok=True)
        with (output/'boards.json.gz').open('xb') as f: f.write(packed)
        with (output/'freeze.json').open('x') as f: f.write(json.dumps(record,indent=2)+'\n')
    else:
        assert gzip.decompress((HERE/'boards.json.gz').read_bytes())==encoded
        assert json.loads((HERE/'freeze.json').read_bytes())==record
    return record


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('archive',type=Path)
    p.add_argument('--create',type=Path,help='new directory for a one-time freeze')
    a=p.parse_args();print(json.dumps(freeze(a.archive,a.create),indent=2))
