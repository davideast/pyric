"""Derive the packed candidate with the existing RE2 string split method enabled in pure policy."""
import hashlib
import importlib.util
from pathlib import Path
import sys

sys.dont_write_bytecode=True
script=Path(__file__).resolve().parents[2]/"policy/pack-candidate.py"
spec=importlib.util.spec_from_file_location("packed_candidate",script)
base=importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
base.NEW=base.NEW.replace(b"name === 'matches'",b"name === 'matches' || name === 'split'")
out=Path(sys.argv[1])
base.build(out)
print(hashlib.sha256(out.read_bytes()).hexdigest())
