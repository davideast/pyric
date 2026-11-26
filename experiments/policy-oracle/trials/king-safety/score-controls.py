"""Exercise the package scorer with constructed compilers of known behavior."""
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent


def compiler_tar(output, *, runtime, emitted):
    manifest = {"name": "@pyric/rules", "type":"module", "version":"0.0.0",
                "exports":{"./experimental/policy":{"import":"./index.mjs"}}}
    source = f"""export function compileFunction() {{
  const invoke = () => {{ {runtime} }};
  invoke.firestoreModule = () => {{ {emitted} }};
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
        ("allow", "return true", emit("true"), "false-allow", "false-allow", "rook-exposed"),
        ("deny", "return false", emit("false"), "false-refusal", "false-refusal", "rook-safe"),
        ("cannot-emit", "return true", "throw Error('unsupported target')",
         "false-allow", "cannot-compile", "rook-safe"),
        ("standalone-error", "throw Error('unsupported policy input')", emit("true"),
         "standalone-error", "false-allow", "rook-exposed"),
    ]
    rows = []
    with tempfile.TemporaryDirectory(prefix="king-score-controls-") as temp:
        for name, runtime, code, standalone, expected, first in controls:
            archive = Path(temp) / (name + ".tgz")
            compiler_tar(archive, runtime=runtime, emitted=code)
            result = subprocess.run([sys.executable, HERE/"score.py", "--candidate-package", archive], capture_output=True)
            assert result.returncode == 1, (name, result)
            score = json.loads(result.stdout)
            assert score["standalone"]["firstDivergence"]["status"] == standalone, score
            row = score["linkedRules"]["firstDivergence"]
            assert (row["status"], row["id"]) == (expected, first), score
            rows.append({"control":name, "standaloneFirst":standalone, "linkedFirst":expected, "linkedCase":first})
    print(json.dumps(rows, indent=2))


if __name__ == "__main__":
    main()
