"""Compile both authored policies in an empty offline consumer and verify the release bytes."""
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
VENDOR = HERE.parents[2] / "arcade/vendor"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    pins = json.loads((HERE / "lock.json").read_text())
    compiler = HERE / "vendor/pyric-rules-chess.tgz"
    if digest(compiler) != pins["package"]:
        raise ValueError("packed compiler differs from release lock")
    with tempfile.TemporaryDirectory(prefix="arcade-chess-consumer-") as temp:
        work = Path(temp)
        for package, filename in [("@pyric/rules", compiler), ("ohm-js", VENDOR / "ohm-js-17.5.0.tgz"),
                                  ("zod", VENDOR / "zod-3.25.76.tgz")]:
            if not filename.is_file():
                raise ValueError(f"missing packed {package}")
        (work / "package.json").write_text(json.dumps({"private": True, "type": "module", "dependencies": {
            "@pyric/rules": f"file:{compiler}", "ohm-js": f"file:{VENDOR}/ohm-js-17.5.0.tgz",
            "zod": f"file:{VENDOR}/zod-3.25.76.tgz"}}))
        subprocess.run(["npm", "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
                       cwd=work, env={**os.environ, "npm_config_cache": str(work / "cache")}, check=True)
        for name in ["build.mjs", "chess.policy", "chess-match.policy"]:
            shutil.copyfile(HERE / name, work / name)
        subprocess.run(["node", "build.mjs"], cwd=work, check=True)
        for key, filename in [("board", "chess.mjs"), ("match", "chess-match.mjs")]:
            if digest(work / filename) != pins[key] or (HERE / filename).read_bytes() != (work / filename).read_bytes():
                raise ValueError(f"emitted {key} policy differs from the lock")
            print(filename, pins[key])


if __name__ == "__main__":
    main()
