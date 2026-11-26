"""Qualify the packed ordered-guard compiler from an offline install."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
PREVIOUS = HERE.parent / "for-of"
sys.path.insert(0, str(PREVIOUS))
from replay import PINS, VENDOR, build, digest, install_rules


def read(path):
    return json.loads(path.read_bytes())


def run(*command):
    return json.loads(subprocess.check_output(command, cwd=HERE))


def compare(value, expected, label):
    if value != expected:
        raise ValueError(f"Replay disagrees with {label}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--controller", type=Path, help="reauthenticate private Firestore journals")
    parser.add_argument("--corpus", type=Path, help="regenerate and score the verifier-held author positions")
    parser.add_argument("--baselines", type=Path, metavar="ARCADE", help="also exercise the earlier package and game suites")
    args = parser.parse_args()
    if args.baselines and not args.controller:
        parser.error("--baselines needs --controller for the archived game evidence")
    lock = read(HERE / "lock.json")
    prior_lock = read(PREVIOUS / "lock.json")
    package = HERE / "vendor/pyric-rules-ordered-guards.tgz"
    incumbent = PREVIOUS / "vendor/pyric-rules-loops.tgz"
    compare(digest(package), lock["package"], "qualified package")
    compare(digest(incumbent), prior_lock["package"], "incumbent package")
    for name, sha in PINS.items():
        compare(digest(VENDOR / name), sha, name)
    for name, sha in lock["evidence"].items():
        compare(digest(HERE / name), sha, name)
    compare(run("bun", "reference/native.mjs"), read(HERE / "reference/native.json"), "native engine")
    sealed = read(HERE / "reference/sealed-score.json")
    with tempfile.TemporaryDirectory(prefix="pyric-ordered-guards-") as temp:
        scratch = Path(temp)
        baseline = install_rules(incumbent, scratch / "incumbent") / "@pyric/rules"
        compare(run("bun", "score.mjs", baseline, "--baseline"), read(HERE / "reference/baseline-score.json"), "incumbent")
        # The public build from the first trial also proves its earlier chess,
        # error-order, accumulator, and Floor boost outputs still reproduce.
        prior_output = scratch / "prior-output"
        build(package, scratch / "install", prior_output)
        for name, sha in prior_lock["generated"].items():
            compare(digest(prior_output / name), sha, "previous trial " + name)
        modules = scratch / "install/node_modules"
        candidate = modules / "@pyric/rules"
        public = run("bun", "score.mjs", candidate)
        compare(public, read(HERE / "reference/standalone-score.json"), "public and mutation scores")
        placement = run("bun", "placement.mjs", candidate)
        compare(placement, read(HERE / "artefacts/placement.json"), "three-guard compiler boundary")
        if args.corpus:
            compare(run("bun", "sealed.mjs", candidate, args.corpus.resolve()), sealed, "regenerated sealed scores")
        out = scratch / "new-output"
        out.mkdir()
        linked = run("bun", "link.mjs", candidate, modules / "arcade-bundler/dist/rules/modules/resolver.js", out)
        compare(linked, lock["linked"], "complete application linkage")
        for name, sha in lock["generated"].items():
            compare(digest(out / name), sha, name)
            compare(digest(HERE / "artefacts" / name), sha, "retained " + name)
        reference = install_rules(VENDOR / "pyric-rules-0.1.0.tgz", scratch / "reference") / "@pyric/rules"
        local = run("bun", "../chess/bundle/verify.mjs", "--archived-native", reference, out / "generated.rules")
        control = read(HERE.parent / "chess/bundle/local-results.json")
        compare(local["verdicts"], control["verdicts"], "all 150 full-application chess cases")
        compare(local["peak"], lock["localPeaks"], "local expression counts")
        journal = args.controller.resolve() if args.controller else "-"
        hosted = run("bun", "live/replay.mjs", out / "generated.rules", reference, journal, out / "ordered-errors.rules")
        retained = read(HERE / "artefacts/hosted-score.json")
        retained["privateJournalChecked"] = bool(args.controller)
        compare(hosted, retained, "production scores")
        budget = run("bun", "live/budget/run.mjs", "replay", out / "generated.rules", reference, journal)
        saved_budget = read(HERE / "artefacts/hosted-budget.json")
        saved_budget["privateJournalChecked"] = bool(args.controller)
        compare(budget, saved_budget, "production verdicts for the highest sampled local cost")
        if args.baselines:
            import baselines
            broad = baselines.verify(package, journal, args.baselines.resolve(), reference, out)
            compare(broad, read(HERE / "artefacts/regressions.json"), "earlier package and game suites")
        print(json.dumps({
            "compiler": lock["compilerSource"],
            "chess": {key: len(public[key]) for key in ["original", "rewrite"]},
            "language": len(public["language"]), "tally": len(public["tally"]),
            "mutations": public["mutations"], "checkedBound": public["checkedBound"],
            "threeGuards": {"values": placement["values"], "firstRefusal": placement["firstRefusal"]},
            "authoring": {"authority": "recomputed" if args.corpus else "retained scores",
                          "matches": {name: row["matches"] for name, row in sealed["results"].items()}},
            "local": {"cases": local["cases"], "profiles": local["profiles"], "peaks": local["peak"]},
            "live": hosted, "budgetFollowUp": budget,
            "broaderBaselines": "recomputed" if args.baselines else "retained scores",
        }, indent=2))


if __name__ == "__main__":
    main()
