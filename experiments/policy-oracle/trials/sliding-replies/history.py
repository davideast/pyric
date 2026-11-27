"""Immutable local observations for each candidate source, independent of later hosted receipts."""
import json
from pathlib import Path
from campaign_corpus import digest

def projection(result):
    data={k:result[k] for k in ('variant','through','packageSha256','requestSha256','nativeSha256','compile')}
    replies=result['standalone']
    data['standalone']={'positions':replies['distinctPositions'],'proposals':replies['eligibleRequests'],
                        'outcomes':replies['outcomes'],'replyRowsSha256':digest(replies['positions'])}
    local=result.get('local')
    if local and 'rows' in local:
        data['local']={'groups':local['groups'],'changes':local['changes'],
                       'verdictAndCostsSha256':digest(local['rows']),
                       'disagreements':{k:v for k,v in local['rows'].items() if v['status']!='match'}}
    elif local:
        data['local']=local
    return data


def record(result,directory):
    directory.mkdir(exist_ok=True,parents=True)
    path=directory/(result['variant']+'.json')
    measured=projection(result)
    if path.exists():
        if json.loads(path.read_bytes())!=measured:
            raise ValueError('Revision observations changed: '+path.name)
    else:
        with path.open('x') as f:
            f.write(json.dumps(measured,indent=2)+'\n')
    return path
