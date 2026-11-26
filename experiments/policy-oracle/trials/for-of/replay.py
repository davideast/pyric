"""Rebuild and replay the bounded-loop trial with isolated, offline packages."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
VENDOR = HERE.parents[1] / "arcade/vendor"
PINS = {
    "pyric-rules-0.1.0.tgz": "67087040f9e1206c54660563a27329d4b5db22102229af8f11b8ccb68ea87743",
    "arcade-bundler.tgz": "e27fc7d79802dc238ed8513f6653182cf15c962b79291c98b3a742b55accd675",
    "ohm-js-17.5.0.tgz": "233d11842ac70dff9d0a9db7dacb6d370d00073ea879d2ad4202d2ee2acabd61",
    "zod-3.25.76.tgz": "9e1f1a05f0dd0c1dab64ee91ceb9bf55cd44d35368c70edda80a2fdc70a88377",
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def install_rules(package, install):
    install.mkdir()
    deps = {"@pyric/rules": package, "ohm-js": VENDOR / "ohm-js-17.5.0.tgz",
            "zod": VENDOR / "zod-3.25.76.tgz"}
    (install / "package.json").write_text(json.dumps({"private": True, "dependencies": {
        name: "file:" + str(path.resolve()) for name, path in deps.items()
    }}))
    subprocess.run(["npm", "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
                    "--cache", str(install / "cache")], cwd=install, check=True, stdout=subprocess.DEVNULL)
    return install / "node_modules"


def build(package, install, output):
    modules = install_rules(package, install)
    resolver = modules / "arcade-bundler"
    resolver.mkdir()
    subprocess.run(["tar", "--warning=no-unknown-keyword", "-xzf", str(VENDOR / "arcade-bundler.tgz"),
                    "--strip-components=1", "-C", str(resolver)], check=True)
    output.mkdir(parents=True, exist_ok=True)
    subprocess.run(["bun", HERE / "evaluate.mjs", modules / "@pyric/rules",
                    resolver / "dist/rules/modules/resolver.js", output], check=True)
    floor = HERE.parent / "floor-boost/v1"
    generated_floor = install / "floor"
    subprocess.run(["bun", floor / "generate.mjs", modules / "@pyric/rules", generated_floor], check=True)
    for name in ["timer.rules", "fixture.json", "placement.json"]:
        if (generated_floor / name).read_bytes() != (floor / "artifacts" / name).read_bytes():
            raise ValueError(f"Floor boost regression: {name}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", type=Path, metavar="CANDIDATE_TGZ", help="evaluate an alternate package")
    parser.add_argument("--output", type=Path, help="retain candidate outputs for inspection")
    parser.add_argument("--controller", type=Path, help="also authenticate the original private live journals")
    parser.add_argument("--baselines", type=Path, metavar="ARCADE_CHECKOUT", help="also rerun the existing campaign suites")
    args = parser.parse_args()
    if bool(args.build) != bool(args.output):
        parser.error("--build and --output are used together")
    if args.baselines and not args.controller:
        parser.error("--baselines requires the independent controller archive via --controller")
    package = args.build or HERE / "vendor/pyric-rules-loops.tgz"
    for name, expected in PINS.items():
        if digest(VENDOR / name) != expected:
            raise ValueError(f"Unexpected dependency digest: {name}")
    if not args.build:
        lock = json.loads((HERE / "lock.json").read_text())
        if digest(package) != lock["package"]:
            raise ValueError("Unexpected qualified compiler")
        for name, expected in lock["evidence"].items():
            if digest(HERE / name) != expected:
                raise ValueError(f"Qualification evidence differs from lock: {name}")
    with tempfile.TemporaryDirectory(prefix="pyric-loop-consumer-") as temp:
        scratch = Path(temp)
        output = args.output.resolve() if args.output else scratch / "out"
        build(package, scratch / "install", output)
        if args.build:
            subprocess.run(["bun", HERE / "reference/score.mjs", output / "results.json"], check=True)
            print(output)
            return
        for name, expected in lock["generated"].items():
            if digest(output / name) != expected or digest(HERE / "artefacts" / name) != expected:
                raise ValueError(f"Generated artefact disagrees with qualification: {name}")
        subprocess.run(["bun", HERE / "reference/score.mjs", output / "results.json"], check=True)
        reference = install_rules(VENDOR / "pyric-rules-0.1.0.tgz", scratch / "reference") / "@pyric/rules"
        archive = args.controller.resolve() if args.controller else "-"
        subprocess.run(["bun", HERE / "live/replay.mjs", output / "generated.rules", reference,
                        archive, output / "ordered-errors.rules"], check=True)
        if args.baselines:
            import baselines
            result = baselines.verify(package, archive, args.baselines.resolve(), reference, output)
            if result != json.loads((HERE / "regressions.json").read_text()):
                raise ValueError("Regression results differ from the qualified campaign")
            print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
