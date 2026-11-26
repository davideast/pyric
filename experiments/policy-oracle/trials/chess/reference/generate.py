"""Generate oracle observations with a hash-pinned external python-chess source."""
import argparse
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tarfile
import tempfile

PIN = "a8b43e5678fdb3000695bdaa573117ad683761e5ca38e591c4826eba6d25bb39"


def load_chess(archive, directory):
    if hashlib.sha256(archive.read_bytes()).hexdigest() != PIN:
        raise ValueError("Independent referee source digest mismatch")
    source = directory / "chess.py"
    with tarfile.open(archive) as files:
        source.write_bytes(files.extractfile("chess-1.11.2/chess/__init__.py").read())
    spec = importlib.util.spec_from_file_location("chess", source)
    chess = importlib.util.module_from_spec(spec)
    sys.modules["chess"] = chess
    spec.loader.exec_module(chess)
    return chess


def fen(board):
    return " ".join(board.fen(en_passant="fen").split()[:4])


def adjudicate(board):
    if board.is_checkmate():
        return "checkmate"
    return "stalemate" if board.is_stalemate() else "playing"


def sample(board, moves):
    return {"fen": fen(board), "legal": [m.uci() for m in moves], "outcome": adjudicate(board)}


def sorted_moves(board):
    return sorted(board.legal_moves, key=lambda m: m.uci())


def successors(board, moves):
    result = {}
    for move in moves:
        board.push(move)
        result[move.uci()] = fen(board)
        board.pop()
    return result


def count(board, depth):
    if depth == 0:
        return 1
    if depth == 1:
        return board.legal_moves.count()
    total = 0
    for move in board.legal_moves:
        board.push(move)
        total += count(board, depth - 1)
        board.pop()
    return total


def divide(board, depth):
    result = {}
    for move in sorted_moves(board):
        board.push(move)
        result[move.uci()] = count(board, depth - 1)
        board.pop()
    return result


def position(chess, initial):
    board = chess.Board() if initial == "startpos" else chess.Board(initial)
    if not board.is_valid():
        raise ValueError(f"Invalid oracle position {initial} (status {board.status()})")
    return board


def case(chess, config):
    board = position(chess, config["fen"])
    moves = sorted_moves(board)
    return {
        "name": config["name"],
        **sample(board, moves),
        "successors": successors(board, moves),
        "divides": [divide(board, depth) for depth in range(1, config.get("depth", 0) + 1)],
    }


def next_word(seed):
    word = seed ^ ((seed << 13) & 0xffffffff)
    word ^= word >> 17
    return word ^ ((word << 5) & 0xffffffff)


def trace(chess, name, initial, script=None, seed=None, limit=0):
    board = position(chess, initial)
    rows = []
    for ply in range((limit if script is None else len(script)) + 1):
        moves = sorted_moves(board)
        snapshot = sample(board, moves)
        rows.append(snapshot)
        if script is None:
            if not moves or ply == limit:
                break
            seed = next_word(seed)
            move = moves[seed % len(moves)]
        else:
            if ply == len(script):
                break
            move = board.parse_uci(script[ply])
        snapshot["move"] = move.uci()
        board.push(move)
    return {"name": name, "rows": rows}


def generate(chess, config):
    positions = [case(chess, p) for p in config["positions"]]
    traces = [trace(chess, "seed-" + str(s), "startpos", seed=s, limit=config["plies"]) for s in config["seeds"]]
    for s in config.get("scripts", []):
        result = trace(chess, s["name"], s["fen"], script=s["moves"].split())
        if "outcome" in s and result["rows"][-1]["outcome"] != s["outcome"]:
            raise ValueError(f"Scripted terminal mismatch for {s['name']}")
        traces.append(result)
    return {"engine": "python-chess 1.11.2", "positions": positions, "traces": traces}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("inputs", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        data = generate(load_chess(args.archive, Path(tmp)), json.loads(args.inputs.read_text()))
    data["inputDigest"] = hashlib.sha256(args.inputs.read_bytes()).hexdigest()
    serialized = json.dumps(data, separators=(",", ":"), sort_keys=True).encode("utf-8")
    args.output.write_bytes(gzip.compress(serialized, mtime=0))
