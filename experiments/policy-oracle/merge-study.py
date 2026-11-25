"""Rehearse concurrent oracle contributions using real Git trees and synthetic evidence."""
import argparse
import hashlib
import itertools
import json
import random
import subprocess
import tempfile
from pathlib import Path

# Two probes for one Tally claim, two probes for one tic-tac-toe claim,
# and independent claims both within the same game and across games.
LANES = [
    ("satisfy/tally", "ordered-fold", "strike-then-erase"),
    ("satisfy/tally", "ordered-fold", "erase-then-strike"),
    ("arcade/tictactoe", "relative-increment", "from-four"),
    ("arcade/tictactoe", "relative-increment", "wrong-turn"),
    ("arcade/tictactoe", "turn-ownership", "host-only"),
    ("arcade/uno", "draw", "stock-draw"),
    ("arcade/uno", "play", "stock-play"),
    ("arcade/reversi", "pass", "stock-pass"),
    ("arcade/reversi", "move", "stock-move"),
    ("arcade/sokoban", "score-improve", "lower-count"),
    ("arcade/battleship", "shot", "stock-shot"),
    ("arcade/checkers", "move", "stock-move"),
]


def encode(data):
    return (json.dumps(data, indent=2, sort_keys=True) + "\n").encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


class Repo:
    def __init__(self, directory):
        directory.mkdir()
        self.path = directory
        self.git("init", "--quiet", "-b", "base")
        self.git("config", "user.name", "Oracle merge study")
        self.git("config", "user.email", "oracle@example.invalid")
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "core.hooksPath", "/dev/null")

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.path, text=True).strip()

    def put(self, path, data):
        target = self.path / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(encode(data))

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "--quiet", "-m", message)
        return self.git("rev-parse", "HEAD")

    def branch(self, name, base):
        self.git("switch", "--quiet", "-c", name, base)

    def merge_tree(self, left, right):
        run = subprocess.run(["git", "merge-tree", "--write-tree", left, right],
                             cwd=self.path, capture_output=True, text=True)
        if run.returncode not in (0, 1):
            raise RuntimeError(run.stderr)
        return run.returncode, run.stdout.splitlines()[0]

    def integrate(self, base, branches):
        head = base
        for branch in branches:
            status, tree = self.merge_tree(head, branch)
            assert status == 0, (head, branch)
            head = self.git("commit-tree", tree, "-p", head, "-p", branch, "-m", "study merge")
        return head


def folder(lane):
    suite, claim, probe = lane
    return f"suites/{suite}/claims/{claim}/v1/probes/{probe}/v1"


def index_path(layout, suite, claim):
    if layout == "one-index":
        return "catalog.json"
    if layout == "per-game":
        return f"suites/{suite}/catalog.json"
    if layout == "per-claim":
        return f"suites/{suite}/claims/{claim}/v1/catalog.json"
    return None


def records(repo, ref, combined):
    """Validate the miniature evidence graph, separate from whether Git merged."""
    paths = repo.git("ls-tree", "-r", "--name-only", ref).splitlines()
    recipes = {path[:-len("/recipe.json")]:repo.git("show", ref+":"+path)+"\n"
               for path in paths if path.endswith("/recipe.json")}
    assert set(recipes) == {folder(lane) for lane in combined}, "missing or extra probe"
    observed = {}
    for path in paths:
        if "/observations/" not in path:
            continue
        parent = path.rsplit("/observations/", 1)[0]
        receipt = json.loads(repo.git("show", ref+":"+path))
        if receipt["recipeSha256"] != digest(recipes[parent].encode()):
            raise ValueError("stale-recipe")
        observed.setdefault(parent, set()).add(receipt["verdict"])
    assert set(observed) == set(recipes)
    if any(len(answers) != 1 for answers in observed.values()):
        raise ValueError("disputed")
    return len({p.split("/probes/")[0] for p in observed}), len(observed)


def run(layout, scratch):
    repo = Repo(scratch/layout)
    for suite, claim, probe in LANES:
        owner = f"suites/{suite}/claims/{claim}/v1"
        repo.put(owner+"/claim.json", {"claim":suite+"/"+claim})
        index = index_path(layout, suite, claim)
        if index:
            repo.put(index, {"probes":[]})
    base = repo.commit("common base with reserved claims")
    branches = []
    for i, lane in enumerate(LANES):
        suite, claim, probe = lane
        repo.branch("lane/"+str(i), base)
        root = folder(lane)
        recipe = {"case":probe, "claim":suite+"/"+claim}
        repo.put(root+"/recipe.json", recipe)
        repo.put(root+"/observations/run-a.json", {"recipeSha256":digest(encode(recipe)), "verdict":"allow"})
        index = index_path(layout, suite, claim)
        if index:
            repo.put(index, {"probes":[root]})
        branches.append(repo.commit(probe))
    pairs = list(itertools.combinations(branches, 2))
    conflicts = sum(repo.merge_tree(a,b)[0] for a,b in pairs)
    print(f"{layout}: {len(pairs)-conflicts}/{len(pairs)} clean pairs, {conflicts} conflicted")
    if layout != "discovered":
        return
    rng = random.Random(20261125)
    orders = [branches, list(reversed(branches))]
    orders += [rng.sample(branches, len(branches)) for _ in range(6)]
    heads = [repo.integrate(base, order) for order in orders]
    trees = {repo.git("rev-parse", head+"^{tree}") for head in heads}
    assert len(trees) == 1
    assert records(repo, heads[0], LANES) == (10, 12)
    print("eight full merge orders: one identical Git tree, 10 claims, 12 probes, 12 observations")

    # Two independent branches from the same already-evidenced catalog.
    # Both merge cleanly even if one records drift or the other edits an input.
    head = heads[0]
    root = folder(LANES[0])
    original = json.loads(repo.git("show", head+":"+root+"/observations/run-a.json"))
    refs = {}
    for label in ["repeat", "different", "changed-input"]:
        repo.branch(label, head)
        if label == "changed-input":
            repo.put(root+"/recipe.json", {"case":"changed after freeze"})
        else:
            answer = dict(original)
            if label == "different":
                answer["verdict"] = "deny"
            repo.put(root+f"/observations/{label}.json", answer)
        refs[label] = repo.commit(label)
    assert records(repo, refs["repeat"], LANES) == (10, 12)
    for label, error in [("different", "disputed"), ("changed-input", "stale-recipe")]:
        merged = repo.integrate(head,[refs["repeat"],refs[label]])
        try:
            records(repo, merged, LANES)
        except ValueError as exc:
            assert str(exc) == error
        else:
            raise AssertionError("failed to detect "+error)
        print(f"repeat + {label}: Git clean, miniature evidence validator reported {error}")
    print("identical repeat: no extra claims or probes credited")
    definitions = []
    for owner, contract in [("first", "admit at equality"), ("second", "refuse at equality")]:
        repo.branch("definition/"+owner, head)
        repo.put("suites/example/test/claims/threshold/v1/claim.json", {"meaning":contract})
        definitions.append(repo.commit("define threshold"))
    assert repo.merge_tree(*definitions)[0] == 1
    print("incompatible definitions of the same versioned claim: Git reported a conflict")


if __name__ == "__main__":
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("--scratch-parent", type=Path, default=None)
    opts = args.parse_args()
    scratch = Path(tempfile.mkdtemp(prefix="pyric-oracle-merge-study-", dir=opts.scratch_parent))
    print("Isolated study repositories:", scratch)
    for layout in ("one-index", "per-game", "per-claim", "discovered"):
        run(layout, scratch)
