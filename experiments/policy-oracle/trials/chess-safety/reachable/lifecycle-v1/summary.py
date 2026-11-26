"""Select the independently reproducible trace outcomes from a full lifecycle replay."""
import argparse
import json
from pathlib import Path


def compact(report):
    selected = {k:v for k,v in report.items() if k not in ("byTrace","certifiedForks")}
    selected["tracesByName"] = {
        name:{k:r[k] for k in ("source","acceptedPrefix","fullPrefix","lastAcceptedHead","expectedFinalHead","decisionsSha256")}
             | ({"firstRefusal":r["firstRefusal"]} if not r["fullPrefix"] else {})
        for name,r in report["byTrace"].items()}
    selected["firstCorruptedBranch"] = next(iter(report["certifiedForks"].values()), None)
    return selected


if __name__ == "__main__":
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("report",type=Path)
    args=p.parse_args()
    print(json.dumps(compact(json.loads(args.report.read_bytes())),indent=2))
