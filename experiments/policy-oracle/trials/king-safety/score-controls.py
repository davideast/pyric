"""Exercise the package scorer with constructed compilers of known behavior."""
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent


def compiler_tar(output, *, runtime, emitted, export_target):
    manifest = {"name": "@pyric/rules", "type":"module", "version":"0.0.0",
                "exports":{"./experimental/policy":export_target}}
    source = f"""export function compileFunction(source) {{
  const invoke = () => {{ {runtime} }};
  invoke.firestoreModule = () => {{
    if (source.includes('function horizontalPathClear(')) return "rules_version = '2+modules';\\nexport function horizontalPathClear(board,rank,x,toX) {{ return true; }}";
    {emitted}
  }};
  return invoke;
}}"""
    with tarfile.open(output, "w:gz") as archive:
        for name, contents in [("index.mjs", source), ("package.json", json.dumps(manifest))]:
            raw = contents.encode()
            info = tarfile.TarInfo("package/" + name)
            info.size = len(raw)
            archive.addfile(info, io.BytesIO(raw))


def emit(boolean):
    module = "rules_version = '2+modules';\nexport function fileSafe(board,file,color) { return " + boolean + "; }"
    return "return " + json.dumps(module)


def main():
    controls = [
        ("allow", "./index.mjs", "return true", emit("true"), "false-allow", "false-allow", "rook-exposed"),
        ("deny", {"default":"./index.mjs"}, "return false", emit("false"), "false-refusal", "false-refusal", "rook-safe"),
        ("cannot-emit", {"import":"./index.mjs"}, "return true", "throw Error('unsupported target')",
         "false-allow", "cannot-compile", "rook-safe"),
        ("standalone-error", {"bun":"./index.mjs", "default":"./missing.mjs"}, "throw Error('unsupported policy input')", emit("true"),
         "standalone-error", "false-allow", "rook-exposed"),
        ("invalid-module-text", "./index.mjs", "return true", emit(chr(0xD800)),
         "false-allow", "cannot-compile", "rook-safe"),
        ("rules-error", {"import":{"default":"./index.mjs"}}, "return true", emit("board['absent'] == 'wk'"),
         "false-allow", "false-refusal", "rook-safe"),
    ]
    rows = []
    with tempfile.TemporaryDirectory(prefix="king-score-controls-") as temp:
        for name, export_target, runtime, code, standalone, expected, first in controls:
            archive = Path(temp) / (name + ".tgz")
            compiler_tar(archive, runtime=runtime, emitted=code, export_target=export_target)
            result = subprocess.run([sys.executable, HERE/"score.py", "--candidate-package", archive], capture_output=True)
            assert result.returncode == 1, (name, result)
            score = json.loads(result.stdout)
            assert sum(len(c["cases"]) for c in score["cohorts"].values()) == 10
            assert score["standalone"]["firstDivergence"]["status"] == standalone, score
            row = score["linkedRules"]["firstDivergence"]
            assert (row["status"], row["id"]) == (expected, first), score
            path_ids = score["cohorts"]["pathControls"]["cases"]
            path_outcomes = [r["status"] for r in score["linkedRules"]["cases"] if r["id"] in path_ids]
            if name == "allow":
                assert path_outcomes == ["false-allow", "false-allow"], score
            if name == "invalid-module-text":
                assert "invalid UTF-8" in score["compilation"]["diagnostic"], score
            if name == "rules-error":
                exposed = next(r for r in score["linkedRules"]["cases"] if r["id"] == "rook-exposed")
                assert exposed["status"] == "evaluation-error" and exposed["cause"] == "rule-error", exposed
            rows.append({"control":name, "exportsTarget":export_target, "standaloneFirst":standalone, "linkedFirst":expected,
                         "linkedCase":first,"pathOutcomes":path_outcomes})
    print(json.dumps(rows, indent=2))


if __name__ == "__main__":
    main()
