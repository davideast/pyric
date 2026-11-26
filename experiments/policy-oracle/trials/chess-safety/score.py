"""Score an offline compiler package against frozen chess safety and signed-admission answers."""
import argparse
import base64
from collections import Counter
import json
from pathlib import Path
import subprocess
import sys

sys.dont_write_bytecode = True
from corpus import BATCHES, HERE, load

ROOT = HERE.parents[1]
REL = str(HERE.relative_to(ROOT))
sys.path.insert(0, str(ROOT / "core"))
import oracle
from candidate import MAX_PACKAGE
from offline_runtime import side

MODULES = "/oracle/arcade/runtime/node_modules"
PKG = MODULES + "/@pyric/rules"
REFERENCE = "67087040f9e1206c54660563a27329d4b5db22102229af8f11b8ccb68ea87743"
QUALIFIED = HERE.parent / "ordered-guards/vendor/pyric-rules-ordered-guards.tgz"


def chunks(payload):
    data = base64.b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode()
    return [data[i:i+30000] for i in range(0, len(data), 30000)]


def task(script, args):
    return {"engine": "bun", "runner": "/oracle/" + REL + "/" + script, "args": args}


def score_rows(cases, predictions, field, failure=None):
    result = []
    for index, c in enumerate(cases):
        p = predictions[index] if predictions else {}
        truth = "ALLOW" if c[field] else "DENY"
        row = {"id": c["id"], "expected": truth}
        error = failure or p.get("error")
        if failure:
            status = failure
        elif error:
            status = "evaluation-error" if field == "nativeAdmission" else "standalone-error"
            if error in ("resource-limit", "rule-error") and p.get("decision") == "DENY" and c[field]:
                status = "false-refusal"
        else:
            decision = p.get("decision")
            if decision not in ("ALLOW", "DENY"):
                status = "invalid-result"
            else:
                status = "match" if decision == truth else ("false-allow" if decision == "ALLOW" else "false-refusal")
        row.update({k:v for k,v in p.items() if k in ("decision","cost","error","detail")})
        row["status"] = status
        result.append(row)
    return result


def task_output(result, key):
    if "installError" in result:
        return {}, result["installError"]
    item = result["tasks"][key]
    return item.get("output"), item.get("error")


def summarize(rows):
    return {"counts": dict(Counter(r["status"] for r in rows)), "cases": len(rows),
            "firstDivergence": next((r for r in rows if r["status"] != "match"), None)}


def validated_modules(modules):
    if not isinstance(modules,dict) or not modules:
        return "missing module map"
    if any(not isinstance(v,str) or not v.strip() for v in modules.values()):
        return "module is empty or not text"
    try:
        if sum(len(v.encode()) for v in modules.values()) > 1024 * 1024:
            return "emitted modules exceed isolated linker input budget"
    except UnicodeEncodeError:
        return "invalid UTF-8 module"
    return None


def score(package, through, variant, save_artifact=None, board_policy=False):
    cases, cohorts, requests = load(through)
    with package.open("rb") as stream:
        submitted = stream.read(MAX_PACKAGE+1)
    oracle.require(len(submitted)<=MAX_PACKAGE,"candidate exceeds package size limit")
    ref = (ROOT / "arcade/vendor/pyric-rules-0.1.0.tgz").read_bytes()
    oracle.require(oracle.sha(ref)==REFERENCE,"independent evaluator changed")
    inputs = [{k:r[k] for k in ("resource","data")} for r in requests]
    files = {REL+"/consumer.mjs", REL+"/policy","trials/king-safety/policy/public-api.mjs",
             "trials/king-safety/policy/horizontal-path.policy"}
    terminal_files = {REL+"/terminal/v1/"+f for f in ("policy.mjs","geometry.mjs","compact.mjs","reply.mjs")}
    terminal_files.update({REL+"/terminal/table-v2/"+f for f in ("policy.mjs","endings.mjs")})
    files.update(terminal_files)
    tasks = {"emit":task("consumer.mjs", ["emit",variant,PKG]),
             "standalone":task("consumer.mjs", ["standalone",variant,PKG,*chunks(inputs)])}
    if board_policy:
        projections = json.loads(subprocess.check_output(["bun", HERE / "board-inputs.mjs"], input=json.dumps(requests).encode()))
        tasks["board"] = task("standalone-board.mjs", [PKG,*chunks(projections)])
        files.update({REL+"/standalone-board.mjs","trials/chess/policies/chess.policy"})
    candidate = side(ROOT,submitted,tasks,reference=False,timeout=180,pinned_paths=files)
    predictions, se = task_output(candidate,"standalone")
    if not se and (not isinstance(predictions,list) or len(predictions)!=len(cases)
                   or any(not isinstance(p,dict) or p.get("i")!=i for i,p in enumerate(predictions))):
        se = "candidate returned an incomplete or reordered standalone array"
    standalone = score_rows(cases,None if se else predictions,"kingSafe",
                            ("install-error" if "installError" in candidate else "standalone-error") if se else None)
    modules, ce = task_output(candidate,"emit")
    ce = ce or validated_modules(modules)
    diagnostics = {k:v for k,v in {"standalone":se,"compile":ce}.items() if v}
    linked = []
    digest = None
    if ce:
        linked = score_rows(cases,None,"nativeAdmission","install-error" if "installError" in candidate else "cannot-compile")
    else:
        evaluator="evaluator.mjs"
        expected_ids=[c["id"] for c in cases]
        # Chunk by cohort of requests to stay inside the system argument limit even for large boards.
        groups=[requests[i:i+24] for i in range(0,len(requests),24)]
        stages={str(i):task(evaluator,[MODULES,*chunks({"modules":modules,"variant":variant,"requests":g,
                     "returnSource":save_artifact is not None and i==0})]) for i,g in enumerate(groups)}
        vf={REL+"/"+evaluator, REL+"/policy", "trials/king-safety/policy", "trials/chess/bundle/artifacts",
            "trials/sokoban-repair/v1/tictactoe.stock.rules"}
        judged=side(ROOT,ref,stages,reference=False,timeout=240,pinned_paths=vf|terminal_files)
        rows=[]
        for i,group in enumerate(groups):
            out,err=task_output(judged,str(i))
            if err:
                diagnostics["link"]=err
                break
            if not isinstance(out,dict) or not isinstance(out.get("rows"),list):
                raise ValueError("trusted evaluator returned incomplete results")
            if digest and digest!=out["sha256"]:
                raise ValueError("linked Rules differ between chunks")
            digest=out["sha256"]
            if save_artifact and i==0:
                source=out["source"].encode()
                oracle.require(oracle.sha(source)==digest,"linked Rules digest mismatch")
                save_artifact.write_bytes(source)
            rows.extend(out["rows"])
        if "link" in diagnostics:
            linked=score_rows(cases,None,"nativeAdmission","link-error")
        else:
            oracle.require([r["id"] for r in rows]==expected_ids,"trusted evaluator reordered cases")
            linked=score_rows(cases,rows,"nativeAdmission")
    batches={}
    for name,ids in cohorts.items():
        chosen=set(ids)
        batches[name]={plane:summarize([r for r in rows if r["id"] in chosen])
            for plane,rows in [("kingSafety",standalone),("linkedWrites",linked)]}
    additional = {}
    if board_policy:
        board, error = task_output(candidate, "board")
        if not error and (not isinstance(board, list) or len(board) != len(cases)
                          or any(not isinstance(p, dict) or p.get("i") != i for i, p in enumerate(board))):
            error = "incomplete standalone board response"
        if error:
            diagnostics["boardPolicy"] = error
        verdicts = score_rows(cases, None if error else board, "nativeAdmission", "standalone-error" if error else None)
        for name, ids in cohorts.items():
            batches[name]["standaloneBoard"] = summarize([r for r in verdicts if r["id"] in ids])
        additional["standaloneBoard"] = verdicts
    return {**additional,"candidateSha256":oracle.sha(submitted),"variant":variant,"referenceSha256":REFERENCE,
            "linkedRulesSha256":digest,"diagnostics":diagnostics,"batches":batches,
            "kingSafety":standalone,"linkedWrites":linked,
            "passed":all(r["status"]=="match" for r in standalone+linked+additional.get("standaloneBoard",[]))}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--candidate-package",type=Path,required=True)
    p.add_argument("--through",type=int,choices=range(8),default=7)
    p.add_argument("--variant",default="optimized")
    p.add_argument("--save-rules",type=Path,help="save independently linked source for review")
    p.add_argument("--board-policy",action="store_true",help="also derive full move legality, successor and terminal outcome via the public bounded-module API")
    p.add_argument("--with-live",action="store_true",help="look up retained measurements of these exact Rules bytes")
    args=p.parse_args()
    try:
        out=score(args.candidate_package,args.through,args.variant,args.save_rules,args.board_policy)
        if args.with_live:
            digest=out["linkedRulesSha256"]
            out["hosted"]=(json.loads(subprocess.check_output(["bun",HERE/"live/run.mjs","lookup",digest]))
                           if digest else {"status":"unmeasured","rulesSha256":None,"captures":[]})
    except (ValueError,OSError,subprocess.CalledProcessError) as error:
        out={"passed":False,"infrastructureError":str(error)}
    print(json.dumps(out,indent=2))
    return int(not out["passed"])


if __name__=="__main__":
    sys.exit(main())
