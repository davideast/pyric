"""Install one rules package offline and run each reviewed probe in a fresh namespace."""

import base64
import hashlib
import json
import resource
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ARCADE = Path("/oracle/arcade")
RULES = "@pyric/rules"
# A read-only /usr supplies Python and the distribution's shared libraries.
# Node and Bun may be user installations. Mount only their executables.
SYSTEM = ["--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
          "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
          "--proc", "/proc", "--dev", "/dev", "--new-session", "--die-with-parent",
          "--unshare-user", "--unshare-pid", "--unshare-uts", "--unshare-ipc", "--clearenv",
          "--setenv", "HOME", "/tmp", "--setenv", "PATH", "/tools:/usr/bin",
          "--setenv", "ORACLE_ROOT", "/oracle", "--setenv", "TMPDIR", "/tmp",
          "--setenv", "BUN_CONFIG_NO_INSTALL", "1", "--setenv", "PYTHONDONTWRITEBYTECODE", "1"]


def side(root, package_bytes, tasks, *, reference, timeout, pinned_paths):
    """Create a private install in tmpfs. Only trusted Python and npm run in this namespace."""
    def executable(name):
        path = shutil.which(name)
        if not path:
            raise ValueError(f"candidate scoring requires {name}")
        return Path(path).resolve()

    # unshare creates an empty network namespace without bringing up even loopback.
    command = [executable("unshare"), "--user", "--map-root-user", "--net", executable("bwrap"), *SYSTEM,
               "--size", str(384 << 20), "--tmpfs", "/tmp", "--dir", "/oracle/arcade/runtime/node_modules",
               "--ro-bind", executable("node"), "/tools/node", "--ro-bind", executable("bun"), "/tools/bun",
               "--ro-bind", executable("npm").parents[1], "/npm",
               "--ro-bind", Path(__file__).resolve(), "/control/worker.py",
               "--ro-bind", Path(__file__).with_name("oracle.py"), "/control/oracle.py"]
    # Bind the reviewed files and stock archive inputs. Installed node_modules, caches, capture controller directories,
    # the invoking user's home and the rest of the checkout never enter the worker.
    archive_inputs = ({"arcade/v1"} if reference else
                      {"arcade/v1/rules", "arcade/v1/manifest.json", "arcade/v1/imports.json"})
    names = {*pinned_paths, *archive_inputs, "arcade/vendor", "arcade/corpus.mjs", "arcade/receipts.mjs",
             "arcade/runtime/score.mjs", "arcade/runtime/replay.mjs",
             "arcade/runtime/package.json", "arcade/runtime/package-lock.json"}
    for name in sorted(names):
        path = Path(name)
        if path.is_absolute() or ".." in path.parts or (root / path).resolve() != root.resolve() / path:
            raise ValueError(f"invalid runtime input: {name}")
        if any(parent.as_posix() in names for parent in Path(name).parents):
            continue
        command.extend(["--ro-bind", root / name, "/oracle/" + name])
    command.extend(["--ro-bind", Path(__file__).with_name("frozen-candidate.mjs"),
                    "/oracle/arcade/runtime/frozen-candidate.mjs"])
    with tempfile.TemporaryFile() as archive:
        archive.write(package_bytes)
        archive.seek(0)
        command.extend(["--ro-bind-data", str(archive.fileno()), "/submitted.tgz",
                        "--", "/usr/bin/python3", "/control/worker.py"])
        try:
            process = subprocess.run(command, input=json.dumps({"tasks": tasks, "timeout": timeout}), text=True,
                                     capture_output=True, env={}, pass_fds=[archive.fileno()],
                                     timeout=timeout * (len(tasks) + 2) + 60)
        except subprocess.TimeoutExpired:
            raise ValueError("offline package runtime timed out") from None
    if process.returncode:
        raise ValueError(f"offline runtime failed: {process.stderr[-2500:]}")
    return json.loads(process.stdout)


def candidate_manifest(archive):
    found = None
    size = 0
    seen = set()
    with tarfile.open(archive, "r|gz") as tar:
        for member in tar:
            parts = member.name.split("/")
            if (parts[0] != "package" or any(p in ("", ".", "..", "node_modules") for p in parts)
                    or not (member.isdir() or member.isfile()) or member.name in seen):
                raise ValueError("candidate must contain only unique package files and directories")
            seen.add(member.name)
            size += member.size
            if size > 128 << 20 or len(seen) > 16000:
                raise ValueError("candidate exceeds unpacked package limits")
            if member.name == "package/package.json" and member.isfile():
                found = json.load(tar.extractfile(member))
    if not isinstance(found, dict) or found.get("name") != RULES or not found.get("version"):
        raise ValueError("expected a packed @pyric/rules package with a version")
    if found.get("bundledDependencies") or found.get("bundleDependencies"):
        raise ValueError("bundled dependencies would replace frozen dependencies")
    return found


def install():
    runtime = Path("/tmp/install/runtime")
    runtime.mkdir(parents=True)
    (runtime.parent / "vendor").symlink_to(ARCADE / "vendor")
    package = json.loads((ARCADE / "runtime/package.json").read_bytes())
    lock = json.loads((ARCADE / "runtime/package-lock.json").read_bytes())
    candidate = Path("/submitted.tgz")
    manifest = candidate_manifest(candidate)
    spec = "file:/submitted.tgz"
    package["dependencies"][RULES] = spec
    lock["packages"][""]["dependencies"][RULES] = spec
    info = {"version": manifest["version"], "resolved": spec, "integrity": "sha512-" +
            base64.b64encode(hashlib.sha512(candidate.read_bytes()).digest()).decode()}
    for key in ("dependencies", "optionalDependencies", "peerDependencies"):
        if key in manifest:
            if not set(manifest[key]) <= (package["dependencies"].keys() - {RULES}):
                raise ValueError("candidate requires dependencies outside the frozen runtime")
            info[key] = manifest[key]
    lock["packages"]["node_modules/" + RULES] = info
    (runtime / "package.json").write_text(json.dumps(package))
    (runtime / "package-lock.json").write_text(json.dumps(lock))
    npm = ["/tools/node", "/npm/bin/npm-cli.js"]
    for args in (["ci", "--offline", "--ignore-scripts", "--no-bin-links", "--no-audit", "--no-fund"],
                 ["ls", "--all", "--offline", "--json"]):
        result = subprocess.run([*npm, *args], cwd=runtime, text=True, capture_output=True, timeout=90)
        if result.returncode:
            raise ValueError(f"cannot install with frozen dependencies: {result.stderr[-1000:]}")
    modules = runtime / "node_modules"
    if any(modules.rglob("node_modules")):
        raise ValueError("candidate installed an additional dependency tree")
    # This vendored resolver is outside the original npm lock, as in arcade/replay.
    bundler = ARCADE / "vendor/arcade-bundler.tgz"
    if hashlib.sha256(bundler.read_bytes()).hexdigest() != "e27fc7d79802dc238ed8513f6653182cf15c962b79291c98b3a742b55accd675":
        raise ValueError("frozen bundler digest changed")
    destination = modules / "arcade-bundler"
    destination.mkdir()
    subprocess.run(["tar", "--no-same-owner", "--warning=no-unknown-keyword", "-xzf", bundler, "--strip-components=1",
                    "-C", destination], check=True)
    return modules


def output_limit():
    resource.setrlimit(resource.RLIMIT_FSIZE, (4 << 20, 4 << 20))


def run_task(task, modules, timeout):
    # Drop setup capabilities. Each probe sees its install and inputs read-only, has
    # its own PID namespace and tmpfs, and inherits the empty network namespace.
    from oracle import parse

    runner = Path(task["runner"])
    command = ["bwrap", *SYSTEM, "--disable-userns", "--cap-drop", "ALL",
               "--ro-bind", "/tools", "/tools", "--ro-bind", "/oracle", "/oracle",
               "--ro-bind", modules, "/oracle/arcade/runtime/node_modules",
               "--size", str(32 << 20), "--tmpfs", "/tmp", "--chdir", runner.parent,
               "--", task["engine"], runner, *task.get("args", [])]
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        try:
            result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                    timeout=timeout, preexec_fn=output_limit)
        except subprocess.TimeoutExpired:
            raise ValueError(f"timeout running {runner}") from None
        if result.returncode:
            stderr.seek(0)
            return {"error": stderr.read().decode(errors="replace")[-1200:] or f"exit {result.returncode}"}
        stdout.seek(0)
        try:
            return {"output": parse(stdout.read())}
        except (ValueError, UnicodeError):
            return {"error": "runner did not return one JSON result"}


def main():
    job = json.load(sys.stdin)
    try:
        modules = install()
    except (ValueError, KeyError, TypeError, OSError, tarfile.TarError, EOFError) as error:
        print(json.dumps({"installError": str(error)}))
        return
    outputs = {key: run_task(task, modules, job["timeout"]) for key, task in job["tasks"].items()}
    print(json.dumps({"tasks": outputs}))


if __name__ == "__main__":
    main()
