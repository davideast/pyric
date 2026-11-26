"""Look up independent Firestore measurements by the complete deployed rules digest."""
from hashlib import sha256
import json
from pathlib import Path


def measurements(trial: Path, digest: str | None):
    releases = []
    if digest:
        lock = json.loads((trial / "lock.json").read_bytes())
        for capture in lock["releases"]:
            path = capture["file"]
            encoded = (trial / path).read_bytes()
            if sha256(encoded).hexdigest() != lock["files"][path]:
                raise ValueError(f"Hosted report digest mismatch for {path}")
            for release in json.loads(encoded)["releases"]:
                if release["bundleSha256"] == digest:
                    releases.append({
                        "cohort": capture["name"],
                        "receipt": release["privateReceipt"],
                        "decisions": [{"id": row["id"], "verdict": row["decision"],
                                       "versionChanged": row["versionChanged"]}
                                      for row in release["decisions"]],
                    })
    return {"authority": "live Firestore", "rulesSha256": digest,
            "status": "measured" if releases else "unmeasured", "captures": releases}
