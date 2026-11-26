"""Resolve the chess obligations against a pinned complete ruleset and standalone module lock."""
import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROFILES = ("stock", "compatibility", "stronger", "referee")
EXPORTS = {"board": ["legalMoves", "apply", "inCheck", "outcome"], "match": ["admit", "metadata"]}
HOST_TARGETS = {"firestore-rules", "referee-auth", "referee-persistence"}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require_modules(paths, lock_path):
    locks = json.loads(lock_path.read_bytes())
    if not isinstance(locks, dict) or not set(EXPORTS).issubset(locks):
        raise ValueError("referee needs a release lock with board and match digests")
    for role, path in paths.items():
        expected = locks[role]
        if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
            raise ValueError(f"invalid {role} release digest")
        if not path.is_file() or digest(path) != expected:
            raise ValueError(f"absent or changed {role} enforcing module")
    # Only load bytes which matched the operator's independent release lock.
    probe = """
        import {pathToFileURL} from 'node:url';
        for (const [file, role, names] of JSON.parse(process.argv[1])) {
          const policy = await import(pathToFileURL(file));
          for (const name of names) {
            if (typeof policy[name] !== 'function') throw Error('Missing ' + role + '.' + name);
          }
        }
    """
    bindings = [[str(path.resolve()), role, EXPORTS[role]] for role, path in paths.items()]
    subprocess.run(["node", "--input-type=module", "-e", probe, json.dumps(bindings)], check=True, timeout=15)
    return {role: locks[role] for role in EXPORTS}


def check(profile, bundle, board, match, lock, *, require_complete=False):
    manifests = json.loads((HERE.parent / "artifacts/manifest.json").read_bytes())
    pinned = manifests["artifacts"][profile + ".rules"]["sha256"]
    if digest(bundle) != pinned:
        raise ValueError(f"linked {profile} ruleset differs from its release digest")
    charter = json.loads((HERE / "obligations.json").read_bytes())
    targets = {}
    for group in charter["groups"]:
        for requirement in group["requirements"]:
            if requirement in targets:
                raise ValueError("duplicate obligation " + requirement)
            targets[requirement] = group[profile]
    if profile == "referee":
        targets.update(charter["refereeAdmission"])
    bindings = require_modules({"board": board, "match": match}, lock) if profile == "referee" else {}
    available = {"firestore-rules"}
    if profile == "referee":
        available.update(HOST_TARGETS)
        available.update(f"{role}.{name}" for role in EXPORTS for name in EXPORTS[role])
    missing = [name for name, target in targets.items() if target == "residual"]
    unknown = {target for target in targets.values() if target != "residual" and target not in available}
    if unknown:
        raise ValueError("unbound enforcement targets: " + ", ".join(sorted(unknown)))
    if (profile == "referee" or require_complete) and missing:
        raise ValueError("unplaced obligations: " + ", ".join(missing))
    return {"profile": profile, "linkedRulesSha256": pinned, "moduleDigests": bindings,
            "obligations": targets, "residual": missing, "completePlacement": not missing}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile", choices=PROFILES)
    for field in ("bundle", "board", "match", "lock"):
        parser.add_argument(field, type=Path)
    parser.add_argument("--require-complete", action="store_true")
    try:
        print(json.dumps(check(**vars(parser.parse_args())), indent=2))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
