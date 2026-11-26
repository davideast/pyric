"""Build the pinned Arcade client in a fresh directory with its locked dependencies."""
import argparse
import hashlib
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

PIN = "66e14d4f4b0aeab22c05db8d748704dde053d2e5"
HERE = Path(__file__).resolve().parent


def replace(path, old, new):
    source = path.read_text()
    if source.count(old) != 1:
        raise ValueError(f"unexpected Arcade source in {path.name}")
    path.write_text(source.replace(old, new))


def build(repo, directory, engine):
    directory.mkdir()
    with tempfile.TemporaryFile() as archive:
        subprocess.run(["git", "-C", repo, "archive", PIN], stdout=archive, check=True)
        archive.seek(0)
        with tarfile.open(fileobj=archive) as tar:
            tar.extractall(directory, filter="data")
    subprocess.run(["bun", "install", "--frozen-lockfile", "--offline"], cwd=directory, check=True)
    app = directory / "app"
    # The controller supplies the isolated project's public browser configuration at runtime.
    (app / "src/firebase-config.ts").write_text(
        "const config = await (await fetch('/config')).json();\n"
        "export const firebaseOptions = config.firebase;\n"
        "export const connectOptions = {database: config.database};\n"
    )
    # Read-only scene observations let the driver wait for actual rendered UI and compare both seats.
    main = app / "src/main.ts"
    replace(main, "game.registry.set('uid', user.uid);", """game.registry.set('uid', user.uid);
Object.defineProperty(window, 'chessView', {get() {
  const scene = game.scene.getScenes(true).find(s => s.scene.key === 'chess');
  return scene?.view?.doc ?? null;
}});
Object.defineProperty(window, 'arcadeScene', {get() {
  return game.scene.getScenes(true).filter(s => s.scene.key !== 'boot').map(s => s.scene.key)[0];
}});
window.chessSignOut = async () => { const {deleteUser} = await import('firebase/auth'); await deleteUser(user); };
""")
    if engine:
        chess = directory / "games/chess/src"
        shutil.copyfile(engine, chess / "policy.mjs")
        shutil.copyfile(HERE / "policy-adapter.ts", chess / "policy-adapter.ts")
        replace(chess / "scene.ts",
                "import { inCheck, legalMoves, squareName, squareOf, type Kind, type Move } from './chess.ts';",
                """import { squareName, squareOf, type Kind, type Move } from './chess.ts';
import { inCheck, legalMoves } from './policy-adapter.ts';""")
        replace(chess / "scene.ts", "moveChess(this.connection(), this.matchId, move)",
                "moveChess(this.connection(), this.matchId, move, this.view!.doc.moveCount)")
        net = chess / "net.ts"
        net.write_text(net.read_text().split("/** Play `move`")[0] + (HERE / "move.ts.inc").read_text())
    subprocess.run([str(directory / "node_modules/.bin/vite"), "build"], cwd=app, check=True)
    subprocess.run(["bun", "build", "games/chess/src/logic.ts", "--target=node", "--outfile=native.mjs"],
                   cwd=directory, check=True)
    print("built", directory, "Arcade", PIN, "engine",
          hashlib.sha256(engine.read_bytes()).hexdigest() if engine else "stock")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("arcade", type=Path)
    parser.add_argument("new_directory", type=Path)
    parser.add_argument("--engine", type=Path)
    args = parser.parse_args()
    build(args.arcade.resolve(), args.new_directory.resolve(), args.engine)
