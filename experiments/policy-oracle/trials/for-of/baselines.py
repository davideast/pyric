"""Recheck the established package and application oracles against this candidate."""
import hashlib
import json
from pathlib import Path
from shutil import copyfile
import subprocess
import sys

HERE = Path(__file__).resolve().parent
CHESS = HERE.parent / "chess"
ROOT = HERE.parents[1]


def run(*command):
    return json.loads(subprocess.check_output(command, cwd=HERE))


def verify(package, archive, arcade, reference, output):
    # The existing package scorers prepare their own pinned offline consumers.
    args = ["--candidate-package", package, "--trusted-captures", archive]
    prior = run(sys.executable, ROOT / "core/oracle.py", "--all", "--trusted-captures", archive)
    broad = run(sys.executable, ROOT / "core/oracle.py", *args)
    sokoban = run(sys.executable, HERE.parent / "sokoban-repair/v1/score.py", *args)
    yacht = run(sys.executable, HERE.parent / "yacht-points/v1/score.py", *args)
    digest = hashlib.sha256(package.read_bytes()).hexdigest()
    assert all(score["candidateSha256"] == digest for score in (broad, sokoban, yacht))
    assert all(claim["status"] == "conforms" for claim in prior["claims"].values())
    assert broad["summary"]["matches"] == broad["summary"]["scored"]
    assert sokoban["passed"] and yacht["passed"]

    stock_chess = json.loads((CHESS / "bundle/local-results.json").read_text())
    local = run("bun", CHESS / "bundle/verify.mjs", arcade, reference, output / "generated.rules")
    assert local["verdicts"] == stock_chess["verdicts"]
    # The rebuilt chess modules have already matched the qualified module bytes.
    public = run("bun", CHESS / "verify/replay.mjs")
    sealed = json.loads((CHESS / "verify/qualified-score.json").read_text())
    for suite in ["board", "metadata"]:
        assert public[suite]["results"] == sealed[suite]["results"][:1]
    assert public["hosted"] == sealed["hosted"]
    comparison = output / "comparison"
    comparison.mkdir()
    for name in ["stock", "compatibility", "referee"]:
        copyfile(CHESS / "bundle/artifacts" / (name + ".rules"), comparison / (name + ".rules"))
    copyfile(output / "generated.rules", comparison / "stronger.rules")
    hosted = run("bun", CHESS / "verify/score-hosted.mjs", comparison, reference)
    assert all(not row["mismatches"] for row in hosted)
    return {
        "package": digest, "coreClaims": len(prior["claims"]),
        "broadCases": broad["summary"]["matches"],
        "sokobanCases": sokoban["public"]["passes"] + sokoban["heldOut"]["passes"],
        "yachtStandalone": yacht["standalone"]["matches"],
        "yachtLocalWrites": yacht["completeUpdates"]["matches"],
        "chessPublic": public["board"]["results"][0]["counts"],
        "priorFirestoreWriteAndAdmissionCases": sum(len(row["rows"]) for row in hosted),
        "priorFirestoreReads": sum(row["reads"] for row in hosted),
        "priorStrongerFirestoreWrites": sum(row["sdkWrites"] for row in hosted if row["profile"] == "stronger"),
        "chessLocalCases": local["cases"], "chessLocalProfiles": len(local["profiles"]),
        "originalPeak": stock_chess["peak"]["stronger"], "candidatePeak": local["peak"]["stronger"],
    }
