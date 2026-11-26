"""Witness admission and isolated execution shared by compiled-module trials."""
from offline_runtime import side
import oracle


def stock_answers(root, archive, claim, probe, directory):
    oracle.require(archive.is_dir() and not archive.is_relative_to(oracle.checkout_boundary(root)),
                   "public scoring requires a separate capture-controller archive")
    sources = oracle.EvidenceSources(oracle.released_pins(root, None), archive, None)
    report, snapshot = oracle.inspect(root, sources)
    for name, digest in sources.released.items():
        oracle.require(snapshot["pins"].get(name) == digest, f"missing or altered released record: {name}")
    entry = report["claims"][claim]["probes"][probe]
    oracle.require(entry["status"] == "evidenced" and entry["observations"],
                   "public stock decisions require admitted authenticated write/readbacks")
    receipts = [oracle.load(root / directory / "observations" / (name + ".json")) for name in entry["observations"]]
    return receipts[0]["results"], [r["evidence"]["sha256"] for r in receipts]


def run_stage(root, package, runner, args, files, *, engine):
    task = {"engine": engine, "runner": "/oracle/" + runner, "args": args}
    result = side(root, package, {"run": task}, reference=False, timeout=300, pinned_paths=files)
    return {"error": result["installError"]} if "installError" in result else result["tasks"]["run"]
