"""Acceptance tests for the offline policy-oracle command."""

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

COMMAND = Path(__file__).with_name("oracle.py")
CLAIM = "example/game/counter/v1"


def digest(data):
    return hashlib.sha256(data).hexdigest()


class OracleTest(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.claim = self.root / "suites/example/game/claims/counter/v1"
        self.probe = self.claim / "probes/bound/v1"
        self.probe.mkdir(parents=True)
        self.write(self.claim / "claim.json", {"description": "Observed count", "authority": "native-model"})
        self.write(self.claim / "obligations/edge.json", {"probe": "bound/v1"})
        code = b'console.log(JSON.stringify({candidate:{edge:1},mutant:{edge:0}}))'
        (self.probe / "replay.mjs").write_bytes(code)
        self.recipe = {"source": {"repo":"example", "revision":"1"*40, "path":"counter.ts"},
                       "cases":["edge"], "pins":{"replay.mjs":digest(code)}, "replay":"replay.mjs"}
        self.write(self.probe / "recipe.json", self.recipe)

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value) + "\n")

    def invoke(self, *args, status=0):
        result = subprocess.run([sys.executable, COMMAND, "--root", self.root, *args],
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, status, result.stderr + result.stdout)
        return json.loads(result.stdout) if status == 0 else result.stderr + result.stdout

    def test_pending_claim_stays_in_denominator(self):
        report = self.invoke()
        self.assertEqual(report["claims"][CLAIM]["status"], "pending")
        self.assertEqual(report["claims"][CLAIM]["probes"]["bound/v1"]["cases"], ["edge"])

    def observe(self, run, value):
        evidence = self.probe / f"raw/{run}.json"
        self.write(evidence, {"outcome": value})
        inputs = (self.claim / "claim.json").read_bytes() + b"\0" + (self.probe / "recipe.json").read_bytes()
        observation = {"authority": "native-model", "results": {"edge": value}, "inputDigest":digest(inputs),
                       "evidence":{"path":f"raw/{run}.json", "sha256": digest(evidence.read_bytes()),
                                   "pointers":{"edge":"/outcome"}}}
        path = self.probe / f"observations/{run}.json"
        self.write(path, observation)
        return path, observation

    def test_replay_compares_real_receipt_and_mutant(self):
        self.observe("first", 1)
        result = self.invoke("--replay")["claims"][CLAIM]
        self.assertEqual(result["status"], "conforms")
        self.assertEqual(result["probes"]["bound/v1"]["mutantMisses"], ["edge"])

    def test_missing_eligible_authority_cannot_be_substituted(self):
        path, observation = self.observe("local", 1)
        observation["authority"] = "firestore-sdk"
        self.write(path, observation)
        self.assertIn("authority", self.invoke(status=1))

    def test_normalized_result_must_match_raw_bytes_including_type(self):
        path, observation = self.observe("first", 1)
        observation["results"]["edge"] = True
        self.write(path, observation)
        self.assertIn("raw", self.invoke(status=1))

    def test_disagreement_is_preserved_and_blocks_success(self):
        self.observe("first", 1)
        self.observe("second", 0)
        result = self.invoke(status=1)
        self.assertIn('"status": "disputed"', result)
        self.assertIn('"second"', result)

    def test_changed_inputs_fail_before_replay(self):
        self.observe("first", 1)
        (self.probe / "replay.mjs").write_text("throw Error('should not execute')")
        self.assertIn("pin", self.invoke("--replay", status=1))

    def test_released_obligation_cannot_disappear(self):
        baseline = self.root / "reviewed.json"
        self.write(baseline, self.invoke("--snapshot"))
        original = self.claim / "obligations/edge.json"
        original.rename(original.with_name("different.json"))
        self.assertIn("obligations/edge.json", self.invoke("--baseline", baseline, status=1))

    def test_failed_candidate_fails_even_when_mutant_agrees(self):
        self.observe("different", 0)
        result = self.invoke("--replay", status=1)
        self.assertIn('"status": "diverged"', result)

    def test_unreviewed_extra_case_rejected(self):
        path, observation = self.observe("first", 1)
        observation["results"]["extra"] = 2
        self.write(path, observation)
        self.assertIn("case", self.invoke(status=1))

    def test_observations_follow_claim_and_recipe_bytes(self):
        self.observe("first", 1)
        self.recipe["source"]["revision"] = "2" * 40
        self.write(self.probe / "recipe.json", self.recipe)
        self.assertIn("stale observation", self.invoke(status=1))

    def test_duplicate_json_keys_do_not_collapse(self):
        (self.claim / "claim.json").write_text('{"description":"a","description":"b","authority":"native-model"}')
        self.assertIn("duplicate JSON key", self.invoke(status=1))

    def test_case_colliding_owners_are_rejected(self):
        (self.root / "suites/Example").mkdir()
        self.assertIn("invalid directory ID", self.invoke(status=1))

    def test_unpinned_runner_never_executes(self):
        self.recipe["pins"] = {}
        self.write(self.probe / "recipe.json", self.recipe)
        self.assertIn("unpinned replay", self.invoke("--replay", status=1))

    def test_symlinked_structural_directories_are_rejected(self):
        probes = self.claim / "probes"
        target = self.root / "external-probes"
        probes.rename(target)
        probes.symlink_to(target, target_is_directory=True)
        self.assertIn("symlink", self.invoke(status=1))

    def test_repeat_capture_does_not_count_an_extra_claim(self):
        self.observe("first", 1)
        self.observe("second", 1)
        result = self.invoke()
        self.assertEqual(list(result["claims"]), [CLAIM])
        self.assertEqual(result["claims"][CLAIM]["probes"]["bound/v1"]["observations"], ["first", "second"])

    def duplicate_probe(self):
        other = self.probe.parents[1] / "second/v1"
        shutil.copytree(self.probe, other)
        self.write(self.claim / "obligations/second.json", {"probe": "second/v1"})
        return other

    def test_mixed_divergence_and_pending_keeps_diagnostics(self):
        self.duplicate_probe()
        self.observe("different", 0)
        output = self.invoke("--replay", status=1)
        self.assertIn('"status": "diverged"', output)
        self.assertIn('"status": "pending"', output)

    def test_one_probe_cannot_hide_another_mutation_that_survives(self):
        other = self.duplicate_probe()
        self.observe("first", 1)
        self.probe = other
        runner = self.probe / "replay.mjs"
        runner.write_text("console.log(JSON.stringify({candidate:{edge:1},mutant:{edge:1}}))")
        self.recipe["pins"]["replay.mjs"] = digest(runner.read_bytes())
        self.write(self.probe / "recipe.json", self.recipe)
        self.observe("second", 1)
        self.assertIn('"mutationDetected": false', self.invoke("--replay", status=1))

    def test_cloud_verdict_requires_explicit_witness_contract(self):
        self.write(self.claim / "claim.json", {"description":"Yacht score", "authority":"firestore-sdk"})
        self.assertIn("witness", self.invoke(status=1))

    def test_imported_cloud_receipt_cannot_be_a_local_score(self):
        self.write(self.claim / "claim.json", {"description":"Batch", "authority":"firestore-sdk",
                                              "witness":"imported-production-verdict"})
        path, obs = self.observe("local", 1)
        obs["authority"] = "firestore-sdk"
        self.write(path, obs)
        self.assertIn("imported", self.invoke(status=1))

    def test_shared_input_cannot_stand_in_for_local_replay(self):
        self.recipe["replay"] = "@oracle/good.mjs"
        (self.root / "good.mjs").write_text("reviewed")
        self.recipe["pins"] = {"@oracle/good.mjs":digest(b"reviewed")}
        self.write(self.probe / "recipe.json", self.recipe)
        self.assertIn("local replay", self.invoke(status=1))


if __name__ == "__main__":
    unittest.main()
