"""Score an offline @pyric/rules tarball on the frozen king-safety positions."""
import argparse
import base64
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
TRIAL = str(HERE.relative_to(ROOT))
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "core"))
import oracle
from candidate import MAX_PACKAGE
from offline_runtime import side
from compiler_trial import run_stage
from hosted import measurements

NATIVE_SHA = "ebf93cbebf1c8a2d05ae37e04de4fde06e4422924a2263c17afe3b7efe0938d2"
COST_NATIVE_SHA = "dd44a06c4dbc04679d29a9746ed978252d39875c869d292ff093c3d3ab6bb369"
PATH_NATIVE_SHA = "1c660f6e5be7de0c5ec344acd403f8a709b8a3793f6beec5a0d88eca413ae7ce"
REFERENCE_SHA = "67087040f9e1206c54660563a27329d4b5db22102229af8f11b8ccb68ea87743"
MODULES = "/oracle/arcade/runtime/node_modules"
PKG = MODULES + "/@pyric/rules"


def chunks(value):
    raw = base64.b64encode(json.dumps(value, separators=(",", ":")).encode()).decode("ascii")
    return [raw[i:i + 32000] for i in range(0, len(raw), 32000)]


def scored(labels, predictions, stage_error=None, failure="evaluation-error", *, checking_file=False):
    ids = [c["id"] for c in labels]
    if (not isinstance(predictions, list)
            or any(not isinstance(p, dict) for p in predictions)
            or [p.get("id") for p in predictions] != ids):
        predictions = [{} for _ in labels]
        stage_error = stage_error or "runner returned incomplete or reordered cases"
    rows = []
    for case, prediction in zip(labels, predictions, strict=True):
        native = not case["afterCheck"] if checking_file else case["nativeLegal"]
        expected = "ALLOW" if native else "DENY"
        decision = prediction.get("decision")
        row = {"id": case["id"], "native": expected}
        diagnostic = stage_error or prediction.get("error")
        if diagnostic or decision not in ("ALLOW", "DENY"):
            row.update(status=failure, diagnostic=diagnostic or "expected an absolute decision")
            if not checking_file and prediction.get("errorKind") in ("resource-limit", "rule-error") and decision == "DENY":
                row.update(observed=decision, cause=prediction["errorKind"],
                           localExpressions=prediction["localExpressions"])
                if expected == "ALLOW":
                    row["status"] = "false-refusal"
        else:
            row.update(observed=decision, status="match" if decision == expected
                       else "false-allow" if decision == "ALLOW" else "false-refusal")
            if not checking_file and "localExpressions" in prediction:
                row["localExpressions"] = prediction["localExpressions"]
        rows.append(row)
    return {"expectedFrom": "native post-move king safety on these fixtures" if checking_file else "native move legality",
            "matches": sum(row["status"] == "match" for row in rows),
            "firstDivergence": next((row for row in rows if row["status"] != "match"), None), "cases": rows}


def score(package, before, variant):
    with package.open("rb") as stream:
        submitted = stream.read(MAX_PACKAGE + 1)
    oracle.require(len(submitted) <= MAX_PACKAGE, "candidate exceeds the package size limit")
    reference = (ROOT / "arcade/vendor/pyric-rules-0.1.0.tgz").read_bytes()
    oracle.require(oracle.sha(reference) == REFERENCE_SHA, "pinned independent evaluator changed")
    truth = (HERE / "reference/native.json").read_bytes()
    oracle.require(oracle.sha(truth) == NATIVE_SHA, "frozen native evidence changed")
    primary = json.loads(truth)["cases"]
    cost_truth = (HERE / "reference/cost-native.json").read_bytes()
    oracle.require(oracle.sha(cost_truth) == COST_NATIVE_SHA, "frozen cost follow-up changed")
    cost = json.loads(cost_truth)["cases"]
    path_truth = (HERE / "reference/path-native.json").read_bytes()
    oracle.require(oracle.sha(path_truth) == PATH_NATIVE_SHA, "frozen path controls changed")
    labels = primary + cost + json.loads(path_truth)["cases"]
    fixtures = json.loads(subprocess.check_output(["bun", HERE / "score-inputs.mjs"]))
    oracle.require([f["id"] for f in fixtures] == [c["id"] for c in labels], "case order mismatch")
    board = "resource" if before else "data"
    inputs = [{"id": f["id"], "args": [f["request"][board]["board"], f["file"], f["color"]]} for f in fixtures]
    source_path = TRIAL + "/policy/file-safe.policy"
    sources = {"fileSafety":source_path}
    if variant == "v2":
        sources["horizontalPath"] = TRIAL + "/policy/horizontal-path.policy"
    runner = TRIAL + "/score-consumer.mjs"
    tasks = {mode: {"engine": "bun", "runner": "/oracle/" + runner, "args": [mode, PKG, variant, *args]}
             for mode, args in [("emit", []), ("standalone", chunks(inputs))]}
    # Emission receives only the authored policy. Separate invocations get
    # independent pid/mount namespaces. Neither sees the verifier's answers.
    result = side(ROOT, submitted, tasks, reference=False, timeout=60, pinned_paths={runner, TRIAL + "/policy/public-api.mjs", *sources.values()})
    install_error = result.get("installError")
    tasks = result.get("tasks", {})
    standalone, emit = tasks.get("standalone", {}), tasks.get("emit", {})
    standalone_score = scored(labels, standalone.get("output"), install_error or standalone.get("error"),
                              "install-error" if install_error else "standalone-error", checking_file=True)
    emitted = emit.get("output")
    error = install_error or emit.get("error")
    report = {"candidateSha256": oracle.sha(submitted), "referenceSha256": REFERENCE_SHA,
              "nativeSha256": NATIVE_SHA, "costNativeSha256": COST_NATIVE_SHA, "pathNativeSha256": PATH_NATIVE_SHA,
              "variant": variant,
              "policies": {name:oracle.sha((ROOT / path).read_bytes()) for name,path in sources.items()},
              "binding": "before-board" if before else "after-board", "standalone": standalone_score}
    valid = (isinstance(emitted, dict) and set(emitted) == set(sources)
             and all(isinstance(value, str) and value.strip() for value in emitted.values()))
    if valid:
        try:
            if any(len(value.encode()) > 256 * 1024 for value in emitted.values()):
                error = "emitted module exceeds Rules size limit"
        except UnicodeEncodeError:
            error = "emitted module contains invalid UTF-8 text"
    if not valid or error:
        status = "install-error" if install_error else "cannot-compile"
        diagnostic = error or "compiler did not return the required Rules modules"
        report["compilation"] = {"status": status, "diagnostic": diagnostic}
        report["linkedRules"] = scored(labels, None, diagnostic, status)
    else:
        report["compilation"] = {"status":"emitted", "modules":{
            name:oracle.sha(value.encode()) for name,value in emitted.items()}}
        verifier = TRIAL + "/score-referee.mjs"
        args = [MODULES, *chunks({"modules": emitted, "beforeBoard":before, "variant":variant,
                                  "requests":[f["request"] for f in fixtures]})]
        files = {verifier, TRIAL + "/policy", "trials/chess/bundle/artifacts",
                 "trials/sokoban-repair/v1/tictactoe.stock.rules"}
        verdict = run_stage(ROOT, reference, verifier, args, files, engine="bun")
        output = verdict.get("output", {})
        if "rulesSha256" in output:
            report["linkedRulesSha256"] = output["rulesSha256"]
        report["linkedRules"] = scored(labels, output.get("rows"), verdict.get("error"),
                                      "link-error" if verdict.get("error") else "evaluation-error")
    planes = ("standalone", "linkedRules")
    report["cohorts"] = {}
    end = len(primary) + len(cost)
    for name, rows in [("primary", slice(0,len(primary))), ("costFollowUp",slice(len(primary),end)),
                       ("pathControls",slice(end,None))]:
        cases = labels[rows]
        report["cohorts"][name] = {"cases":[c["id"] for c in cases],
            **{plane:sum(r["status"]=="match" for r in report[plane]["cases"][rows]) for plane in planes}}
    report["passed"] = all(report[k]["matches"] == len(labels) for k in planes)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate-package", type=Path, required=True)
    parser.add_argument("--before-board", action="store_true", help="exercise the stale-board binding mutation")
    parser.add_argument("--variant", choices=("v1","v2"), default="v2", help="authored lowering to score")
    parser.add_argument("--with-live", action="store_true", help="look up retained Firestore verdicts for identical linked Rules bytes")
    args = parser.parse_args()
    try:
        result = score(args.candidate_package, args.before_board, args.variant)
        if args.with_live:
            result["hosted"] = measurements(HERE, result.get("linkedRulesSha256"))
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        result = {"passed": False, "infrastructureError": str(error)}
    print(json.dumps(result, indent=2))
    return int(not result["passed"])


if __name__ == "__main__":
    sys.exit(main())
