"""Exercise the bounded chess module return shapes through an installed package."""
import argparse
from collections import Counter
import json
from pathlib import Path
import runpy
import sys
import tempfile

sys.dont_write_bytecode = True


def check(trial):
    sys.path.insert(0, str(trial))
    tools = runpy.run_path(str(trial / "controls.py"))
    base = tools["SOURCE"].replace("RUNTIME","return locate ? 0 : true").replace(
        "EMITTER",tools["EMIT"].replace("PREDICATE","'true'"))
    # A string has .includes(), but is not a collection of UCI moves.
    bad = ("export function legalMoves() {return 'no moves'}\n"
           "export function apply(before) {return before}\n"
           "export function outcome() {return 'playing'}")
    source = base + "\nexport function compileBoundedModule() {return {moduleSource:" + json.dumps(bad) + "}}"
    manifest = {"name":"@pyric/rules","version":"0.0.0","type":"module",
                "exports":{"./experimental/policy":{"default":"./index.mjs"}}}
    with tempfile.TemporaryDirectory() as tmp:
        artifact = Path(tmp)/"control.tgz"
        tools["pack"](artifact,manifest,source)
        result = tools["score"](artifact,1,"pins",board_policy=True)
    rows = result["standaloneBoard"]
    return {"test":"legalMoves returns a string instead of an array",
            "byExpectedAndResult":dict(Counter(row["expected"]+"/"+row["status"] for row in rows)),
            "controls":[row for row in rows if row["id"] in ("rook-safe","rook-exposed")]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trial",type=Path,default=Path(__file__).resolve().parents[2])
    args=parser.parse_args()
    print(json.dumps(check(args.trial.resolve()),indent=2))
