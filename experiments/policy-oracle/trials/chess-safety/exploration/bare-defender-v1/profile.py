"""Summarize each result separately for bare defenders and nonbare one-reply controls."""
import argparse
from collections import Counter
import json
from pathlib import Path


def summarize(report):
    domains = {}
    for group, item in report["groups"].items():
        name = "nonbare" if "/nonbare/" in group else "bare"
        bucket = domains.setdefault(name, {"cases": 0, "outcomes": Counter(), "peakExpressions": 0, "examples": {}})
        bucket["cases"] += item["cases"]
        bucket["outcomes"].update(item["outcomes"])
        bucket["peakExpressions"] = max(bucket["peakExpressions"], item["peakExpressions"])
        for outcome in item["outcomes"]:
            if outcome == "match":
                continue
            raw = report["divergences"][group + "/" + outcome]
            prior = bucket["examples"].get(outcome)
            current = {"group": group, "case": raw["first"]["case"], "result": raw["first"]["result"]}
            if prior is None or occupied(current["case"]) < occupied(prior["case"]):
                bucket["examples"][outcome] = current
    return {k: report[k] for k in ("authority", "rulesSha256", "corpusSha256", "caseCount", "scoreSha256")} | {"domains": domains}


def occupied(case):
    return sum(c.isalpha() for c in case["fen"].split()[0])


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("scored", type=Path, help="JSON output from v1/score.mjs --bare-defender")
    args = p.parse_args()
    print(json.dumps(summarize(json.loads(args.scored.read_bytes())), indent=2))
