"""Export and reread the two qualified browser games using the pinned independent engine."""
import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
REFEREE_SHA = "a8b43e5678fdb3000695bdaa573117ad683761e5ca38e591c4826eba6d25bb39"


def board_map(chess, board):
    def code(square):
        piece = board.piece_at(square)
        if piece is None:
            return ""
        return ("w" if piece.color else "b") + piece.symbol().lower()
    return {chess.square_name(sq): code(sq) for sq in chess.SQUARES}


def same_position(chess, board, doc):
    assert board_map(chess, board) == doc["board"]
    assert ("host" if board.turn else "guest") == doc["currentTurn"]
    assert board.castling_xfen().replace("-", "") == doc["castling"]
    assert (chess.square_name(board.ep_square) if board.ep_square is not None else "") == doc["enPassant"]


def export(archive):
    if hashlib.sha256(archive.read_bytes()).hexdigest() != REFEREE_SHA:
        raise ValueError("Unrecognized independent reference distribution")
    prefix = "chess-1.11.2/chess/"
    with tempfile.TemporaryDirectory() as libraries:
        directory = Path(libraries) / "chess"
        directory.mkdir()
        with tarfile.open(archive) as dist:
            for member in dist:
                name = member.name.removeprefix(prefix)
                if member.name.startswith(prefix) and "/" not in name and name.endswith(".py") and member.isfile():
                    (directory / name).write_bytes(dist.extractfile(member).read())
        sys.path.insert(0, libraries)
        import chess
        import chess.pgn

        pin = json.loads((HERE / "releases/referee.json").read_text())
        receipt = gzip.decompress((HERE / "releases" / (pin["receipt"] + ".json.gz")).read_bytes())
        assert hashlib.sha256(receipt).hexdigest() == pin["receipt"]
        state = json.loads(receipt)["browser"]
        games = []
        for round_no, key in enumerate(["match", "rematch"], 1):
            match_id = state[key]
            docs = [snap["data"] for row in state["observations"] for snap in row["snapshots"] if snap["path"] == "chess/" + match_id]
            initial, terminal = docs[0], docs[-1]
            assert initial["status"] == "waiting"
            if round_no == 2:
                assert initial["rematchOf"] == state["match"]
            board = chess.Board()
            same_position(chess, board, initial)
            game = chess.pgn.Game()
            played = datetime.fromtimestamp(initial["createdAt"]["seconds"], timezone.utc).astimezone(ZoneInfo("America/New_York"))
            result = "0-1" if terminal["winner"] == "guest" else "1-0"
            game.headers.update(Event="Arcade chess qualification", Site="Arcade", Date=played.strftime("%Y.%m.%d"),
                                Round=str(round_no), White="Host", Black="Guest", Result=result)
            node = game
            for doc in docs:
                ply = doc["moveCount"]
                if ply == board.ply():
                    same_position(chess, board, doc)
                    continue
                assert ply == board.ply() + 1
                move = doc["lastMove"]
                uci = move["from"] + move["to"] + move["promotion"]
                parsed = board.parse_uci(uci)
                node = node.add_main_variation(parsed)
                board.push(parsed)
                same_position(chess, board, doc)
            assert board.ply() == terminal["moveCount"]
            if round_no == 1:
                assert terminal["status"] == "won" and board.is_checkmate() and board.result() == result == "0-1"
            else:
                assert terminal["status"] == "resigned" and result == "1-0" and not board.is_game_over()
                node.comment = "Black resigned."
            games.append((game, board, terminal))
        text = "\n\n".join(str(game) for game, _, _ in games) + "\n"
        stream = io.StringIO(text)
        for original, board, terminal in games:
            parsed = chess.pgn.read_game(stream)
            assert not parsed.errors and parsed.headers == original.headers
            assert list(parsed.mainline_moves()) == list(original.mainline_moves())
            assert parsed.end().board().fen(en_passant="fen") == board.fen(en_passant="fen")
            same_position(chess, parsed.end().board(), terminal)
        assert chess.pgn.read_game(stream) is None
        return text


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("referee_tarball", type=Path)
    args = parser.parse_args()
    print(export(args.referee_tarball), end="")
