"""Register an independently verified receipt, preserving its original bytes."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent


def retain(archive, name, digest, bundle, engine=None, inputs=None):
    # bundle/engine are relative to this verification directory in the integrated worktree.
    inputs = (inputs or HERE).resolve()
    command = ["bun", str(HERE / "receipts.mjs"), str(archive.resolve()), "verify", digest, str(inputs / bundle)]
    if engine:
        command.append(str(inputs / engine))
    report = json.loads(subprocess.check_output(command))
    raw = (archive / (digest + ".json")).read_bytes()
    if hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError("Controller archive changed")
    spec = {"id": name, "receipt": digest, "bundle": bundle, "report": report}
    if engine:
        spec["engine"] = engine
    output = HERE / "releases"
    for file, data in [(output / (digest + ".json.gz"), gzip.compress(raw, mtime=0)),
                       (output / (name + ".json"), (json.dumps(spec, indent=2) + "\n").encode())]:
        if file.exists():
            if file.read_bytes() != data:
                raise ValueError(f"Registry key already bound to a different result: {file.name}")
            continue
        with file.open("xb") as fp:
            fp.write(data)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("name", choices=["stock-discovery", "stock", "compatibility", "stronger", "referee"])
    parser.add_argument("digest")
    parser.add_argument("bundle")
    parser.add_argument("engine", nargs="?")
    parser.add_argument("--inputs", type=Path, help="qualifying checkout's verification directory when registering from the separate verifier checkout")
    args = parser.parse_args()
    retain(args.archive, args.name, args.digest, args.bundle, args.engine, args.inputs)
