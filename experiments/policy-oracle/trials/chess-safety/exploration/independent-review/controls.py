"""Exercise type and evaluation-error boundaries through an installed compiler package."""
import argparse
from collections import Counter
import json
from pathlib import Path
import runpy
import sys
import tempfile

sys.dont_write_bytecode = True


def run(trial):
    sys.path.insert(0, str(trial))
    helpers = runpy.run_path(str(trial / "controls.py"))
    # The reference package emits Rules programs valid at link time. Every
    # selected safety predicate then fails a list index at evaluation time.
    source = helpers["SOURCE"].replace("RUNTIME", "return locate ? 0 : 'false'").replace(
        "EMITTER", helpers["EMIT"].replace("PREDICATE", "'[1][10] == 0'"))
    manifest = {"name": "@pyric/rules", "version": "0.0.0", "type": "module",
                "exports": {"./experimental/policy": {"default": "./index.mjs"}}}
    with tempfile.TemporaryDirectory() as tmp:
        package = Path(tmp) / "control.tgz"
        helpers["pack"](package, manifest, source)
        report = helpers["score"](package, 1, "pins")
    result = {"purpose": "nonboolean safety function and linked runtime error",
              "passed": report["passed"], "diagnostics": report["diagnostics"]}
    for name in ("kingSafety", "linkedWrites"):
        rows = report[name]
        result[name] = {
            "byExpectedAndResult": dict(Counter(row["expected"] + "/" + row["status"] for row in rows)),
            "controls": [row for row in rows if row["id"] in ("rook-safe", "rook-exposed")],
        }
    return result


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--trial", type=Path, default=Path(__file__).resolve().parents[2])
    args = p.parse_args()
    print(json.dumps(run(args.trial.resolve()), indent=2))
