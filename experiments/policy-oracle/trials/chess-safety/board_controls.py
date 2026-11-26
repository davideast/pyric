"""Ensure malformed public board implementations cannot earn credit by returning a denial."""
import json
from pathlib import Path
import sys
import tempfile

sys.dont_write_bytecode = True
from controls import SOURCE, EMIT, pack
from score import score


def main():
    results=[]
    helpers=SOURCE.replace('RUNTIME','return locate?0:true').replace('EMITTER',EMIT.replace('PREDICATE',"'true'"))
    manifest={'name':'@pyric/rules','version':'0.0.0','type':'module','exports':{'./experimental/policy':{'default':'./index.mjs'}}}
    for label,board in [('string-move-list',"export const legalMoves=()=> 'no moves', apply=()=>null, outcome=()=> 'playing';"),
                        ('missing-apply',"export const legalMoves=()=> [], outcome=()=> 'playing';"),
                        ('duplicate-move',"export const legalMoves=()=> ['a1a2','a1a2'], apply=()=>null, outcome=()=> 'playing';")]:
        with tempfile.TemporaryDirectory(prefix='board-output-shape-') as temp:
            path=Path(temp)/'package.tgz'
            program=helpers+'\nexport function compileBoundedModule(){return {moduleSource:'+json.dumps(board)+'}}'
            pack(path,manifest,program)
            report=score(path,0,'pins',board_policy=True)
            verdicts=report['standaloneBoard']
            if len(verdicts)!=10 or any(r['status']!='standalone-error' for r in verdicts):
                raise ValueError('Malformed board program earned credit: '+label)
            results.append({'control':label,'cases':len(verdicts),'classified':'standalone-error'})
    print(json.dumps(results,indent=2))

if __name__=='__main__': main()
