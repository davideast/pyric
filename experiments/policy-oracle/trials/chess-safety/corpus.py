"""Load immutable native answers and independently construct signed write proposals."""
from hashlib import sha256
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
OLD = HERE.parent / "king-safety"
BATCHES = ["01-rank-diagonal", "02-king-destinations", "03-check-evasions",
           "04-en-passant", "05-castling", "06-composition", "07-terminal"]


def checked(path, digest):
    content = path.read_bytes()
    if sha256(content).hexdigest() != digest:
        raise ValueError(f"Frozen evidence digest differs for {path.name}")
    return json.loads(content)


def load(through):
    cases, files, cohorts = [], [], {}
    legacy = [("positions", "native"), ("cost-position", "cost-native"), ("path-cost-controls", "path-native")]
    old_pins = json.loads((OLD / "lock.json").read_bytes())["files"]
    for inputs, answers in legacy:
        positions, truth = [f"reference/{n}.json" for n in [inputs, answers]]
        checked(OLD / positions, old_pins[positions])
        files.append(OLD / positions)
        for c in checked(OLD / truth, old_pins[truth])["cases"]:
            cases.append({"id": c["id"], "kingSafe": not c["afterCheck"], "nativeAdmission": c["nativeLegal"]})
    cohorts["00-legacy-file"] = [c["id"] for c in cases]
    for name in BATCHES[:through]:
        folder = HERE / "batches" / name / "v1"
        pins = json.loads((HERE / "freezes" / (name + ".json")).read_bytes())
        positions = checked(folder / "positions.json", pins["positions"])
        result = checked(folder / "native.json", pins["native"])["cases"]
        ids = [p["id"] for p in positions]
        if ids != [c["id"] for c in result]:
            raise ValueError(f"Frozen case order mismatch in {name}")
        for c in result:
            if any(type(c[key]) is not bool for key in ("nativeAdmission", "kingSafe")):
                raise ValueError("Invalid native verdict")
        files.append(folder / "positions.json")
        cohorts[name] = ids
        cases.extend(result)
    requests = json.loads(subprocess.check_output(["bun", HERE / "inputs.mjs", *files]))
    ids = [c["id"] for c in cases]
    if len(set(ids)) != len(ids) or [r["description"] for r in requests] != ids:
        raise ValueError("Write request identity mismatch")
    return cases, cohorts, requests
