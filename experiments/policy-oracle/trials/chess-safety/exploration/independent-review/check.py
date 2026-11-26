"""Cross-check the chess truths with the independent hash-pinned python-chess referee."""
import argparse
import collections
import gzip
import hashlib
import json
from pathlib import Path
import runpy
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
TRIAL = HERE.parent.parent
external = runpy.run_path(str(TRIAL.parent / "chess/reference/generate.py"))


def cases(trial):
    for path in sorted((trial / "batches").glob("*/v1/native.json")):
        yield path.parents[1].name, json.loads(path.read_bytes())["cases"]
    for name in ("native", "cost-native", "path-native"):
        path = trial.parent / "king-safety/reference" / (name + ".json")
        yield "file-pins/" + name, json.loads(path.read_bytes())["cases"]
    for path in sorted((trial / "exploration").glob("*/corpus.json.gz")):
        yield path.parent.name, json.loads(gzip.decompress(path.read_bytes()))


def check(chess, trial):
    reports = {}
    for name, rows in cases(trial):
        faults, invalid = collections.Counter(), collections.Counter()
        first, invalid_first = {}, {}
        legal_checked = invalid_rows = 0
        compared = collections.Counter()
        for c in rows:
            board = chess.Board(c["fen"])
            state = board.status()
            if state != chess.STATUS_VALID:
                invalid_rows += 1
                for label, code in vars(chess).items():
                    if label.startswith("STATUS_") and code and state & code:
                        invalid[label] += 1
                        invalid_first.setdefault(label, {"id": c["id"], "fen": c["fen"]})
            move = chess.Move.from_uci(c["uci"])
            legal = move in board.legal_moves
            admission = legal
            seen = {"beforeCheck": board.is_check()}
            # For pseudo-legal self-checks, python-chess can apply the move and
            # independently inspect the mover's king even when the move is refused.
            if board.is_pseudo_legal(move):
                future = board.copy(stack=False)
                future.push(move)
                attacked = future.is_attacked_by(future.turn, future.king(not future.turn))
                seen["afterCheck"] = attacked
                if not board.is_castling(move):
                    seen["kingSafe"] = not attacked
            if legal:
                legal_checked += 1
                board.push(move)
                seen["kingSafe"] = True
                expected_fen = external["fen"](board)
                outcome = external["adjudicate"](board)
                status = {"playing": "playing", "stalemate": "draw", "checkmate": "won"}[outcome]
                winner = ("guest" if board.turn == chess.WHITE else "host") if status == "won" else ""
                if "claim" in c:
                    admission = c["claim"] == {"status": status, "winner": winner}
                if "claimedRights" in c:
                    admission = c["claimedRights"] == expected_fen.split()[2].replace("-", "")
                seen.update(successor=expected_fen, outcome=outcome)
                replies = sorted(m.uci() for m in board.legal_moves)
                reply_bytes = json.dumps(replies, separators=(",", ":")).encode()
                seen.update(replies=replies, replyCount=len(replies), replySha256=hashlib.sha256(reply_bytes).hexdigest())
            seen.update(nativeLegal=legal, nativeAdmission=admission)
            for field, observed in seen.items():
                if field not in c:
                    continue
                compared[field] += 1
                if c[field] == observed:
                    continue
                faults[field] += 1
                first.setdefault(field, {"id": c["id"], "fen": c["fen"], "uci": c["uci"],
                                         "native": c[field], "external": observed, "validSource": not bool(state)})
        reports[name] = {"rows": len(rows), "legalMoves": legal_checked, "invalidSourceRows": invalid_rows,
                         "checkedFields": dict(compared),
                         "invalidSourceReasons": dict(invalid), "firstInvalid": invalid_first,
                         "disagreements": dict(faults), "firstDisagreement": first}
    return {"authority": "independent python-chess 1.11.2 source", "archiveSha256": external["PIN"],
            "checked": sum(v["rows"] for v in reports.values()), "cohorts": reports}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("archive", type=Path)
    p.add_argument("--trial", type=Path, default=TRIAL)
    args = p.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        chess = external["load_chess"](args.archive, Path(tmp))
        print(json.dumps(check(chess, args.trial.resolve()), indent=2))


if __name__ == "__main__":
    main()
