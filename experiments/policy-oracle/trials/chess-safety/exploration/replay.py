"""Score a complete emitted Arcade ruleset against the independent local holdouts."""
import argparse
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
TOOLS = runpy.run_path(str(HERE.parent.parent / "for-of/replay.py"))


def evaluate(*args):
    result = subprocess.run(["bun", *args], cwd=HERE, check=True, stdout=subprocess.PIPE)
    return json.loads(result.stdout)


def run(rules, reference, rebuild, extended_endings=False, bare_defender=False):
    plans = [
        ("v1", "freeze.mjs", "v1/score.mjs", []),
        ("replies-v1", "freeze.mjs", "v1/score.mjs", ["--terminal-replies"]),
        ("rights-v1", "freeze.mjs", "v1/score.mjs", ["--rights"]),
        ("promotions-v1", "freeze.mjs", "v1/score.mjs", ["--promotions"]),
        ("interior-v1", "freeze.mjs", "v1/score.mjs", ["--interior"]),
        ("rights-claims-v1", "freeze.mjs", "rights-claims-v1/score.mjs", []),
    ]
    if (HERE / "self-check-v1/measure.mjs").is_file():
        plans.append(("self-check-v1", "corpus.mjs", "self-check-v1/measure.mjs", []))
    if extended_endings:
        plans.extend([("king-last-v1", "freeze.mjs", "v1/score.mjs", ["--king-last"]),
                      ("successor-claims-v1", "freeze.mjs", "v1/score.mjs", ["--all-claims"])])
    if bare_defender:
        plans.append(("bare-defender-v1", "freeze.mjs", "v1/score.mjs", ["--bare-defender"]))
    reports, totals = {}, Counter()
    digest = sha256(rules.read_bytes()).hexdigest()
    summary = {}
    for cohort, freeze, scorer, options in plans:
        meta = json.loads((HERE / cohort / "freeze.json").read_bytes())
        if rebuild and evaluate(str(Path(cohort) / freeze)) != meta:
            raise ValueError(f"Independent native answers changed for {cohort}")
        report = evaluate(scorer, reference, rules, *options)
        if report["rulesSha256"] != digest:
            raise ValueError(f"Different complete Rules selected for {cohort}")
        source = report.get("corpusSha256", report.get("inputsSha256"))
        if source != meta.get("sha256", meta.get("inputsSha256")):
            raise ValueError(f"Different native answers used for {cohort}")
        counts = Counter(report.get("stats", {}))
        if not counts:
            for group in report["groups"].values():
                counts.update(group["outcomes"])
        expected_count = next(meta[key] for key in ("total", "submissions", "writes", "cases") if key in meta)
        if sum(counts.values()) != expected_count:
            raise ValueError(f"Missing cases in {cohort}")
        totals.update(counts)
        summary[cohort] = {
            "cases": expected_count,
            "outcomes": dict(counts),
            "decisionsSha256": report.get("scoreSha256", report.get("decisionsSha256")),
        }
        reports[cohort] = report
    return {"authority": "independent pinned local full Rules evaluator", "rulesSha256": digest,
            "cases": sum(totals.values()), "allMatch": sum(totals.values()) == totals.get("match", 0),
            "outcomes": dict(totals), "cohorts": summary, "reports": reports}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--rules", type=Path, required=True, help="complete independently linked Arcade Rules")
    p.add_argument("--reference", type=Path, help="installed pinned @pyric/rules package; defaults to a fresh offline install")
    p.add_argument("--rebuild-native", action="store_true", help="rerun native and standalone generation before scoring")
    p.add_argument("--extended-endings", action="store_true", help="include 288 king-last and 762 remaining terminal proposals")
    p.add_argument("--bare-defender", action="store_true", help="include 1,992 arbitrary-material bare-king and near-miss proposals")
    p.add_argument("--report", type=Path, help="write full report with per-cohort first divergences and minimized examples")
    p.add_argument("--json", action="store_true", help="print full report to stdout")
    p.add_argument("--strict", action="store_true", help="also return exit 1 on any nonmatching or unsupported case")
    args = p.parse_args()
    rules = args.rules.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="chess-holdouts-") as directory:
        if args.reference:
            reference = args.reference.resolve(strict=True)
        else:
            for name, expected in TOOLS["PINS"].items():
                if sha256((TOOLS["VENDOR"] / name).read_bytes()).hexdigest() != expected:
                    raise ValueError(f"Reference archive changed: {name}")
            modules = TOOLS["install_rules"](TOOLS["VENDOR"] / "pyric-rules-0.1.0.tgz", Path(directory) / "ref")
            reference = modules / "@pyric/rules"
        data = run(rules, reference, args.rebuild_native, args.extended_endings, args.bare_defender)
    if args.report:
        args.report.write_text(json.dumps(data, indent=2) + "\n")
    output = data if args.json else {k: v for k, v in data.items() if k != "reports"}
    print(json.dumps(output, indent=2))
    return int(args.strict and not data["allMatch"])


if __name__ == "__main__":
    sys.exit(main())
