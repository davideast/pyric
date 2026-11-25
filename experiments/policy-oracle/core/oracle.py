"""Discover versioned policy claims and replay reviewed probes offline."""

import argparse
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

DEFAULT_ROOT = Path(__file__).resolve().parents[1]
SLUG = r"[a-z0-9]+(?:-[a-z0-9]+)*"
VERSION = r"v[1-9][0-9]*"
AUTHORITIES = {"native-model", "firestore-sdk", "rtdb-production"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def parse(data):
    return json.loads(data, object_pairs_hook=unique_object, parse_constant=reject_constant)


def reject_constant(value):
    raise ValueError(f"invalid JSON number {value}")


def load(path):
    try:
        require(not path.is_symlink(), f"symlink: {path}")
        return parse(path.read_bytes())
    except ValueError as error:
        raise ValueError(f"{path}: {error}") from error


def directories(parent, pattern=SLUG):
    require(not parent.is_symlink() and parent.is_dir(), f"missing or symlink directory: {parent}")
    for path in sorted(parent.iterdir()):
        require(not path.is_symlink(), f"symlink: {path}")
        if path.is_dir():
            require(re.fullmatch(pattern, path.name), f"invalid directory ID: {path}")
            yield path


def records(parent):
    require(not parent.is_symlink(), f"symlink: {parent}")
    if not parent.exists():
        return
    require(parent.is_dir(), f"expected directory: {parent}")
    for path in sorted(parent.iterdir()):
        require(path.is_file() and not path.is_symlink() and path.suffix == ".json"
                and re.fullmatch(SLUG, path.stem), f"invalid record: {path}")
        yield path


def claim_dirs(root):
    for family in directories(root / "suites"):
        for subject in directories(family):
            claims = subject / "claims"
            require(not claims.is_symlink(), f"symlink: {claims}")
            for claim in directories(claims):
                for version in directories(claim, VERSION):
                    yield "/".join([family.name, subject.name, claim.name, version.name]), version


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def safe_file(directory, name):
    require(isinstance(name, str) and name and not name.startswith("/"), f"invalid file name: {name}")
    path = directory
    for part in name.split("/"):
        require(part not in ("", ".", ".."), f"invalid path: {name}")
        path = path / part
        require(not path.is_symlink(), f"symlink: {path}")
    require(path.is_file(), f"missing file: {path}")
    return path


def pin_files(root, probe, recipe):
    pins = recipe["pins"]
    require(isinstance(pins, dict) and recipe["replay"] in pins, f"unpinned replay: {probe}")
    for name, target in pins.items():
        path = (safe_file(root, name.removeprefix("@oracle/")) if name.startswith("@oracle/")
                else safe_file(probe, name))
        require(sha(path.read_bytes()) == target, f"stale input pin: {path}")
    return safe_file(probe, recipe["replay"])


def pointer_value(raw, pointer):
    require(isinstance(pointer, str) and (not pointer or pointer.startswith("/")),
            f"invalid JSON pointer {pointer!r}")
    if pointer:
        for token in pointer[1:].split("/"):
            require(not re.search(r"~(?![01])", token), f"invalid JSON pointer escape: {pointer}")
            token = token.replace("~1", "/").replace("~0", "~")
            if isinstance(raw, list):
                require(re.fullmatch(r"0|[1-9][0-9]*", token), f"invalid array index: {pointer}")
                raw = raw[int(token)]
            else:
                require(isinstance(raw, dict) and token in raw, f"missing raw evidence field: {pointer}")
                raw = raw[token]
    return raw


def exact_cases(values, cases, where):
    require(isinstance(values, dict) and set(values) == set(cases), f"case set mismatch: {where}")


def observed_values(path, authority, input_digest, cases):
    observation = load(path)
    require(observation["authority"] == authority, f"ineligible authority: {path}")
    require(observation["inputDigest"] == input_digest, f"stale observation inputs: {path}")
    results = observation["results"]
    evidence = observation["evidence"]
    exact_cases(results, cases, path)
    exact_cases(evidence["pointers"], cases, path)
    raw_path = safe_file(path.parent.parent, evidence["path"])
    raw = raw_path.read_bytes()
    require(sha(raw) == evidence["sha256"], f"stale raw evidence: {raw_path}")
    document = parse(raw)
    for case in cases:
        literal = pointer_value(document, evidence["pointers"][case])
        require(canonical(literal) == canonical(results[case]), f"raw evidence disagrees: {path} {case}")
    return results


def run_json(command, directory, root):
    process = subprocess.run(command, cwd=directory, capture_output=True, text=True,
                             env={**os.environ, "ORACLE_ROOT": str(root)})
    require(process.returncode == 0, f"replay failed: {directory}\n{process.stderr or process.stdout}")
    return parse(process.stdout)


def inspect_probe(root, version, claim_file, authority, replay, pins):
    recipe_file = version / "recipe.json"
    recipe = load(recipe_file)
    source = recipe["source"]
    require(isinstance(source, dict) and isinstance(source["repo"], str) and source["repo"]
            and isinstance(source["path"], str) and source["path"]
            and re.fullmatch(r"[a-f0-9]{40}", source["revision"]), f"invalid source: {recipe_file}")
    cases = recipe["cases"]
    require(isinstance(cases, list) and cases and all(isinstance(c, str) and c for c in cases)
            and len(set(cases)) == len(cases), f"duplicate or invalid case IDs: {recipe_file}")
    runner = pin_files(root, version, recipe)
    input_digest = sha(claim_file.read_bytes() + b"\0" + recipe_file.read_bytes())
    pins[str(recipe_file.relative_to(root))] = sha(recipe_file.read_bytes())
    observations = {}
    for receipt in records(version / "observations"):
        observations[receipt.stem] = observed_values(receipt, authority, input_digest, cases)
        pins[str(receipt.relative_to(root))] = sha(receipt.read_bytes())
    distinct = {canonical(value) for value in observations.values()}
    report = {"cases": cases, "observations": list(observations), "status": "pending"}
    if len(distinct) > 1:
        return {**report, "status": "disputed", "answers": observations}
    if observations:
        report["status"] = "evidenced"
    if replay:
        output = run_json(["bun", str(runner)], version, root)
        for side in ("candidate", "mutant"):
            exact_cases(output[side], cases, str(runner))
        report["predictions"] = output
        if observations:
            expected = next(iter(observations.values()))
            for side in ("candidate", "mutant"):
                report[f"{side}Misses"] = [case for case in cases
                                           if canonical(expected[case]) != canonical(output[side][case])]
            report["status"] = "diverged" if report["candidateMisses"] else "conforms"
    return report


def inspect(root, replay=False):
    claims = {}
    pins = {}
    for claim_id, path in claim_dirs(root):
        claim_file = path / "claim.json"
        spec = load(claim_file)
        authority = spec["authority"]
        require(authority in AUTHORITIES and isinstance(spec["description"], str) and spec["description"],
                f"invalid claim: {claim_id}")
        pins[str(claim_file.relative_to(root))] = sha(claim_file.read_bytes())
        obligations = {}
        for obligation in records(path / "obligations"):
            obligations[obligation.stem] = load(obligation)["probe"]
            pins[str(obligation.relative_to(root))] = sha(obligation.read_bytes())
        require(obligations, f"no obligations: {claim_id}")
        probes = {}
        for probe in directories(path / "probes"):
            for version in directories(probe, VERSION):
                probes[f"{probe.name}/{version.name}"] = inspect_probe(
                    root, version, claim_file, authority, replay, pins)
        require(set(obligations.values()) <= probes.keys(), f"missing required probe: {claim_id}")
        states = {probes[key]["status"] for key in obligations.values()}
        status = next(state for state in ("disputed", "diverged", "pending", "evidenced", "conforms")
                      if state in states)
        claims[claim_id] = {"authority": authority, "status": status, "obligations": obligations,
                            "probes": probes}
        if status in ("conforms", "diverged"):
            claims[claim_id]["mutationDetected"] = any(probes[key]["mutantMisses"] for key in obligations.values())
    require(claims, "no claims discovered")
    return {"claims": claims}, {"version": 1, "pins": pins}


def archive_results(root):
    archive = root / "arcade"
    result = run_json([str(archive / "replay"), "--json"], archive, root)
    require(len(result["rows"]) == result["correctDecisions"] == 21 and
            result["evidenceCoverage"] == result["conformance"] == [2, 2] and
            result["mutationFalseAllows"] == result["mutationFalseDenials"] == 4,
            "frozen Arcade baseline changed")
    return {"claims": [f"arcade/tictactoe/{row['id']}/v1" for row in result["claims"]],
            "decisions": result["correctDecisions"], "falseAllows": result["mutationFalseAllows"],
            "falseDenials": result["mutationFalseDenials"]}


def check_baseline(path, snapshot):
    baseline = load(path)
    require(baseline["version"] == 1 and isinstance(baseline["pins"], dict) and baseline["pins"],
            f"invalid baseline: {path}")
    for name, expected in baseline["pins"].items():
        require(snapshot["pins"].get(name) == expected, f"missing or altered released record: {name}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--replay", action="store_true", help="execute local probes using a prepared runtime")
    mode.add_argument("--all", action="store_true", help="prepare runtime, score frozen Arcade and all probes")
    mode.add_argument("--snapshot", action="store_true", help="print a baseline of reviewed record hashes")
    parser.add_argument("--baseline", type=Path, help="reject deletion or modification of released inputs")
    args = parser.parse_args()
    root = args.root.resolve()
    try:
        report, snapshot = inspect(root)
        if args.baseline:
            check_baseline(args.baseline, snapshot)
        if args.all:
            archived = archive_results(root)
            # The stock bootstrap owns this same lock during npm ci and its scoring run.
            with (root / "arcade/.npm-cache/replay.lock").open("rb") as lock:
                fcntl.flock(lock, fcntl.LOCK_SH)
                report, scored_inputs = inspect(root, replay=True)
                require(scored_inputs == snapshot, "inputs changed during replay")
            report["archive"] = archived
        elif args.replay:
            report, scored_inputs = inspect(root, replay=True)
            require(scored_inputs == snapshot, "inputs changed during replay")
        print(json.dumps(snapshot if args.snapshot else report, indent=2, sort_keys=True))
        if any(p["status"] in ("diverged", "disputed") for claim in report["claims"].values()
               for p in claim["probes"].values()):
            return 1
        if any(claim.get("mutationDetected") is False for claim in report["claims"].values()):
            return 1
    except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
        sys.exit(f"oracle: {error}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
