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
    expected = report["mode"] + ("-" + report["cohort"] if report.get("cohort") else "")
    if name != expected and not (name == "stock-discovery" and expected == "stock" and report["exactProtocolIntents"] == 0):
        raise ValueError("Registry key and release mode differ")
    raw = (archive / (digest + ".json")).read_bytes()
    if hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError("Controller archive changed")
    spec = {"id": name, "receipt": digest, "bundle": bundle, "report": report}
    if engine:
        spec["engine"] = engine
    output = HERE / "releases"
    reads = output.parent / "reads"
    reads.mkdir(exist_ok=True)
    unsigned = list((archive / report["runId"]).glob("*-unauthenticated-read.json"))
    if len(unsigned) != 1:
        raise ValueError("Expected one signed-out read from the qualified archive")
    artifacts = [(reads / (digest + ".json"), unsigned[0].read_bytes()),
                       (output / (digest + ".json.gz"), gzip.compress(raw, mtime=0)),
                       (output / (name + ".json"), (json.dumps(spec, indent=2) + "\n").encode())]
    if "browser" in report:
        screens = output.parent / "screens" / digest
        screens.mkdir(parents=True, exist_ok=True)
        for item in report["browser"]["screenshots"]:
            data = (archive / report["runId"] / item["file"]).read_bytes()
            if hashlib.sha256(data).hexdigest() != item["sha256"]:
                raise ValueError("Screenshot changed after verification")
            artifacts.append((screens / item["file"], data))
    for file, data in artifacts:
        if file.exists():
            if file.read_bytes() != data:
                raise ValueError(f"Registry key already bound to a different result: {file.name}")
            continue
        with file.open("xb") as fp:
            fp.write(data)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("name", choices=["stock-discovery", "stock", "compatibility", "stronger", "referee", "stock-supplement", "compatibility-supplement", "stronger-supplement", "referee-boundary"])
    parser.add_argument("digest")
    parser.add_argument("bundle")
    parser.add_argument("engine", nargs="?")
    parser.add_argument("--inputs", type=Path, help="qualifying checkout's verification directory when registering from the separate verifier checkout")
    args = parser.parse_args()
    retain(args.archive, args.name, args.digest, args.bundle, args.engine, args.inputs)
