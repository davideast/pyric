"""Exercise both package installs and score an actual altered distribution through the CLI."""

import gzip
import hashlib
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

CORE = Path(__file__).resolve().parent
ROOT = CORE.parent
STOCK = ROOT / "arcade/vendor/pyric-rules-0.1.0.tgz"


def alter_public_simulator(path):
    # Change only the public Firestore front door. Other imports in the same
    # tarball retain the actual production code and should keep their scores.
    original = b"export { firestoreRules } from './api/firestore.js';"
    broken = b"""
import { firestoreRules as real } from './api/firestore.js';
import { openSync, readFileSync } from 'node:fs';
if (process.env.ORACLE_TEST_CREDENTIAL || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  throw Error('inherited credential environment');
}
if (readFileSync('/proc/net/route', 'utf8').trim().split('\\n').length > 1) {
  throw Error('worker has a network route');
}
for (const path of ['/oracle/arcade/runtime/package.json', '/oracle/arcade/runtime/node_modules/@pyric/rules/package.json']) {
  try { openSync(path, 'r+'); }
  catch (error) { if (['EROFS', 'EACCES'].includes(error.code)) continue; throw error; }
  throw Error('writable replay input');
}
export function firestoreRules(source) {
  const handle = real(source);
  return { ...handle, simulate(inputs) {
    const result = handle.simulate(inputs);
    for (const row of result.cases) row.decision = row.decision === 'ALLOW' ? 'DENY' : 'ALLOW';
    return result;
  }};
}
"""
    with (tarfile.open(STOCK) as source, path.open("wb") as raw,
          gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as compressed,
          tarfile.open(fileobj=compressed, mode="w") as dest):
        for member in source:
            data = source.extractfile(member).read() if member.isfile() else None
            if member.name == "package/dist/index.js":
                assert data.count(original) == 1
                data = data.replace(original, broken)
                member.size = len(data)
            dest.addfile(member, io.BytesIO(data) if data is not None else None)


def score(path, status):
    result = subprocess.run([sys.executable, CORE / "oracle.py", "--candidate-package", path], cwd=ROOT,
                            env={**os.environ, "ORACLE_TEST_CREDENTIAL": "must-not-reach-the-worker"},
                            text=True, capture_output=True)
    if result.returncode != status or not result.stdout.strip():
        raise AssertionError(f"exit {result.returncode}: {result.stderr or result.stdout[-1800:]}")
    return json.loads(result.stdout)


class CandidateTest(unittest.TestCase):
    def test_absent_or_nonverdict_predictions_cannot_score_as_a_denial(self):
        from candidate import classify, predictions
        row = {"case": "edge", "status": "evidenced", "expected": "DENY"}
        reference = {"edge": "DENY"}
        for output in ({"candidate": {}}, {"candidate": {"edge": None}}, {"candidate": {"edge": "ERROR"}}):
            values, errors, _ = predictions({"output": output}, ["edge"])
            self.assertEqual(classify(row, reference, values, errors.get("edge"))["outcome"], "unsupported")
        self.assertEqual(classify({**row, "status": "pending"}, reference, {}, "runner failed")["outcome"], "pending")

    def test_query_permissions_and_matching_documents_are_scored_separately(self):
        from candidate import classify
        allowed = {"verdict": "ALLOW", "matches": [0]}
        def score_query(expected, actual):
            row = {"case": "query", "status": "evidenced", "expected": expected, "query": True}
            return classify(row, {"query": expected}, {"query": actual}, None)["outcome"]
        self.assertEqual(score_query(allowed, "DENY"), "false-denial")
        self.assertEqual(score_query("DENY", allowed), "false-allow")
        self.assertEqual(score_query(allowed, {**allowed, "matches": []}), "mismatch")
        self.assertEqual(score_query(allowed, {**allowed, "matches": [-1]}), "unsupported")
        self.assertEqual(score_query(allowed, allowed), "match")

    def test_public_tarball_and_altered_tarball(self):
        stock = score(STOCK, 1)
        self.assertEqual(stock["summary"]["matches"], stock["summary"]["scored"])
        # Without the controller archive only the native Tally cases are admitted.
        # The frozen compiler predates for-of. Its parser refusal is a measured gap.
        unsupported = [(r["claim"], r["case"]) for r in stock["cases"] if r["outcome"] == "unsupported"]
        self.assertEqual({claim for claim, _ in unsupported}, {"satisfy/tally-slate/two-action-fold/v1",
                                                               "satisfy/tally-slate/two-strike-validation/v1"})
        self.assertEqual(len(unsupported), 9)
        self.assertTrue(stock["artifacts"]["arcade/tictactoe"]["sameBytes"])
        with tempfile.NamedTemporaryFile(suffix=".tgz") as altered:
            path = Path(altered.name)
            alter_public_simulator(path)
            broken = score(path, 1)
            self.assertEqual(broken["candidateSha256"], hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertNotEqual(broken["candidateSha256"], stock["candidateSha256"])
        for field in ("evidenceSha256", "referenceSha256"):
            self.assertEqual(broken[field], stock[field])
        self.assertEqual([r["reference"] for r in broken["cases"]], [r["reference"] for r in stock["cases"]])
        frozen = [r for r in broken["cases"] if r["claim"].startswith("arcade/tictactoe/")]
        self.assertEqual(len(frozen), 21)
        self.assertTrue(all(row["regression"] for row in frozen))
        self.assertGreater(broken["summary"]["falseAllows"], 0)
        self.assertGreater(broken["summary"]["falseDenials"], 0)
        self.assertEqual(broken["summary"]["firstRegression"]["case"], frozen[0]["case"])
        self.assertEqual([(r["claim"], r["case"]) for r in broken["cases"] if r["outcome"] == "unsupported"], unsupported)
        self.assertEqual(broken["summary"]["pending"], stock["summary"]["pending"])
        self.assertTrue(broken["artifacts"]["arcade/tictactoe"]["sameBytes"])


if __name__ == "__main__":
    unittest.main()
