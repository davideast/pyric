"""Rebuild and compare the locked chess rules in isolated, offline package installs."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
VENDOR = HERE.parents[2] / "arcade/vendor"
PINS = {
    "compiler": "3a79e94878d551a292757774f3e39cd2f3d57b15ffec93200807922ae3120fa6",
    "pyric-rules-0.1.0.tgz": "67087040f9e1206c54660563a27329d4b5db22102229af8f11b8ccb68ea87743",
    "arcade-bundler.tgz": "e27fc7d79802dc238ed8513f6653182cf15c962b79291c98b3a742b55accd675",
    "ohm-js-17.5.0.tgz": "233d11842ac70dff9d0a9db7dacb6d370d00073ea879d2ad4202d2ee2acabd61",
    "zod-3.25.76.tgz": "9e1f1a05f0dd0c1dab64ee91ceb9bf55cd44d35368c70edda80a2fdc70a88377",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compiler", type=Path, default=HERE.parent / "policies/vendor/pyric-rules-chess.tgz")
    parser.add_argument("--arcade", required=True, type=Path)
    args = parser.parse_args()
    for name, expected in PINS.items():
        source = args.compiler if name == "compiler" else VENDOR / name
        valid = {expected}
        if name == "compiler":
            valid.add(json.loads((HERE.parent / "policies/lock.json").read_text())["package"])
        if hashlib.sha256(source.read_bytes()).hexdigest() not in valid:
            raise ValueError(f"Unexpected package digest for {name}")
    with tempfile.TemporaryDirectory(prefix="pyric-chess-bundle-") as scratch:
        tmp = Path(scratch)
        for name, package in [("compiler", args.compiler.resolve()), ("reference", VENDOR / "pyric-rules-0.1.0.tgz")]:
            install = tmp / name
            install.mkdir()
            dependencies = {"@pyric/rules": package, "ohm-js": VENDOR / "ohm-js-17.5.0.tgz", "zod": VENDOR / "zod-3.25.76.tgz"}
            (install / "package.json").write_text(json.dumps({"private": True, "dependencies": {
                dep: "file:" + str(path) for dep, path in dependencies.items()
            }}))
            subprocess.run(["npm", "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
                            "--cache", str(tmp / "cache")], check=True, cwd=install, stdout=subprocess.DEVNULL)
        resolver = tmp / "reference/node_modules/arcade-bundler"
        resolver.mkdir()
        subprocess.run(["tar", "--warning=no-unknown-keyword", "-xzf", str(VENDOR / "arcade-bundler.tgz"),
                        "--strip-components=1", "-C", str(resolver)], check=True)
        artifacts = tmp / "artifacts"
        artifacts.mkdir()
        subprocess.run(["bun", str(HERE / "build.mjs"), str(tmp / "compiler/node_modules/@pyric/rules"),
                        str(resolver / "dist/rules/modules/resolver.js"), str(artifacts)], check=True)
        locked = HERE / "artifacts"
        if {p.name:p.read_bytes() for p in artifacts.iterdir()} != {p.name:p.read_bytes() for p in locked.iterdir()}:
            raise ValueError("Rebuilt rules differ from locked artifacts")
        report = subprocess.check_output(["bun", str(HERE / "verify.mjs"), str(args.arcade.resolve()),
                                          str(tmp / "reference/node_modules/@pyric/rules")])
        expected = HERE / "local-results.json"
        if json.loads(report) != json.loads(expected.read_bytes()):
            raise ValueError("Offline verdict or expression report differs from locked evidence")
        summary = json.loads(report)
        print(json.dumps({"artifacts":len(list(artifacts.iterdir())), "cases":summary["cases"],
                          "profiles":summary["profiles"], "peak":summary["peak"]}, indent=2))


if __name__ == "__main__":
    main()
