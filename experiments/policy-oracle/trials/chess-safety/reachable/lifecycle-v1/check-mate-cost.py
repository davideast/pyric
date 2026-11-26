"""Independently verify the unchanged four-ply native sequence on each reduced seed."""
import argparse
import hashlib
import json
from pathlib import Path
import runpy
import tempfile

HERE = Path(__file__).resolve().parent
external = runpy.run_path(str(HERE.parents[2]/"chess/reference/generate.py"))


def audit(chess, result):
    verified = []
    for source in [result["original"], *result["minimizations"]]:
        board = chess.Board(source["seedFen"])
        assert board.is_valid() and len(board.piece_map())==source["pieces"]
        assert [s["uci"] for s in source["path"]]==["f2f3","e7e5","g2g4","d8h4"]
        for index,step in enumerate(source["path"]):
            assert external["fen"](board)==step["fen"] and not board.is_game_over(claim_draw=False)
            m = chess.Move.from_uci(step["uci"])
            assert m in board.legal_moves
            board.push(m)
            assert board.is_valid() and external["fen"](board)==step["afterFen"]
            assert board.is_checkmate()==(index==3)
        assert board.legal_moves.count()==0 and board.turn==chess.WHITE
        verified.append({"seedFen":source["seedFen"],"pieces":source["pieces"],"final":external["fen"](board),
                         "finalReplies":0,"outcome":"checkmate","winningSeat":"guest"})
    return {"refereeSha256":external["PIN"],"rulesSha256":result["rulesSha256"],"verifiedLines":verified}


if __name__=="__main__":
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("archive",type=Path)
    p.add_argument("result",type=Path)
    args=p.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        chess=external["load_chess"](args.archive,Path(tmp))
        raw=args.result.read_bytes()
        receipt=audit(chess,json.loads(raw))
        receipt["scoredResultSha256"]=hashlib.sha256(raw).hexdigest()
        print(json.dumps(receipt,indent=2))
