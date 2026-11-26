"""Re-score locked revisions from fresh offline installs of the three pinned packages."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
PINS = {
    "current": "6509672646c48bf7ee6206b9648ed8cd40520dece055cae12724e9b94fff8d5b",
    "loop": "d1b3fb579687faba1ce2841551432916955bb7376f9825f61bf5214825a7e095",
    "reviewed": "f2f6b977917ece78962b9e1af9d1d3d15d5a7a98d17743f122f159f479e7950f",
}
SOURCES = {
    "current/first": "8b7ba70a2af1cf2dba8e53eb0ffb1882fd645a86e77b7b79479d68255882cff9",
    "current/locked": "8b7ba70a2af1cf2dba8e53eb0ffb1882fd645a86e77b7b79479d68255882cff9",
    "loop/first": "be308877884422ea30634a2ec02187ab541ddf88ef7259bdfb0e7b5faae6c114",
    "loop/locked": "29f7d63a5da3a497b305511656868d80fd99af9f65c1b2c5d33028671ffa5a1f",
}


def main():
    if len(sys.argv) != 5:
        raise SystemExit("replay.py PRIVATE_CORPUS CURRENT_PACK LOOP_PACK REVIEWED_PACK")
    corpus, *tarballs = [Path(p).resolve() for p in sys.argv[1:]]
    vendor = HERE.parents[3] / "arcade/vendor"
    results = {}
    with tempfile.TemporaryDirectory(prefix="loop-author-score-") as tmp:
        for (profile, digest), package in zip(PINS.items(), tarballs):
            assert hashlib.sha256(package.read_bytes()).hexdigest() == digest, profile
            install = Path(tmp) / profile
            install.mkdir()
            manifest = {"private": True, "dependencies": {
                "@pyric/rules": package.as_uri(),
                "ohm-js": (vendor/"ohm-js-17.5.0.tgz").as_uri(),
                "zod": (vendor/"zod-3.25.76.tgz").as_uri(),
            }}
            (install/"package.json").write_text(json.dumps(manifest))
            subprocess.run(["npm", "install", "--offline", "--ignore-scripts", "--no-fund", "--no-audit",
                            "--cache", str(install/"cache")], cwd=install, check=True, stdout=subprocess.DEVNULL)
            scores = {}
            for revision, source_sha in SOURCES.items():
                arm = revision.split("/")[0]
                if profile not in (arm, "reviewed"):
                    continue
                result = subprocess.run(["bun", HERE.parent/"author-score.mjs", corpus,
                                         HERE/(revision+".policy"), source_sha, install/"node_modules/@pyric/rules",
                                         "module" if arm == "current" else "function"], capture_output=True, text=True)
                if result.returncode not in (0, 1) or not result.stdout:
                    raise RuntimeError(result.stderr)
                scores[revision] = json.loads(result.stdout)
                assert (result.returncode == 0) == (scores[revision]["matches"] == scores[revision]["cases"])
            results[profile] = {"packageSha256": digest, "scores": scores}
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
