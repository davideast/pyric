"""Compare a separately installed rules tarball with reviewed offline evidence."""

import os

from offline_runtime import side
from oracle import canonical, claim_dirs, exact_cases, load, require, sha

ARCHIVE = "arcade/tictactoe"
LEDGER_SHA256 = "b3986319059d0d286e3450dd9f554eead8e84a0c872943b7e389ed356b0359fc"
MAX_PACKAGE = 64 << 20


def frozen_arcade(root):
    directory = root / "arcade/v1"
    ledger_file = directory / "ledger.json"
    require(sha(ledger_file.read_bytes()) == LEDGER_SHA256, "frozen Arcade ledger changed")
    ledger = load(ledger_file)
    manifest_file = directory / "manifest.json"
    require(sha(manifest_file.read_bytes()) == ledger["manifestSha256"], "frozen Arcade manifest changed")
    manifest = load(manifest_file)
    answers = {}
    for batch in ("zero", "four"):
        path = directory / f"observations/{batch}.json"
        require(sha(path.read_bytes()) == ledger["observations"][batch]["normalizedSha256"],
                f"stale frozen Arcade receipt: {batch}")
        answers.update({row["id"]: row["decision"] for row in load(path)["cases"]})
    variants = {variant: claim["id"] for claim in manifest["claims"]
                for variant in (claim["control"], claim["generated"])}
    records = []
    for case in manifest["cases"]:
        name = case["id"]
        claim = variants[name.split("/")[1]]
        records.append({"claim": f"{ARCHIVE}/{claim}/v1", "probe": "counter-writes/v1", "case": name,
                        "authority": "firestore-sdk", "execution": "generated Firestore module and simulator",
                        "status": "evidenced", "expected": answers[name]})
    return manifest, records


def discover(root, report):
    tasks, records, files = {}, {}, set()
    for claim, path in claim_dirs(root):
        for probe, info in report["claims"][claim]["probes"].items():
            directory = path / "probes" / probe
            recipe = load(directory / "recipe.json")
            key = claim + "/" + probe
            name = str((directory / recipe["replay"]).relative_to(root))
            for pin in recipe["pins"]:
                files.add(pin[8:] if pin.startswith("@oracle/") else str((directory / pin).relative_to(root)))
            tasks[key] = {"runner": "/oracle/" + name, "engine": "bun"}
            # inspect() has verified admission, all raw pointers, pins and agreement.
            expected = {}
            if info["status"] == "evidenced":
                receipt = directory / "observations" / (info["observations"][0] + ".json")
                expected = load(receipt)["results"]
            execution = "pinned probe " + name
            if recipe.get("verifyEvidence") == "@oracle/adapters/arcade-sdk/v1/verify.mjs":
                if "@oracle/adapters/arcade-sdk/v1/replay.mjs" in recipe["pins"]:
                    execution = "stock Firestore rules and simulator"
            records[key] = [{"claim": claim, "probe": probe, "case": case, "status": info["status"],
                             "authority": report["claims"][claim]["authority"], "execution": execution,
                             **({"query": True} if case in recipe.get("queryCases", []) else {}),
                             **({"expected": expected[case]} if case in expected else {})}
                            for case in info["cases"]]
    return tasks, records, files


def predictions(result, cases, *, archive=False):
    if "error" in result:
        return {}, dict.fromkeys(cases, result["error"]), {}
    try:
        output = result["output"]
        values = output["candidate"]
        errors = output.get("errors", {}) if archive else {}
        require(isinstance(values, dict) and isinstance(errors, dict) and not (values.keys() & errors.keys()),
                "runner returned ambiguous outcomes")
        exact_cases({**values, **errors}, cases, "package replay")
        return values, errors, output.get("artifacts", {})
    except (KeyError, TypeError, ValueError) as error:
        return {}, dict.fromkeys(cases, str(error)), {}


def classify(row, reference, candidate, error):
    name = row["case"]
    row = {**row, "reference": reference[name], "candidate": candidate.get(name), "regression": False}
    if error:
        row["error"] = error
    if row["status"] in ("pending", "disputed"):
        return {**row, "outcome": row["status"]}
    expected = row["expected"]
    if row.get("query"):
        # Allowed queries carry matched fixture IDs. Refusal has no result set.
        # Count permission mismatches apart from a wrong set of returned documents.
        def query_permission(result):
            if result == "DENY":
                return result
            if (isinstance(result, dict) and set(result) == {"verdict", "matches"} and result["verdict"] == "ALLOW"
                    and isinstance(result["matches"], list) and all(type(i) is int and i >= 0 for i in result["matches"])
                    and sorted(set(result["matches"])) == result["matches"]):
                return "ALLOW"
            return None
        want, got = query_permission(expected), query_permission(candidate.get(name))
        if error or not got or not want:
            return {**row, "outcome": "unsupported"}
        if got != want:
            return {**row, "outcome": "false-denial" if want == "ALLOW" else "false-allow",
                    "regression": canonical(reference[name]) == canonical(expected)}
    # A malformed decision or an evaluator abstention cannot agree with a denial.
    if (error or name not in candidate or
        (type(expected) is bool and type(candidate[name]) is not bool) or
        (expected in ("ALLOW", "DENY") and candidate[name] not in ("ALLOW", "DENY"))):
        return {**row, "outcome": "unsupported"}
    if canonical(expected) == canonical(candidate[name]):
        outcome = "match"
    elif type(expected) is bool or expected in ("ALLOW", "DENY"):
        outcome = "false-denial" if expected in (True, "ALLOW") else "false-allow"
    else:
        outcome = "mismatch"
    row["regression"] = outcome != "match" and canonical(reference[name]) == canonical(expected)
    return {**row, "outcome": outcome}


def summarize(cases):
    def first(predicate):
        return next(({key: row[key] for key in ("claim", "probe", "case")} for row in cases if predicate(row)), None)

    counts = {name: sum(row["outcome"] == name for row in cases)
              for name in ("match", "false-allow", "false-denial", "mismatch", "unsupported", "pending", "disputed")}
    return {"scored": sum(counts[name] for name in ("match", "false-allow", "false-denial", "mismatch")),
            "matches": counts["match"], "falseAllows": counts["false-allow"], "falseDenials": counts["false-denial"],
            "otherMismatches": counts["mismatch"], "unsupported": counts["unsupported"], "pending": counts["pending"],
            "disputed": counts["disputed"], "regressions": sum(row["regression"] for row in cases),
            "firstRegression": first(lambda row: row["regression"]),
            "firstFalseAllow": first(lambda row: row["outcome"] == "false-allow"),
            "firstFalseDenial": first(lambda row: row["outcome"] == "false-denial")}


def score_package(root, report, snapshot, package):
    manifest, archive_rows = frozen_arcade(root)
    tasks, groups, pinned_paths = discover(root, report)
    groups = {ARCHIVE: archive_rows, **groups}
    timeout = int(os.environ.get("ORACLE_REPLAY_TIMEOUT_SECONDS", "300"))
    require(timeout > 0, "replay timeout must be positive")
    with package.open("rb") as stream:
        submitted = stream.read(MAX_PACKAGE + 1)
    require(len(submitted) <= MAX_PACKAGE, "candidate exceeds packed package limit")
    stock = (root / "arcade/vendor/pyric-rules-0.1.0.tgz").read_bytes()
    reference_sha = sha(stock)
    require(reference_sha == manifest["files"]["vendor/pyric-rules-0.1.0.tgz"], "stock rules package changed")
    admitted = {claim + "/" + probe: info["observations"] for claim, spec in report["claims"].items()
                for probe, info in spec["probes"].items()}
    evidence = {"snapshot": snapshot, "frozenArcadeLedger": LEDGER_SHA256, "admittedObservations": admitted}
    report = {"referenceSha256": reference_sha, "candidateSha256": sha(submitted),
              "evidenceSha256": sha(canonical(evidence).encode())}
    reference = side(root, stock, {ARCHIVE: {"runner": "/oracle/arcade/runtime/replay.mjs",
                     "engine": "node", "args": ["--json"]}, **tasks}, reference=True, timeout=timeout,
                     pinned_paths=pinned_paths)
    require("installError" not in reference, f"reference install failed: {reference.get('installError')}")
    frozen = reference["tasks"][ARCHIVE]
    require("output" in frozen, f"frozen Arcade reference failed: {frozen.get('error')}")
    original = frozen["output"]
    require(original["correctDecisions"] == len(original["rows"]) == 21 and
            original["conformance"] == original["evidenceCoverage"] == [2, 2] and
            original["mutationFalseAllows"] == original["mutationFalseDenials"] == 4,
            "frozen Arcade reference changed")
    reference["tasks"][ARCHIVE] = {"output": {"candidate": {row["id"]: row["simulated"] for row in original["rows"]},
        "artifacts": {c["id"]: {"rulesSha256": manifest["files"][f"v1/rules/{c['generated']}.rules"],
                                "moduleSha256": manifest["files"][f"v1/rules/{c['generated']}-module.rules"]}
                      for c in manifest["claims"]}}}
    candidate = side(root, submitted, {ARCHIVE: {"runner": "/oracle/arcade/runtime/frozen-candidate.mjs",
                     "engine": "node"}, **tasks}, reference=False, timeout=timeout, pinned_paths=pinned_paths)
    if "installError" in candidate:
        report["installError"] = candidate["installError"]
    cases, artifacts = [], {}
    for key, rows in groups.items():
        names = [row["case"] for row in rows]
        stock_values, stock_errors, stock_artifacts = predictions(reference["tasks"][key], names)
        require(not stock_errors, f"reference probe failed: {key}: {next(iter(stock_errors.values()), '')}")
        result = ({"error": candidate["installError"]} if "installError" in candidate else candidate["tasks"][key])
        values, errors, emitted = predictions(result, names, archive=key == ARCHIVE)
        if emitted or stock_artifacts:
            artifacts[key] = {"reference": stock_artifacts, "candidate": emitted,
                              "sameBytes": canonical(emitted) == canonical(stock_artifacts)}
        for row in rows:
            cases.append(classify(row, stock_values, values, errors.get(row["case"])))
    report.update({"cases": cases, "artifacts": artifacts, "summary": summarize(cases)})
    return report
