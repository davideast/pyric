"""Verify the installed independent evaluator and its two runtime dependencies."""
import hashlib
from pathlib import Path
import runpy
import sys
import tarfile

sys.dont_write_bytecode = True
pins = runpy.run_path(str(Path(__file__).resolve().parents[3] / "for-of/replay.py"))
rules = Path(sys.argv[1]).resolve()
modules = rules.parent.parent
for installed, package in [(rules, "pyric-rules-0.1.0.tgz"),
                           (modules / "ohm-js", "ohm-js-17.5.0.tgz"),
                           (modules / "zod", "zod-3.25.76.tgz")]:
    archive = pins["VENDOR"] / package
    if hashlib.sha256(archive.read_bytes()).hexdigest() != pins["PINS"][package]:
        raise ValueError(f"Changed referee archive: {package}")
    with tarfile.open(archive) as tar:
        files = {m.name.removeprefix("package/"): m for m in tar if m.isfile()}
        actual = {p.relative_to(installed).as_posix() for p in installed.rglob("*") if p.is_file()}
        if actual != set(files):
            raise ValueError(f"Different installed files in {package}")
        for name, entry in files.items():
            if (installed / name).read_bytes() != tar.extractfile(entry).read():
                raise ValueError(f"Installed referee bytes differ from pinned archive: {package} {name}")
