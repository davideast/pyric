"""Derive the isolated pure replace candidate from the qualified join/matches package."""
import argparse
import gzip
import hashlib
import io
from pathlib import Path
import runpy
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
PRECURSOR = '78c88ce6210ca1c83e1b9b5f0d60de7e3d5d8088203cb10f3efac7b451b64ce1'


def build(output):
    upstream = runpy.run_path(str(HERE / '../policy/pack-candidate.py'))
    old = upstream['NEW']
    new = b"(" + old + b" || (name === 'replace' && arity === 2))"
    with tempfile.TemporaryDirectory(prefix='pyric-mobility-') as root:
        source = Path(root)/'packed.tgz'
        upstream['build'](source)
        assert hashlib.sha256(source.read_bytes()).hexdigest() == PRECURSOR
        touched = set()
        with tarfile.open(source, 'r:gz') as src, output.open('wb') as raw:
            with gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0) as zipped:
                with tarfile.open(fileobj=zipped, mode='w|', format=tarfile.GNU_FORMAT) as dest:
                    for member in src:
                        data = src.extractfile(member).read() if member.isfile() else None
                        if member.name in upstream['TARGETS']:
                            assert data.count(old) == 1
                            data = data.replace(old,new)
                            member.size = len(data)
                            touched.add(member.name)
                        dest.addfile(member, io.BytesIO(data) if data is not None else None)
        assert touched == upstream['TARGETS']


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('output', type=Path)
    args = p.parse_args()
    build(args.output)
    print(hashlib.sha256(args.output.read_bytes()).hexdigest())
