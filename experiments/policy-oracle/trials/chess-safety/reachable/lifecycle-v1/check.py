"""Rebuild complete Arcade match heads and outgoing control writes with python-chess."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import runpy
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
REFERENCE = HERE.parents[2]/"chess/reference"
external = runpy.run_path(str(REFERENCE/"generate.py"))
HOST, GUEST = "white-player", "black-player"
STAMP = {"type":"firestore/timestamp/1.0","seconds":1767225600,"nanoseconds":0}


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",",":")).encode()


def digest(value):
    return hashlib.sha256(encode(value)).hexdigest()


def pieces(board, chess):
    result = {}
    for sq in chess.SQUARES:
        p = board.piece_at(sq)
        result[chess.square_name(sq)] = (("w" if p.color else "b") + p.symbol().lower()) if p else ""
    return result


def fen_fields(board, chess):
    return pieces(board,chess), board.castling_xfen().replace("-",""), chess.square_name(board.ep_square) if board.ep_square is not None else ""


def heads(chess, trace):
    board = chess.Board(trace["rows"][0]["fen"])
    start = external["fen"](board) == external["fen"](chess.Board())
    assert board.is_valid()
    mapping, rights, ep = fen_fields(board,chess)
    doc = {"host":HOST,"guest":"","status":"waiting","currentTurn":"host" if board.turn else "guest","winner":"",
           "moveCount":0 if start else 16 if board.turn else 17,"board":mapping,"prevBoard":mapping,
           "castling":rights,"prevCastling":rights,"enPassant":ep,"prevEnPassant":ep,"createdAt":STAMP,
           "lastMove":{"from":"","to":"","promotion":"","extra":[]}}
    if start:
        create = doc | {"createdAt":{"__type":"serverTimestamp"}}
        yield "create",0,HOST,doc,None,create,[("other-creates-for-host",GUEST,create)]
        joined = doc | {"guest":GUEST,"status":"playing"}
        yield "join",0,GUEST,joined,doc,joined,[("host-claims-second-seat",HOST,joined|{"guest":HOST})]
        doc = joined
    else:
        doc = doc | {"guest":GUEST,"status":"playing"}
        yield "seed",0,None,doc,None,None,[]
    for index,row in enumerate(trace["rows"][:-1]):
        assert external["fen"](board) == row["fen"]
        uci = row["move"]
        move = chess.Move.from_uci(uci)
        assert move in board.legal_moves
        who = HOST if board.turn else GUEST
        board.push(move)
        assert external["fen"](board) == trace["rows"][index+1]["fen"]
        mapping,rights,ep = fen_fields(board,chess)
        fr,to = uci[:2],uci[2:4]
        extra = sorted(s for s in mapping if s not in (fr,to) and mapping[s] != doc["board"][s])
        status = "won" if board.is_checkmate() else "draw" if board.is_stalemate() else "playing"
        new = doc | {"currentTurn":"host" if board.turn else "guest","board":mapping,"prevBoard":doc["board"],
                     "winner":doc["currentTurn"] if status=="won" else "","status":status,"moveCount":doc["moveCount"]+1,
                     "castling":rights,"prevCastling":doc["castling"],"enPassant":ep,"prevEnPassant":doc["enPassant"],
                     "lastMove":{"from":fr,"to":to,"promotion":uci[4:],"extra":extra}}
        bad = [("wrong-seat",GUEST if who==HOST else HOST,new),("old-ply",who,new|{"moveCount":doc["moveCount"]})]
        for claim in ("playing","won","draw"):
            if claim != status:
                bad.append(("claim-"+claim,who,new|{"status":claim,"winner":doc["currentTurn"] if claim=="won" else ""}))
        if doc["prevBoard"] != doc["board"]:
            bad.append(("stale-previous-board",who,new|{"prevBoard":doc["prevBoard"]}))
        if doc["board"][to]:
            bad.append(("captured-piece-restored",who,new|{"board":mapping|{fr:doc["board"][to]}}))
        if extra:
            label = "castle-rook-unmoved" if doc["board"][fr][1]=="k" else "en-passant-victim-restored"
            bad.append((label,who,new|{"board":mapping|{sq:doc["board"][sq] for sq in extra}}))
        yield "move",index+1,who,new,doc,new,bad
        doc = new


def check(chess):
    raw = (REFERENCE/"public.json.gz").read_bytes()
    frozen = json.loads((HERE/"freeze.json").read_bytes())
    assert hashlib.sha256(raw).hexdigest() == frozen["archiveSha256"]
    records = []
    for trace in json.loads(gzip.decompress(raw))["traces"]:
        stored,req = hashlib.sha256(),hashlib.sha256()
        final = None
        for kind,ply,actor,after,before,data,bad in heads(chess,trace):
            final = after
            stored.update(encode([kind,ply,actor,after])+b"\n")
            if kind=="seed":
                continue
            method = "create" if kind=="create" else "update"
            all_requests = [(kind,actor,data,True)] + [(k,a,d,False) for k,a,d in bad]
            for k,a,d,v in all_requests:
                req.update(encode([ply,method,digest(before),k,a,digest(d),v])+b"\n")
        name = trace["name"]
        expected = frozen["records"][name]
        assert (stored.hexdigest(),req.hexdigest(),digest(final)) == (
            expected["headsSha256"],expected["requestsSha256"],expected["headSha256"]), name
        records.append([name,stored.hexdigest(),req.hexdigest()])
    assert digest(records)==frozen["sha256"]
    return {"referee":"python-chess 1.11.2","refereeArchiveSha256":external["PIN"],
            "traces":len(records),"completeHeadsAndRequestsSha256":digest(records),
            "positiveWrites":frozen["positiveWrites"],"invalidProposals":frozen["invalidProposals"]}


if __name__ == "__main__":
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("archive",type=Path)
    args=p.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        chess=external["load_chess"](args.archive,Path(tmp))
        print(json.dumps(check(chess),indent=2))
