"""Score a submitted Sokoban compiler against the public Firebase writes and sealed native cases."""

import argparse
import base64
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
TRIAL = HERE.relative_to(ROOT).as_posix()
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "core"))
import oracle
from candidate import MAX_PACKAGE
from compiler_trial import run_stage, stock_answers

COMMITMENT = "4d5c0cdc493980046103b1e6c15fadd1a2e748259e7a1bed6cb1963de4685ebf"
REFERENCE = "67087040f9e1206c54660563a27329d4b5db22102229af8f11b8ccb68ea87743"
CLAIM = "arcade/sokoban/push-tiebreak/v1"
PROBE = "equal-moves/v1"
PROBE_PATH = "suites/arcade/sokoban/claims/push-tiebreak/v1/probes/equal-moves/v1"
EMITTER_FILES = {TRIAL + "/emit.mjs", TRIAL + "/best-score.policy"}
REFEREE_FILES = {*EMITTER_FILES, TRIAL + "/generate.mjs", TRIAL + "/public-verdicts.mjs",
                 TRIAL + "/tictactoe.stock.rules", TRIAL + "/sealed/score.mjs", TRIAL + "/sealed/cases.json",
                 "adapters/arcade-sdk/v1/fixture.mjs", PROBE_PATH + "/fixture.json"}


def held_out_labels():
    directory = HERE / "sealed"
    sums = oracle.safe_file(directory, "SHA256SUMS").read_bytes()
    oracle.require(oracle.sha(sums) == COMMITMENT, "sealed manifest differs from the pre-repair commitment")
    for line in sums.decode().splitlines():
        digest, name = line.split("  ")
        oracle.require(oracle.sha(oracle.safe_file(directory, name).read_bytes()) == digest,
                       f"changed held-out file: {name}")
    return oracle.load(directory / "cases.json")["cases"]


def public_labels(controller):
    answers, receipts = stock_answers(ROOT, controller, CLAIM, PROBE, PROBE_PATH)
    oracle.exact_cases(answers, ["pushes-9", "pushes-10"], PROBE)
    return answers, receipts


def task(package, files, runner, args):
    name = TRIAL + "/" + runner
    return run_stage(ROOT, package, name, args, files, engine="node")


def scored_rows(expected, values, error=None):
    rows = []
    for case, answer in expected.items():
        value = values.get(case, {})
        actual = value.get("decision")
        reason = error or value.get("error")
        if reason or actual not in ("ALLOW", "DENY"):
            rows.append({"case": case, "expected": answer, "outcome": "unsupported",
                         "error": reason or "missing absolute verdict"})
        else:
            outcome = "pass" if actual == answer else "falseAllow" if actual == "ALLOW" else "falseDenial"
            rows.append({"case": case, "expected": answer, "decision": actual, "outcome": outcome})
    return {"total": len(rows), "passes": sum(r["outcome"] == "pass" for r in rows),
            "falseAllows": [r["case"] for r in rows if r["outcome"] == "falseAllow"],
            "falseDenials": [r["case"] for r in rows if r["outcome"] == "falseDenial"],
            "unsupported": [r["case"] for r in rows if r["outcome"] == "unsupported"], "cases": rows}


def score(args):
    public, receipts = public_labels(args.trusted_captures.resolve())
    hidden_cases = held_out_labels()
    hidden = {row["id"]: row["expected"] for row in hidden_cases}
    reference = (ROOT / "arcade/vendor/pyric-rules-0.1.0.tgz").read_bytes()
    oracle.require(oracle.sha(reference) == REFERENCE, "pinned reference package changed")
    with args.candidate_package.open("rb") as stream:
        candidate = stream.read(MAX_PACKAGE + 1)
    oracle.require(len(candidate) <= MAX_PACKAGE, "candidate exceeds packed package limit")
    report = {"candidateSha256": oracle.sha(candidate), "referenceSha256": REFERENCE,
              "policySha256": oracle.sha((HERE / "best-score.policy").read_bytes()),
              "publicEvidenceSha256": receipts, "heldOutCommitmentSha256": COMMITMENT}
    compiled = task(candidate, EMITTER_FILES, "emit.mjs", ["/oracle/arcade/runtime/node_modules/@pyric/rules"])
    module = compiled.get("output")
    error = compiled.get("error")
    evaluated = {}
    if isinstance(module, dict) and isinstance(module.get("module"), str):
        raw = module["module"].encode()
        report["emittedModuleSha256"] = oracle.sha(raw)
        encoded = base64.b64encode(raw).decode("ascii")
        # Separate argv chunks carry text into the private reference namespace.
        # There the referee writes the module to a file for the pinned bundler.
        chunks = [encoded[i:i+32768] for i in range(0, len(encoded), 32768)]
        result = task(reference, REFEREE_FILES, "public-verdicts.mjs", chunks)
        error = result.get("error")
        evaluated = result.get("output", {})
    else:
        error = error or "compiler did not return an emitted module"
    if evaluated:
        bundle = base64.b64decode(evaluated["bundle"], validate=True)
        report["bundleSha256"] = oracle.sha(bundle)
        if args.compare_rules:
            known = args.compare_rules.read_bytes()
            report["knownRules"] = {"sha256": oracle.sha(known), "bytesEqual": bundle == known}
        for case, expected in public.items():
            oracle.require(evaluated["publicStock"][case].get("decision") == expected,
                           f"fixed public stock evaluator disagrees with admitted Firebase evidence: {case}")
    elif not error:
        raise ValueError("fixed referee returned no results")
    report["public"] = scored_rows(public, evaluated.get("generated", {}), error)
    sealed = evaluated.get("heldOut", {})
    hidden_values = {}
    if "generated" in sealed:
        oracle.require(sealed["stock"]["passes"] == len(hidden) and
                       sealed["generated"]["sha256"] == report["bundleSha256"],
                       "sealed scorer used a different bundle or stock disagreed with the sealed cases")
        hidden_values = {row["id"]: row for row in sealed["generated"]["results"]}
        oracle.exact_cases(hidden_values, list(hidden), "sealed score")
    report["heldOut"] = scored_rows(hidden, hidden_values, error or sealed.get("error"))
    for result, source in zip(report["heldOut"]["cases"], hidden_cases, strict=True):
        result["category"] = source["category"]
    # Recheck both authorities after execution, including the independent archive.
    oracle.require(public_labels(args.trusted_captures.resolve()) == (public, receipts)
                   and held_out_labels() == hidden_cases, "evidence changed during scoring")
    report["passed"] = (all(report[group]["passes"] == report[group]["total"] for group in ("public", "heldOut"))
                        and report.get("knownRules", {}).get("bytesEqual", True))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate-package", type=Path, required=True)
    parser.add_argument("--trusted-captures", type=Path, required=True)
    parser.add_argument("--compare-rules", type=Path, help="also require exact equality to these complete rules bytes")
    try:
        report = score(parser.parse_args())
    except (OSError, ValueError, TypeError, KeyError, IndexError) as error:
        print(json.dumps({"passed": False, "error": str(error)}))
        return 1
    print(json.dumps(report, indent=2))
    return int(not report["passed"])


if __name__ == "__main__":
    sys.exit(main())
