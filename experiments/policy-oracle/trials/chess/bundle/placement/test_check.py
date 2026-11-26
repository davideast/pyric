import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ARTIFACTS = HERE.parent / "artifacts"


class PlacementTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.board = self.module("board", ["legalMoves", "apply", "inCheck", "outcome"])
        self.match = self.module("match", ["admit", "metadata"])
        self.lock = self.root / "lock.json"
        self.write_lock()

    def module(self, role, names):
        path = self.root / (role + ".mjs")
        path.write_text("\n".join(f"export function {name}() {{}}" for name in names))
        return path

    def write_lock(self):
        self.lock.write_text(json.dumps({role: hashlib.sha256(path.read_bytes()).hexdigest()
                                         for role, path in [("board", self.board), ("match", self.match)]}))

    def run_gate(self, profile, *options, bundle=None):
        return subprocess.run([sys.executable, HERE / "check.py", profile,
                               bundle or ARTIFACTS / (profile + ".rules"), self.board, self.match, self.lock,
                               *options], capture_output=True, text=True)

    def test_stock_and_compatibility_keep_the_same_placements(self):
        a = json.loads(self.run_gate("stock").stdout)
        b = json.loads(self.run_gate("compatibility").stdout)
        self.assertNotEqual(a["linkedRulesSha256"], b["linkedRulesSha256"])
        self.assertEqual(a["obligations"], b["obligations"])
        self.assertIn("mandatory-final-rank-promotion", a["residual"])

    def test_stronger_reports_remaining_standalone_requirements(self):
        self.board.unlink()
        self.match.unlink()
        doc = json.loads(self.run_gate("stronger").stdout)
        self.assertEqual(doc["obligations"]["sliding-path-clearance"], "firestore-rules")
        self.assertIn("king-safety-and-pins", doc["residual"])
        self.assertIn("stalemate-and-draw", self.run_gate("stronger", "--require-complete").stderr)

    def test_referee_resolves_all_targets(self):
        doc = json.loads(self.run_gate("referee", "--require-complete").stdout)
        self.assertTrue(doc["completePlacement"])
        self.assertEqual(doc["moduleDigests"], json.loads(self.lock.read_text()))
        self.assertEqual(doc["obligations"]["reject-direct-player-move"], "firestore-rules")
        self.assertEqual(doc["obligations"]["stalemate-and-draw"], "board.outcome")
        self.assertEqual(doc["obligations"]["counter-increment"], "match.metadata")

    def test_missing_and_changed_runtime(self):
        self.match.unlink()
        self.assertIn("absent or changed match", self.run_gate("referee").stderr)
        self.board.write_text("// drifted")
        self.assertIn("absent or changed board", self.run_gate("referee").stderr)

    def test_malformed_lock_or_missing_export(self):
        self.lock.write_text("{}")
        self.assertIn("release lock", self.run_gate("referee").stderr)
        self.module("match", ["admit"])
        self.write_lock()
        result = self.run_gate("referee")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Missing match.metadata", result.stderr)

    def test_wrong_rules_profile(self):
        result = self.run_gate("referee", bundle=ARTIFACTS / "stronger.rules")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("linked referee ruleset", result.stderr)


if __name__ == "__main__":
    unittest.main()
