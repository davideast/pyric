"""Build the table lookup compiler from the independently pinned split-enabled candidate."""
import gzip
import hashlib
import io
from pathlib import Path
import sys
import tarfile

INPUT_SHA="08264e4f646a5753af5fe62f424e150ea244540dc7eaf082f62577272ebe88ad"
TARGETS={"package/src/policy/index.ts","package/dist/policy/index.js"}


def build(input_file,output):
    if hashlib.sha256(input_file.read_bytes()).hexdigest()!=INPUT_SHA:
        raise ValueError("unexpected split-enabled package")
    edited=set()
    with tarfile.open(input_file,"r:gz") as src, output.open("wb") as raw:
        with gzip.GzipFile(filename="",fileobj=raw,mode="wb",mtime=0,compresslevel=9) as z:
            with tarfile.open(fileobj=z,mode="w|",format=tarfile.GNU_FORMAT) as dest:
                for member in src:
                    data=src.extractfile(member).read() if member.isfile() else None
                    if member.name in TARGETS:
                        indent="    " if member.name.endswith(".ts") else "        "
                        marker=(indent+"case 'bracketAccess':").encode()
                        assert data.count(marker)==1
                        extra="""case 'sliceAccess':
  if (!functionCollections || !expr.start || !expr.end) break;
  visit(expr.object); visit(expr.start); visit(expr.end); return;
case 'functionCall':
  if (!functionCollections || expr.name !== 'int' || expr.args.length !== 1) break;
  return visit(expr.args[0]);"""
                        replacement="\n".join(indent+line for line in extra.splitlines()).encode()+b"\n"+marker
                        data=data.replace(marker,replacement)
                        member.size=len(data)
                        edited.add(member.name)
                    dest.addfile(member, io.BytesIO(data) if data is not None else None)
    assert edited==TARGETS


if __name__=="__main__":
    build(Path(sys.argv[1]),Path(sys.argv[2]))
