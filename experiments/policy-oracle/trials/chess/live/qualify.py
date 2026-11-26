"""Qualify complete bundles serially against the named database pinned by the live controller."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROFILES = ("stock", "compatibility", "stronger", "referee")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("client_build", type=Path)
    parser.add_argument("engine", type=Path)
    parser.add_argument("profiles", nargs="+", choices=PROFILES)
    cohort = parser.add_mutually_exclusive_group()
    cohort.add_argument("--supplement", action="store_true")
    cohort.add_argument("--boundary", action="store_true")
    args = parser.parse_args()
    embedded = args.client_build / "games/chess/src/policy.mjs"
    if embedded.read_bytes() != args.engine.read_bytes():
        parser.error("the client build and referee must use the same engine")
    built = json.loads((args.client_build / "chess-build.json").read_bytes())
    if built["engine"] != hashlib.sha256(args.engine.read_bytes()).hexdigest():
        parser.error("built browser engine differs from the release")
    dist = args.client_build / "app/dist"
    actual = {str(p.relative_to(dist)): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in dist.rglob("*") if p.is_file()}
    if actual != built["files"] or built["native"] != hashlib.sha256((args.client_build / "native.mjs").read_bytes()).hexdigest():
        parser.error("browser assets or native control have changed since the build")
    results = {}
    for profile in args.profiles:
        bundle = HERE.parent / "bundle/artifacts" / (profile + ".rules")
        check = HERE.parent / "bundle/placement/check.py"
        gate = ["python3", check, profile, bundle]
        if profile == "referee":
            gate.extend([args.engine, args.engine.with_name("chess-match.mjs"),
                         HERE.parent / "policies/lock.json", "--require-complete"])
        else:
            gate.extend(["-", "-", "-"])
        subprocess.run(gate, check=True, stdout=subprocess.DEVNULL)
        digest = hashlib.sha256(bundle.read_bytes()).hexdigest()
        command = ["node", HERE / "capture.mjs", profile, args.archive, bundle,
                   digest, args.client_build, args.engine]
        if args.supplement:
            command.append("supplement")
        if args.boundary:
            command.append("boundary")
        result = subprocess.run(command)
        results[profile] = result.returncode
        # Each next profile independently checks the closed release and lease.
    print(results, flush=True)
    return int(any(results.values()))


if __name__ == "__main__":
    raise SystemExit(main())
