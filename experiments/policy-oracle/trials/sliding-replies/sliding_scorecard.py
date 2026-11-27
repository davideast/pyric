"""Render a scored compiler run, preserving the provenance of each verdict."""
from campaign_corpus import HERE, FAMILIES, read


def table(headers, rows):
    lines = ['| ' + ' | '.join(headers) + ' |', '| ' + ' | '.join('---' for _ in headers) + ' |']
    return '\n'.join(lines + ['| ' + ' | '.join(map(str, row)) + ' |' for row in rows])


def render(result):
    groups = result['groups']
    compiled = result['compile']
    local = result.get('local', {}).get('rows', {})
    live = result['live']
    observed = {row['id']: row for row in live.get('rows', [])}
    standalone = result['standalone']
    native_verdicts = result.get('nativeVerdicts') or {k:r['native'] for k,r in local.items()}
    output = [f"# Sliding reply scorecard for `{result['variant']}`",
              f"Compiler package `{result['packageSha256']}`. Full Rules `{compiled.get('rulesSha256', compiled['status'])}`.",
              f"Standalone Pyric returned an exact move list and outcome on {standalone['outcomes'].get('match', 0)} of {standalone['distinctPositions']} eligible distinct successors. "
              f"{standalone['eligibleRequests']} proposals led to those positions. Every proposal is scored on its complete write.",
              f"Live coverage is **{live['status']}** with {live['distinctCases']} distinct observed proposals. "
              "The six rook claims also appear in the original 190. The overall row counts each proposal once."]
    scores = []
    unique = list(dict.fromkeys(k for ids in groups.values() for k in ids))
    for group, ids in [*groups.items(), ('overall', unique)]:
        measured = [k for k in ids if k in observed]
        pred = [local[k] for k in ids if k in local]
        scores.append((group, len(ids), sum(r['status']=='match' for r in pred),
                       sum(r['status']=='false-allow' for r in pred), sum(r['status']=='false-refusal' for r in pred),
                       sum(r.get('diagnostic')=='resource-limit' for r in pred),
                       sum(observed[k]['verdict']==native_verdicts[k] for k in measured), len(measured),
                       sum(observed[k]['verdict']=='ALLOW' and native_verdicts[k]=='DENY' for k in measured),
                       sum(observed[k]['verdict']=='DENY' and native_verdicts[k]=='ALLOW' for k in measured)))
    output.extend(['## Complete writes', table(['Batch','Cases','Local matches','Local false approvals','Local false refusals','Local limit hits¹','Live matches','Live measured','Live false approvals','Live false refusals'],scores),
                   '¹ Limit hits can also count as false refusals. The SDK exposes an admission verdict. Expression costs come from the pinned local evaluator.'])
    diagnostics=live.get('compileDiagnostics',[])
    if diagnostics:
        output.append(table(['Official source check','HTTP','Errors','Warnings','Game writes'],[
            (item['state'],item['httpStatus'],sum(i['severity']=='ERROR' for i in item['issues']),
             sum(i['severity']=='WARNING' for i in item['issues']),item['caseWrites']) for item in diagnostics]))
    if 'revisionHistory' in result:
        history=[]
        has_pair=any('queen-bishop' in (entry.get('local') or {}) for entry in result['revisionHistory'])
        for row in result['revisionHistory']:
            scores=row.get('local') or {}
            def batch(key):
                group=scores.get(key)
                return '—' if group is None else f"{group['outcomes'].get('match',0)}/{group['cases']}"
            overall=row.get('overall') or {}
            counts=overall.get('outcomes',{})
            limits=overall.get('diagnostics',{}).get('resource-limit',0)
            history.append([row['variant'],row['compile']['status'],', '.join(row.get('officialSource',[])) or 'unmeasured',
                            *(batch(g) for g in ('original-190',*FAMILIES)),
                            *([batch('queen-bishop')] if has_pair else []),
                            *(counts.get(k,0) if overall else '—' for k in ('false-allow','false-refusal','evaluation-error')),
                            limits if overall else '—',row.get('witnesses','—'),row['live']['distinctCases']])
        output.extend(['## Every saved revision',
                       table(['Policy','Local compile','Google source test','Original','Rook','Bishop','Queen',*(['Queen and bishop'] if has_pair else []),
                              'False approvals','False refusals','Evaluation errors','Limit hits¹','Verified witness boards','Live measured'],history)])
    if compiled['status']!='emitted':
        output.append(f"Compilation failed. `{compiled['status']}`")
    output.append('## Same move and successor under three claims')
    rows = []
    witnesses = {r['id']:r for r in result.get('compiledWitness',{}).get('focused',[])}
    for family in FAMILIES:
        if family not in groups: continue
        native = read(HERE/'native'/family/'native.json')['cases']
        for i in range(0,len(native),3):
            claims = native[i:i+3]
            first = claims[0]
            pred = standalone['positions'][standalone['positionByRequest'][first['id']]]['pyric']
            cells = []
            for source in ('native','local','live'):
                verdicts = []
                for item in claims:
                    k = item['id']
                    value = ({'native':'ALLOW' if item['nativeAdmission'] else 'DENY', 'local':local.get(k,{}).get('decision'),
                              'live':observed.get(k,{}).get('verdict')})[source]
                    verdicts.append({'ALLOW':'A','DENY':'D',None:'—'}[value])
                cells.append(' / '.join(verdicts))
            board_id=first['id'].removesuffix('-playing')
            traced=witnesses.get(board_id)
            helper='unmeasured' if not traced else 'outside guard' if traced['supported'] is False else (
                (traced['move'] or '∅') if traced['outcome'] in ('legal-witness','correct-absence') else traced['outcome'])
            rows.append((family,board_id,first['uci'],', '.join(first['replies']) or '∅',
                         ', '.join(pred['sliding']) or '∅' if isinstance(pred,dict) and isinstance(pred.get('sliding'),list) else 'unavailable',helper,*cells))
    output.extend([table(['Piece','Board','Move','Native legal replies','Standalone Pyric sliders','Emitted helper (local trace)','Native P/D/W','Local P/D/W','Live P/D/W'],rows),
                   'Claims are ordered playing, draw, won. A means allow, D means deny, and — means unmeasured.'])
    for family, heading in [('queen-bishop','Qd2–b2 with and without the b6 pawn'),
                            ('two-knights','Two defending knights'), ('lone-pawn','One defending pawn')]:
        if family not in groups: continue
        rows=[]
        fixtures={r['id']:r for r in read(HERE/'native'/family/'positions.json')}
        for key in groups[family]:
            position=standalone['positions'][standalone['positionByRequest'][key]]
            prediction=position['pyric']
            label=key if family=='queen-bishop' else f"{key} ({fixtures[key]['claim']['status']})"
            rows.append((label,', '.join(position['native']['all']) or '∅',
                         (', '.join(prediction['all']) or '∅') if isinstance(prediction,dict) and isinstance(prediction.get('all'),list) else 'unavailable',
                         native_verdicts[key],local.get(key,{}).get('decision','unmeasured'),
                         observed.get(key,{}).get('verdict','unmeasured')))
        output.extend(['## '+heading,
                       table(['Claim','Native replies','Pyric replies','Native','Local Rules','Live Firestore'],rows)])
    if 'specialPawnReplies' in result:
        controls=result['specialPawnReplies']
        output.extend(['## Special pawn replies',
                       table(['Starting FEN','Move','Only legal reply'],[(b['fen'],b['move'],b['onlyReply']) for b in controls['boards']]),
                       f"Local full writes matched native chess on {len(controls['localDecisions'])-len(controls['disagreements'])} of {len(controls['localDecisions'])} claims."])
    output.append('## Changes from the historical release on the original 190')
    changes = result.get('local',{}).get('changes',{}).get('original-190')
    if changes:
        old = read(HERE/'revisions/prior.json')['local']['disagreements']
        ids = sorted(set(old).intersection(groups['original-190']).union(k for k in groups['original-190'] if local[k]['status']!='match' or
                                    (k in observed and observed[k]['verdict']!=local[k]['native'])))
        output.append(table(['Case','Native','Prior live','Current local','Local diagnostic','Current live'], [
            (k,local[k]['native'],old[k]['decision'] if k in old else local[k]['native'],
             local[k]['decision'],local[k].get('diagnostic',''),observed.get(k,{}).get('verdict','—')) for k in ids]))
    if observed:
        admitted=[row for key,row in observed.items() if key in unique and row['verdict']=='ALLOW']
        denied=[row for key,row in observed.items() if key in unique and row['verdict']=='DENY']
        output.extend(['## Firestore readbacks',
                       f"Among the {len(admitted)+len(denied)} measured proposals in this score, Firestore admitted {len(admitted)} and refused {len(denied)}. "
                       f"A qualified capture checks every admitted document against the full submitted successor and every refused document against its complete starting snapshot. "
                       f"Server versions changed on {sum(r['versionChanged'] for r in admitted)} admitted writes and "
                       f"{sum(r['versionChanged'] for r in denied)} refusals."])
    for capture in live.get('captures',[]):
        output.append(f"Closed capture `{capture['name']}` measured {capture['rows']} proposals. "
                      f"Private receipt `{capture['receipt']}`. Journal `{capture['journalSha256']}`. "
                      f"Authenticated read and write after restoration returned {capture['closure']['signedRead']} and "
                      f"{capture['closure']['signedWrite']}.")
    return '\n\n'.join(output)+'\n'
