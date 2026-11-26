"""Replay the qualified experiment. Use score.py for arbitrary candidate packages."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
TRIALS = HERE.parent
sys.path.insert(0, str(TRIALS / "for-of"))
from replay import PINS, VENDOR, install_rules
from hosted import measurements


def read(path):
    return json.loads(path.read_bytes())


def run(*args, code=0):
    completed = subprocess.run(args, cwd=HERE, stdout=subprocess.PIPE)
    if completed.returncode != code:
        raise RuntimeError(f"{args[0]} {args[1]} returned {completed.returncode}, expected {code}")
    return json.loads(completed.stdout)


def equal(actual, expected, label):
    if actual != expected:
        raise ValueError(f"Replay differs from qualified evidence: {label}")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--controller", type=Path, help="authenticate each retained live receipt against its private release journal")
    args = p.parse_args()
    lock = read(HERE / "lock.json")
    for name, digest in lock["files"].items():
        equal(hashlib.sha256((HERE / name).read_bytes()).hexdigest(), digest, name)
    for name, digest in PINS.items():
        equal(hashlib.sha256((VENDOR / name).read_bytes()).hexdigest(), digest, name)
    for inputs, expected in [("positions.json","native.json"), ("cost-position.json","cost-native.json"),
                             ("path-cost-controls.json","path-native.json")]:
        equal(run("bun", "reference/native.mjs", inputs), read(HERE / "reference" / expected), inputs)
    registered = HERE.parents[1] / "suites/arcade/chess/claims/vacated-file-king-safety/v1/probes/rook-pairs/v1"
    equal(run("bun", "reference/writes.mjs"), read(registered / "writes.json"), "registered SDK requests")
    equal(read(registered / "raw/arcade-native.json"), read(HERE / "reference/native.json"), "registered chess truth")
    package = TRIALS / "ordered-guards/vendor/pyric-rules-ordered-guards.tgz"
    equal(hashlib.sha256(package.read_bytes()).hexdigest(), lock["package"], "compiler")
    scores = {}
    for trial in lock["scores"]:
        observed = run(sys.executable, "score.py", "--candidate-package", package, *trial["args"], code=trial["exit"])
        equal(observed, read(HERE / trial["file"]), trial["file"])
        equal(observed["linkedRulesSha256"], lock["files"][trial["bundle"]], "linked release")
        scores[trial["name"]] = observed["linkedRules"]["matches"]
    controls = run(sys.executable, "score-controls.py")
    equal(controls, read(HERE / "score-evidence/controls.json"), "compiler scoring controls")
    releases = {}
    with tempfile.TemporaryDirectory(prefix="king-safety-replay-") as tmp:
        compiler = install_rules(package, Path(tmp) / "compiler") / "@pyric/rules"
        equal(run("bun", "policy/probe-full.mjs", compiler), read(HERE / "policy/full-search.json"), "full chess target")
        equal(run("bun", "policy/rank-path-check.mjs", compiler), read(HERE / "policy/rank-path-score.json"), "rank paths")
        sdk = install_rules(VENDOR / "pyric-rules-0.1.0.tgz", Path(tmp) / "reference") / "@pyric/rules"
        stress = run("bun", "policy/long-ranks.mjs", sdk, TRIALS / "chess/bundle/artifacts/stronger.rules",
                     HERE / "artefacts/v1.rules", HERE / "artefacts/generated.rules")
        equal(stress, read(HERE / "policy/long-ranks.json"), "long legal slides")
        for measurement in lock["releases"]:
            journal = str(args.controller.resolve()) if args.controller else "-"
            report = run("bun", "live/run.mjs", *measurement["args"], "replay",
                         HERE / measurement["bundle"], sdk, journal)
            retained = read(HERE / measurement["file"])
            retained["privateJournalChecked"] = bool(args.controller)
            equal(report, retained, measurement["file"])
            releases[measurement["name"]] = report
        local = run("bun", "../chess/bundle/verify.mjs", "--archived-native", sdk,
                    HERE / "artefacts/generated.rules", "--vacated-file")
        prior = read(TRIALS / "chess/bundle/local-results.json")
        expected = prior["verdicts"]
        equal(expected["pinned-slider"][2], "ALLOW", "former pinned-slider verdict")
        expected["pinned-slider"][2] = "DENY"
        equal(local["verdicts"], expected, "600 complete application verdicts")
        equal(local["peak"], lock["localPeaks"], "sampled local costs")
    qualified = measurements(HERE, lock["files"]["artefacts/generated.rules"])
    equal(len(qualified["captures"]), 1, "qualified evidence lookup")
    equal(len(qualified["captures"][0]["decisions"]), 10, "qualified production cases")
    equal(measurements(HERE, lock["files"]["artefacts/before-board.rules"])["status"], "unmeasured",
          "unmeasured mutant has no hosted claim")
    print(json.dumps({"passed":True, "package":lock["package"], "linkedMatches":scores,
                      "localCases":local["cases"], "liveMeasurements":releases}, indent=2))


if __name__ == "__main__":
    main()
