"""Check compiler diagnostics and independence using disposable public packages."""
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile

sys.dont_write_bytecode = True
from score import score

SOURCE = """
export function compileFunction(source) {
  const signature=source.match(/function ([A-Za-z][A-Za-z0-9_]*)\\(([^)]*)\\)/);
  if (!signature) throw Error('control expected a function');
  const [_,name,args]=signature;
  const locate=name==='locateKing';
  const execute=() => { RUNTIME };
  execute.firestoreModule=() => {
    EMITTER
  };
  return execute;
}
"""
EMIT = """return "rules_version = '2+modules';\\nexport function "+name+"("+args+") { return "+(locate?'0':PREDICATE)+"; }";"""


def pack(target, manifest, source):
    with tarfile.open(target, "w:gz") as archive:
        for name, value in [("package.json", json.dumps(manifest)), ("index.mjs", source)]:
            data = value.encode()
            entry = tarfile.TarInfo("package/" + name)
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))


def main():
    answers = []
    controls = [
        ("always-allow", "return locate?0:true", EMIT.replace("PREDICATE","'true'"), "false-allow", "false-allow"),
        ("always-deny", "return locate?0:false", EMIT.replace("PREDICATE","'false'"), "false-refusal", "false-refusal"),
        ("standalone-throws", "throw Error('runtime control')", EMIT.replace("PREDICATE","'true'"), "standalone-error","false-allow"),
        ("cannot-compile", "return locate?0:true", "throw Error('unsupported emission')", "false-allow", "cannot-compile"),
        ("malformed-rules", "return locate?0:true", "return 'not a Rules module'", "false-allow","link-error"),
        ("wrong-package", "return true", "return ''", "install-error","install-error"),
    ]
    with tempfile.TemporaryDirectory(prefix="chess-oracle-controls-") as temp:
        for name,runtime,emitter,standalone,linked in controls:
            target = Path(temp)/(name+".tgz")
            manifest = {"name":"bad-name" if name=="wrong-package" else "@pyric/rules","type":"module",
                        "version":"0.0.0","exports":{"./experimental/policy":{"default":"./index.mjs"}}}
            pack(target,manifest,SOURCE.replace("RUNTIME",runtime).replace("EMITTER",emitter))
            report=score(target,1,"pins")
            first = [next(r for r in report[p] if r["status"]!="match") for p in ["kingSafety","linkedWrites"]]
            assert [r["status"] for r in first]==[standalone,linked], (name,first,report["diagnostics"])
            assert not report["passed"]
            answers.append({"control":name,"kingSafety":first[0]["status"],"firstKingCase":first[0]["id"],
                            "linkedWrites":first[1]["status"],"firstWrite":first[1]["id"]})
    print(json.dumps(answers,indent=2))


if __name__ == "__main__":
    main()
