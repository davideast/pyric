"""Check that the offline bundle referee distinguishes a one-point little-straight scoring error."""
import base64
import hashlib
import json
from pathlib import Path
import subprocess

trial = Path(__file__).resolve().parent
root = trial.parents[2]
module = (trial / "artifacts/points-module.rules").read_bytes()
original = b"== [1, 2, 3, 4, 5].toSet() ? 30 : 0"
assert module.count(original) == 1
altered = module.replace(original, original.replace(b"? 30", b"? 31"))
result = subprocess.run(["bun", str(trial / "referee.mjs"), str(root), base64.b64encode(altered).decode()],
                        check=True, text=True, capture_output=True)
score = json.loads(result.stdout)
assert score["publicCases"] == {"score-50": "ALLOW", "score-49": "DENY"}
assert score["completeUpdates"]["falseAllows"] == score["completeUpdates"]["falseDenials"] == 120
print(json.dumps({"change": "Award 31 for a little straight in the emitted helper.",
                  "scope": "Offline complete ruleset replay",
                  "moduleSha256": hashlib.sha256(altered).hexdigest(), "bundleSha256": score["bundleSha256"],
                  "publicCases": score["publicCases"], "completeUpdates": score["completeUpdates"]}, indent=2))
