"""Discover versioned policy claims and replay reviewed probes offline."""

import argparse
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

DEFAULT_ROOT = Path(__file__).resolve().parents[1]
SLUG = r"[a-z0-9]+(?:-[a-z0-9]+)*"
VERSION = r"v[1-9][0-9]*"
WITNESSES = {
    "native-model": {"native-trace"},
    "firestore-sdk": {"imported-production-verdict", "authenticated-write-readback"},
    "rtdb-production": {"imported-production-verdict", "authenticated-write-readback"},
    "storage-production": {"imported-production-verdict", "authenticated-write-readback"},
}
ARCADE_VERIFIER = "@oracle/adapters/arcade-sdk/v1/verify.mjs"
PIXELWOOD = "suites/ai-jrpg/pixelwood/claims/"
CLIP_PROBE = "suites/ai-jrpg/storage/claims/clip-access/v1/probes/clip-objects/v1"
CAMPAIGN_VERIFIER = "@oracle/adapters/ai-jrpg-campaign/v1/verify.mjs"
CAMPAIGN_PROBES = {
    "pixelwood": {"app": ("world-admin-lifecycle", "invite-contention", "profile-lifecycle", "combat-profile-create",
                          "trade-ledger", "chest-claim", "house-claim", "event-ledger"), "deploy": ("combat-profile-create",)},
    "genkit": {"genkit": ("conversation-membership",)},
    "blockingfun": {"blocking": ("session-access", "lobby-transitions")},
}
AIR_HOCKEY_PROBE = "suites/arcade/air-hockey/claims/frame-plausibility/v1/probes/host-writes/v1"
SDK_VERIFIERS = {
    AIR_HOCKEY_PROBE: "@oracle/adapters/air-hockey/v1/verify.mjs",
    "suites/satisfy/tally-slate/claims/compiled-two-strike-validation/v1/probes/turns/v1": "@oracle/adapters/tally-strikes/v1/verify.mjs",
    "suites/satisfy/tally-slate/claims/compiled-two-action-fold/v1/probes/turns/v1": "@oracle/adapters/tally-fold/v1/verify.mjs",
    "suites/ai-jrpg/genkit/claims/conversation-queries/v1/probes/genkit/v1": "@oracle/adapters/conversation-queries/v1/verify.mjs",
    **{f"suites/ai-jrpg/{suite}/claims/{family}/v1/probes/{variant}/v1": CAMPAIGN_VERIFIER
       for suite, variants in CAMPAIGN_PROBES.items() for variant, families in variants.items() for family in families},
    CLIP_PROBE: "@oracle/adapters/ai-jrpg-clips/v1/verify.mjs",
    PIXELWOOD + "hearthfest-atomic-award/v1/probes/contribution-and-award/v1": "@oracle/adapters/hearthfest-atomic/v1/verify.mjs",
    PIXELWOOD + "hearthfest-compiled-award/v1/probes/award-lifecycle/v1": "@oracle/adapters/hearthfest-compiled/v1/verify.mjs",
    PIXELWOOD + "hearthfest-award-write/v1/probes/award-lifecycle/v1": "@oracle/adapters/hearthfest-award/v1/verify.mjs",
    PIXELWOOD + "chat-send/v1/probes/profile-and-rate/v1": "@oracle/adapters/pixelwood-chat/v1/verify.mjs",
    PIXELWOOD + "signup-get-after/v1/probes/paired-signup/v1": "@oracle/adapters/signup-get-after/v1/verify.mjs",
    PIXELWOOD + "atomic-signup/v1/probes/commit-order/v1": "@oracle/adapters/atomic-signup/v1/verify.mjs",
    PIXELWOOD + "world-role/v1/probes/app-and-mirror/v1": "@oracle/adapters/world-role/v1/verify.mjs",
    PIXELWOOD + "invite-profile/v1/probes/signup/v1": "@oracle/adapters/invite-profile/v1/verify.mjs",
}
ARCHIVE_IDS = {f"arcade/tictactoe/relative-plus-{n}/v1" for n in ("one", "two")}


@dataclass(frozen=True)
class EvidenceSources:
    released: dict
    controller: Path | None
    upstream_pyric: Path | None


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
    require(isinstance(recipe["replay"], str) and not recipe["replay"].startswith("@oracle/"),
            f"expected a pinned local replay: {probe}")
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


def check_import(raw, document, recipe, authority, evidence):
    service = {"firestore-sdk":"firestore-rules", "rtdb-production":"rtdb-rules",
               "storage-production":"storage-rules"}[authority]
    source = recipe["source"]
    require(source["repo"] == "davideast/pyric" and
            source["path"] == f"packages/conformance/observations/{service}/{document.get('name')}.json",
            "imported production receipt does not identify its upstream observation")
    require(all(isinstance(document.get(key), str) and document[key]
                for key in ("projectId", "fbSdkVersion", "observedAt")), "incomplete imported production receipt")
    blob = hashlib.sha1(f"blob {len(raw)}\0".encode() + raw).hexdigest()
    require(evidence.get("sourceBlob") == blob, "imported receipt differs from its reviewed upstream blob")
    if authority == "storage-production":
        require(isinstance(document.get("bucket"), str) and document["bucket"]
                and document.get("storedObjects"), "missing real-object Storage capture metadata")
    prefix = "/diagnostics/productionDatabase/" if authority == "firestore-sdk" else "/behavior/"
    require(all(ptr.startswith(prefix) for ptr in evidence["pointers"].values()),
            "imported verdict must select the production data plane")


def observed_values(root, path, authority, witness, input_digest, recipe, sources):
    cases = recipe["cases"]
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
    if witness == "imported-production-verdict":
        require(isinstance(document, dict), f"invalid imported receipt: {raw_path}")
        check_import(raw, document, recipe, authority, evidence)
    if witness == "authenticated-write-readback":
        verifier = safe_file(root, recipe["verifyEvidence"].removeprefix("@oracle/"))
        decoded = run_json(["bun", str(verifier), str(path.parent.parent), str(raw_path)], path.parent.parent, root)
        require(canonical(decoded) == canonical(results), f"verified readbacks disagree: {path}")
    for case in cases:
        literal = pointer_value(document, evidence["pointers"][case])
        require(canonical(literal) == canonical(results[case]), f"raw evidence disagrees: {path} {case}")
    # Capture programs and test doubles can produce the same well-formed JSON. Only a
    # separately retained controller receipt can admit a new SDK write as evidence.
    admitted = True
    if witness == "imported-production-verdict":
        admitted = sources.released.get(str(path.relative_to(root))) == sha(path.read_bytes())
        if sources.upstream_pyric is not None:
            source = recipe["source"]
            object_name = source["revision"] + ":" + source["path"]
            upstream = subprocess.run(["git", "-C", sources.upstream_pyric, "rev-parse", "--verify", object_name],
                                      text=True, capture_output=True)
            require(upstream.returncode == 0 and upstream.stdout.strip() == evidence["sourceBlob"],
                    f"upstream commit does not contain the supplied receipt: {object_name}")
            admitted = True
    if witness == "authenticated-write-readback":
        retained = sources.controller / (evidence["sha256"] + ".json") if sources.controller else None
        admitted = retained is not None and retained.exists()
        if admitted:
            require(not retained.is_symlink() and retained.read_bytes() == raw,
                    f"capture controller receipt does not match: {retained}")
    return results, admitted


def run_json(command, directory, root):
    timeout = int(os.environ.get("ORACLE_REPLAY_TIMEOUT_SECONDS", "300"))
    require(timeout > 0, "replay timeout must be positive")
    try:
        process = subprocess.run(command, cwd=directory, capture_output=True, text=True, timeout=timeout,
                                 env={**os.environ, "ORACLE_ROOT": str(root)})
    except subprocess.TimeoutExpired as error:
        raise ValueError(f"replay infrastructure timed out in {directory}; check machine load") from error
    require(process.returncode == 0, f"replay failed: {directory}\n{process.stderr or process.stdout}")
    return parse(process.stdout)


def inspect_probe(root, version, claim_file, authority, witness, replay, pins, sources):
    recipe_file = version / "recipe.json"
    recipe = load(recipe_file)
    source = recipe["source"]
    require(isinstance(source, dict) and isinstance(source["repo"], str) and source["repo"]
            and isinstance(source["path"], str) and source["path"]
            and re.fullmatch(r"[a-f0-9]{40}", source["revision"]), f"invalid source: {recipe_file}")
    cases = recipe["cases"]
    require(isinstance(cases, list) and cases and all(isinstance(c, str) and c for c in cases)
            and len(set(cases)) == len(cases), f"duplicate or invalid case IDs: {recipe_file}")
    query_cases = recipe.get("queryCases", [])
    require(isinstance(query_cases, list) and all(case in cases for case in query_cases)
            and len(query_cases) == len(set(query_cases)), f"invalid query case IDs: {recipe_file}")
    runner = pin_files(root, version, recipe)
    if witness == "authenticated-write-readback":
        probe_id = version.relative_to(root).as_posix()
        require((authority == "storage-production") == (probe_id == CLIP_PROBE) and
                (authority == "rtdb-production") == (probe_id == AIR_HOCKEY_PROBE),
                f"incorrect service for SDK receipt: {probe_id}")
        verifier = SDK_VERIFIERS.get(probe_id, ARCADE_VERIFIER)
        require(recipe.get("verifyEvidence") == verifier and verifier in recipe["pins"],
                f"missing reviewed SDK write/readback verifier: {recipe_file}")
    input_digest = sha(claim_file.read_bytes() + b"\0" + recipe_file.read_bytes())
    pins[str(recipe_file.relative_to(root))] = sha(recipe_file.read_bytes())
    observations = {}
    awaiting = []
    for receipt in records(version / "observations"):
        results, admitted = observed_values(root, receipt, authority, witness, input_digest, recipe, sources)
        if admitted:
            observations[receipt.stem] = results
        else:
            awaiting.append(receipt.stem)
        pins[str(receipt.relative_to(root))] = sha(receipt.read_bytes())
    distinct = {canonical(value) for value in observations.values()}
    report = {"cases": cases, "observations": list(observations), "status": "pending"}
    if awaiting:
        report["awaitingControllerReceipt" if witness == "authenticated-write-readback" else "awaitingUpstreamReceipt"] = awaiting
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
            report["mutationDetected"] = bool(report["mutantMisses"])
            report["status"] = "diverged" if report["candidateMisses"] else "conforms"
    return report


def inspect(root, sources, replay=False):
    claims = {}
    pins = {}
    for claim_id, path in claim_dirs(root):
        require(claim_id not in ARCHIVE_IDS, f"duplicate archived claim ID: {claim_id}")
        claim_file = path / "claim.json"
        spec = load(claim_file)
        authority = spec["authority"]
        witness = spec.get("witness", "native-trace")
        require(authority in WITNESSES and witness in WITNESSES[authority], f"ineligible witness: {claim_id}")
        require(isinstance(spec["description"], str) and spec["description"],
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
                    root, version, claim_file, authority, witness, replay, pins, sources)
        require(set(obligations.values()) <= probes.keys(), f"missing required probe: {claim_id}")
        states = {probes[key]["status"] for key in obligations.values()}
        status = next(state for state in ("disputed", "diverged", "pending", "evidenced", "conforms")
                      if state in states)
        claims[claim_id] = {"authority": authority, "witness": witness, "status": status, "obligations": obligations,
                            "probes": probes}
        scored = [probes[key]["mutationDetected"] for key in obligations.values()
                  if "mutationDetected" in probes[key]]
        if scored:
            claims[claim_id]["mutationDetected"] = all(scored)
    require(claims, "no claims discovered")
    return {"claims": claims}, {"version": 1, "pins": pins}


def archive_results(root):
    archive = root / "arcade"
    result = run_json([str(archive / "replay"), "--json"], archive, root)
    require(len(result["rows"]) == result["correctDecisions"] == 21 and
            result["evidenceCoverage"] == result["conformance"] == [2, 2] and
            result["mutationFalseAllows"] == result["mutationFalseDenials"] == 4,
            "frozen Arcade baseline changed")
    ids = [f"arcade/tictactoe/{row['id']}/v1" for row in result["claims"]]
    require(len(ids) == 2 and set(ids) == ARCHIVE_IDS, "unexpected archived claim IDs")
    return {"claims": ids,
            "decisions": result["correctDecisions"], "falseAllows": result["mutationFalseAllows"],
            "falseDenials": result["mutationFalseDenials"]}


def released_pins(root, explicit):
    if explicit:
        paths = [explicit]
    elif root == DEFAULT_ROOT:
        paths = list(records(root / "baselines"))
        require(root / "baselines/pilot-v1.json" in paths, "missing pilot baseline")
    else:
        paths = []
    released = {}
    for path in paths:
        baseline = load(path)
        require(baseline["version"] == 1 and isinstance(baseline["pins"], dict) and baseline["pins"],
                f"invalid baseline: {path}")
        for name, expected in baseline["pins"].items():
            require(released.setdefault(name, expected) == expected, f"incompatible baselines: {name}")
    return released


def checkout_boundary(root):
    probe = subprocess.run(["git", "-C", root, "rev-parse", "--show-toplevel"],
                           text=True, capture_output=True)
    if probe.returncode == 0:
        return Path(probe.stdout.strip()).resolve()
    # git archive exports preserve the experiments/policy-oracle layout without .git.
    if root.name == "policy-oracle" and root.parent.name == "experiments":
        return root.parent.parent
    return root


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--replay", action="store_true", help="execute local probes using a prepared runtime")
    mode.add_argument("--all", action="store_true", help="prepare runtime, score frozen Arcade and all probes")
    mode.add_argument("--candidate-package", type=Path, metavar="RULES.tgz",
                      help="score a packed @pyric/rules against the fixed offline evidence")
    mode.add_argument("--snapshot", action="store_true", help="print a baseline of reviewed record hashes")
    parser.add_argument("--baseline", type=Path, help="reject deletion or modification of released inputs")
    parser.add_argument("--trusted-captures", type=Path,
                        help="independent capture-controller directory of <receipt-sha256>.json files")
    parser.add_argument("--upstream-pyric", type=Path,
                        help="trusted upstream Git checkout to verify imported receipts before a new release")
    args = parser.parse_args()
    root = args.root.resolve()
    try:
        trusted = args.trusted_captures.resolve() if args.trusted_captures else None
        if trusted:
            require(trusted.is_dir() and not trusted.is_relative_to(checkout_boundary(root)),
                    "trusted controller archive must be a separate existing directory outside the candidate worktree")
        sources = EvidenceSources(released_pins(root, args.baseline), trusted, args.upstream_pyric)
        report, snapshot = inspect(root, sources)
        for name, expected in sources.released.items():
            require(snapshot["pins"].get(name) == expected, f"missing or altered released record: {name}")
        if args.candidate_package:
            sys.dont_write_bytecode = True
            from candidate import frozen_arcade, score_package
            comparison = score_package(root, report, snapshot, args.candidate_package)
            after, after_snapshot = inspect(root, sources)
            require(after == report and after_snapshot == snapshot, "inputs changed during candidate scoring")
            frozen_arcade(root)  # Revalidate the separately frozen receipts and their ledger.
            print(json.dumps(comparison, indent=2, sort_keys=True))
            return int(any(row["outcome"] not in ("match", "pending") for row in comparison["cases"]))
        if args.snapshot:
            require(not any("awaitingUpstreamReceipt" in probe for c in report["claims"].values()
                            for probe in c["probes"].values()),
                    "verify new imported receipts against --upstream-pyric before freezing")
        if args.all:
            archived = archive_results(root)
            # The stock bootstrap owns this same lock during npm ci and its scoring run.
            with (root / "arcade/.npm-cache/replay.lock").open("rb") as lock:
                fcntl.flock(lock, fcntl.LOCK_SH)
                report, scored_inputs = inspect(root, sources, replay=True)
                require(scored_inputs == snapshot, "inputs changed during replay")
            report["archive"] = archived
        elif args.replay:
            report, scored_inputs = inspect(root, sources, replay=True)
            require(scored_inputs == snapshot, "inputs changed during replay")
        if args.all or args.replay:
            _, after = inspect(root, sources)
            require(after == snapshot, "inputs changed during replay")
        print(json.dumps(snapshot if args.snapshot else report, indent=2, sort_keys=True))
        if any(p["status"] in ("diverged", "disputed") for claim in report["claims"].values()
               for p in claim["probes"].values()):
            return 1
        if any(claim["probes"][key].get("mutationDetected") is False for claim in report["claims"].values()
               for key in claim["obligations"].values()):
            return 1
    except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
        sys.exit(f"oracle: {error}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
