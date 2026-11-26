"""Score a packed Yacht compiler against native points and admitted production decisions."""
import argparse
import base64
import json
from pathlib import Path
import sys

TRIAL = Path(__file__).resolve().parent
ROOT = TRIAL.parents[2]
HERE = TRIAL.relative_to(ROOT).as_posix()
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "core"))
from candidate import MAX_PACKAGE, frozen_arcade
from compiler_trial import run_stage, stock_answers
import oracle

CATEGORIES = "ones twos threes fours fives sixes fullHouse fourKind littleStraight bigStraight choice yacht".split()
CLAIM = "arcade/yacht/yacht-score/v1"
PROBE = "five-equal-dice/v1"
FIXTURES = "suites/arcade/yacht/claims/yacht-score/v1/probes/" + PROBE
NATIVE_DIGEST = "a211d716090588d0787f3400fdcc80d18a737a622540942aa1622048b3528a6f"


def admitted_stock(archive):
    return stock_answers(ROOT, archive, CLAIM, PROBE, FIXTURES)


def execute(package, script, args, files):
    outcome = run_stage(ROOT, package, HERE + "/" + script, args, files, engine="bun")
    if "error" in outcome:
        raise ValueError(script + ": " + outcome["error"])
    return outcome["output"]


def score(args):
    archive = args.trusted_captures.resolve()
    public, receipts = admitted_stock(archive)
    with args.candidate_package.open("rb") as stream:
        package = stream.read(MAX_PACKAGE + 1)
    oracle.require(len(package) <= MAX_PACKAGE, "package exceeds size limit")
    manifest, _ = frozen_arcade(ROOT)
    reference = (ROOT / "arcade/vendor/pyric-rules-0.1.0.tgz").read_bytes()
    oracle.require(oracle.sha(reference) == manifest["files"]["vendor/pyric-rules-0.1.0.tgz"], "reference package changed")
    report = {"candidateSha256": oracle.sha(package), "referenceSha256": oracle.sha(reference), "stockReceipts": receipts}
    files = {HERE + "/" + f for f in ["rolls.mjs", "compile.mjs", "yacht-points.rules"]}
    try:
        result = execute(package, "compile.mjs", ["/oracle/arcade/runtime/node_modules/@pyric/rules", json.dumps(CATEGORIES)], files)
        actual = base64.b64decode(result["scores"], validate=True)
        module = result["module"].encode()
        oracle.require(0 < len(module) <= 65536, "invalid module size")
        oracle.require(len(actual) == 6**5 * len(CATEGORIES), "missing standalone points")
    except (KeyError, ValueError, TypeError, AttributeError) as error:
        return {**report, "passed": False, "unsupported": str(error)}
    files = {HERE + "/" + f for f in ["referee.mjs", "link.mjs", "rolls.mjs", "arcade-scoring.ts"]}
    files.update({"trials/sokoban-repair/v1/tictactoe.stock.rules", "adapters/arcade-sdk/v1/fixture.mjs", FIXTURES + "/fixture.json"})
    ref = execute(reference, "referee.mjs", ["/oracle", base64.b64encode(module).decode()], files)
    expected = base64.b64decode(ref["answers"], validate=True)
    oracle.require(ref["categories"] == CATEGORIES and oracle.sha(expected) == NATIVE_DIGEST and len(actual) == len(expected),
                   "native oracle changed")
    misses = [i for i in range(len(actual)) if actual[i] != expected[i]]
    standalone = {"total": len(actual), "matches": len(actual) - len(misses), "firstDivergence": None}
    if misses:
        i = misses[0]
        roll, cat = divmod(i, len(CATEGORIES))
        standalone["firstDivergence"] = {"dice": [1 + roll // 6**n % 6 for n in range(5)],
                                          "category": CATEGORIES[cat], "expected": expected[i], "actual": actual[i]}
    bundle = base64.b64decode(ref["bundle"], validate=True)
    oracle.require(oracle.sha(bundle) == ref["bundleSha256"], "referee bundle mismatch")
    oracle.require(admitted_stock(archive) == (public, receipts), "stock evidence changed during score")
    updates = ref["completeUpdates"]
    external = ref["publicCases"]
    passed = not misses and updates["matches"] == 2 * len(expected) and updates["rolls"] == 6**5 and updates["wrongDecisions"] == 0 and external == public
    if passed and args.output:
        args.output.mkdir(parents=True, exist_ok=True)
        for name, content in [("points-module.rules", module), ("complete.rules", bundle)]:
            path = args.output / name
            if path.exists():
                oracle.require(path.read_bytes() == content, f"output differs from existing artifact: {path}")
            else:
                with path.open("xb") as handle:
                    handle.write(content)
    return {**report, "passed": passed, "moduleSha256": oracle.sha(module), "bundleSha256": ref["bundleSha256"],
            "nativeSha256": NATIVE_DIGEST, "standalone": standalone, "completeUpdates": updates,
            "stockProduction": public, "generatedLocal": external}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate-package", type=Path, required=True)
    parser.add_argument("--trusted-captures", type=Path, required=True)
    parser.add_argument("--output", type=Path, help="retain the passing module and complete bundle")
    try:
        report = score(parser.parse_args())
    except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
        report = {"passed": False, "error": str(error)}
    print(json.dumps(report, indent=2))
    sys.exit(0 if report["passed"] else 1)
