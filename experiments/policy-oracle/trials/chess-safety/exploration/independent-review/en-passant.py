"""Verify each two-ply en-passant witness using the pinned external chess referee."""
import argparse
from collections import Counter
import gzip
import hashlib
import json
from pathlib import Path
import runpy
import sys
import tempfile

sys.dont_write_bytecode = True
TRIAL = Path(__file__).resolve().parents[2]
external = runpy.run_path(str(TRIAL.parent / "chess/reference/generate.py"))


def verify(chess, data):
    current = chess.Board(data["priorFen"])
    assert current.is_valid(), ("invalid prior", data)
    push = chess.Move.from_uci(data["push"])
    assert push in current.legal_moves and current.piece_type_at(push.from_square) == chess.PAWN, data
    assert abs(push.from_square - push.to_square) == 16, data
    current.push(push)
    assert current.is_valid() and external["fen"](current) == data["fen"], data
    assert current.ep_square == (push.from_square + push.to_square) // 2, data
    expected = {}
    for move in current.generate_pseudo_legal_ep():
        leg = current.is_legal(move)
        assert current.is_en_passant(move)
        after = current.copy(stack=False)
        after.push(move)
        assert not after.piece_at(push.to_square), data
        assert after.ep_square is None, data
        exposed = after.is_attacked_by(after.turn, after.king(not after.turn))
        assert leg != exposed, data
        expected[move.uci()] = (leg, external["fen"](after))
    for item in data.get("cases", [data]):
        legal, target = expected[item["uci"]]
        assert item["nativeAdmission"] == legal and target == item["successor"], item
        if "kingSafe" in item:
            assert item["kingSafe"] == legal and item["nativeLegal"] == legal, item
        if "group" in item:
            kind = item["group"].split("/")[1]
            if kind == "captures-checking-pawn":
                assert legal and set(current.checkers()) == {push.to_square}, item
            elif kind == "fails-to-escape":
                assert current.is_check() and not legal, item
            elif kind.startswith("opens-"):
                after = current.copy(stack=False)
                after.push(chess.Move.from_uci(item["uci"]))
                attackers = after.attackers(after.turn, after.king(not after.turn))
                assert not current.is_check() and not legal, item
                assert kind.split("-")[1] in {after.piece_at(s).symbol().lower() for s in attackers}, item
            elif kind.startswith("two-capturers-"):
                assert len(expected) == 2 and {v[0] for v in expected.values()} == {True, False}, item
                assert not current.is_check() and legal == kind.endswith("safe"), item
            elif kind == "ordinary-safe":
                assert not current.is_check() and legal, item
            else:
                raise ValueError(f"Unhandled EP category {kind}")
    if "cases" in data:
        assert set(expected) == {v["uci"] for v in data["cases"]} and len(expected) == 2, data
        assert {a[0] for a in expected.values()} == {True, False}, data


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("archive", type=Path)
    p.add_argument("--trial", type=Path, default=TRIAL)
    args = p.parse_args()
    source = args.trial / "exploration/en-passant-evasions-v1"
    raw = gzip.decompress((source / "corpus.json.gz").read_bytes())
    pairs = (source / "pairs.json").read_bytes()
    corpus = json.loads(raw)
    doubles = json.loads(pairs)
    digest = lambda data: hashlib.sha256(data).hexdigest()
    assert digest(raw) == json.loads((source / "freeze.json").read_bytes())["sha256"]
    with tempfile.TemporaryDirectory() as tmp:
        chess = external["load_chess"](args.archive, Path(tmp))
        for case in corpus + doubles:
            verify(chess, case)
    original = {(c["fen"], c["uci"]) for c in corpus}
    doubled = {(p["fen"], c["uci"]) for p in doubles for c in p["cases"]}
    result = {"referee": "python-chess 1.11.2", "archiveSha256": external["PIN"],
              "singlesSha256": digest(raw), "pairsSha256": digest(pairs),
              "twoPlyRowsVerified": len(corpus) + 2*len(doubles),
              "uniqueBeforeAndCapture": len(original | doubled), "pairedBoards": len(doubles),
              "uniqueLegalPreviousPushes":len({(c["priorFen"],c["push"]) for c in corpus+doubles}),
              "individuals": dict(Counter("allow" if c["nativeAdmission"] else "deny" for c in corpus)),
              "paired": {"allow":len(doubles), "deny":len(doubles)}}
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
