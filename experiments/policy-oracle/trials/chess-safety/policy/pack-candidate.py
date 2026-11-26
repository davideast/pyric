"""Derive the pure join/matches experiment tarball from the locked ordered-guard package."""
import argparse
import gzip
import hashlib
import io
from pathlib import Path
import tarfile

HERE = Path(__file__).resolve().parent
BASE = HERE / '../../ordered-guards/vendor/pyric-rules-ordered-guards.tgz'
DIGEST = 'c96a1f08a6808901f14e810bf31564d7f7a0c893126f99d9b8d18747e486a932'
TARGETS = {'package/src/simulator/evaluation-builtins.ts', 'package/dist/simulator/evaluation-builtins.js'}
OLD = b"(name === 'removeAll' && arity === 1)"
NEW = b"((name === 'removeAll' || name === 'join' || name === 'matches') && arity === 1)"


def build(output):
    assert hashlib.sha256(BASE.read_bytes()).hexdigest() == DIGEST
    touched = set()
    with tarfile.open(BASE, 'r:gz') as src, output.open('wb') as raw:
        with gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0, compresslevel=9) as zipped:
            with tarfile.open(fileobj=zipped, mode='w|', format=tarfile.GNU_FORMAT) as dest:
                for member in src:
                    data = src.extractfile(member).read() if member.isfile() else None
                    if member.name in TARGETS:
                        assert data.count(OLD) == 1, member.name
                        data = data.replace(OLD, NEW)
                        member.size = len(data)
                        touched.add(member.name)
                    dest.addfile(member, io.BytesIO(data) if data is not None else None)
    assert touched == TARGETS


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    build(args.output)
    print(hashlib.sha256(args.output.read_bytes()).hexdigest())
