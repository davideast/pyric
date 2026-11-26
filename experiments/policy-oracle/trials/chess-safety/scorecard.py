"""Render completed, exact-digest Firestore observations alongside named native and local scores."""
import argparse
import json
from pathlib import Path
from collections import Counter

HERE = Path(__file__).resolve().parent
LABELS = {'00-legacy-file':'Existing file pins','01-rank-diagonal':'Rank and diagonal pins',
          '02-king-destinations':'King destinations','03-check-evasions':'Escapes from check','04-en-passant':'En passant',
          '05-castling':'Castling','06-composition':'Composition and cost','07-terminal':'Terminal claims','08-minimized':'Minimized cases',
          '09-corner-rights':'Corner rights','10-promotion-claims':'Promotion claims','11-successor-rights':'Submitted rights',
          '12-terminal-holdout':'Ten moves × three result claims','13-sole-pawn':'Sole pawn reply or stalemate','14-bare-king':'Bare king and sole knight reply'}


def render(report):
    if not report['hosted'].get('rulesSha256'):
        lines = ['# Chess compiler scorecard', '',
                 f"Program `{report['variant']}` from package `{report['packageSha256']}` produced no deployable release.",
                 '','| Batch | Plane | Outcomes |','| --- | --- | --- |']
        for batch, planes in report['coreBatches'].items():
            for name, result in planes.items():
                counts = ', '.join(f'{count} {kind}' for kind, count in result['counts'].items())
                lines.append(f'| {LABELS.get(batch,batch)} | {name} | {counts} |')
        lines.extend(['', '## Diagnostics', '','```json',json.dumps(report['diagnostics'],indent=2),'```',
                      '', 'Live Firestore status for this submission is unmeasured.'])
        return '\n'.join(lines)+'\n'
    releases = [r for r in report['releaseComparisons'] if r['productionCases']]
    releases.sort(key=lambda r:(0 if r['sha256'].startswith('523c4c') else 1,r['rules']))
    names = [('Prior stronger baseline' if r['sha256'].startswith('523c4c') else Path(r['rules']).stem) for r in releases]
    output = ['# Cumulative chess oracle scorecard','',
              'Each live cell gives native matches divided by distinct signed proposals on that release. A dash means the corresponding bytes have no completed measurement for that batch. The local columns use the selected candidate program `'+report['variant']+'`.','',
              '| Batch | Standalone king safety | Standalone board | Local linked writes | '+' | '.join(names)+' |',
              '| --- | ---: | ---: | ---: | '+' | '.join('---:' for _ in releases)+' |']
    groups = sorted(set(report['coreBatches']).union(*(r['batches'] for r in releases)))
    for group in groups:
        row = [LABELS.get(group,group)]
        for field in ['kingSafety','standaloneBoard','linkedWrites']:
            s = report['coreBatches'].get(group,{}).get(field)
            row.append(f"{s['counts'].get('match',0)}/{s['cases']}" if s else '—')
        for release in releases:
            s = release['batches'].get(group)
            row.append(f"{s['nativeMatches']}/{s['cases']}" if s else '—')
        output.append('| '+' | '.join(row)+' |')
    output += ['','## Signed releases','',
               '| Release and exact source review | Cases | False allows | False refusals | Same verdict in local evaluator | Signed readbacks |',
               '| --- | ---: | ---: | ---: | ---: | --- |']
    for name,rel in zip(names,releases,strict=True):
        digest=rel['sha256']; counts=Counter()
        for batch in rel['batches'].values(): counts.update(batch)
        output.append(f"| [{name} `{digest[:12]}`](live/reviews/{digest}.json) | {counts['cases']} | {counts['falseAllows']} | {counts['falseRefusals']} | {counts['localVerdictMatches']}/{counts['cases']} | [Receipts](live/receipts/{digest}/) |")
    scope=report.get('targetRegexLiterals',{})
    if scope:
        output += ['', '## Target compiler check','',
            f"The emitted source has {scope['directAsciiLiterals']} direct unescaped ASCII `matches()` literals. The largest is {scope['largest']} characters. "
            f"{len(scope['exceeding'])} exceed the observed 4,096-character limit. {len(scope.get('exceedingGroups',[]))} exceed 100 regex groups. {scope['otherMatchesArguments']} other arguments are outside this source check. "
            '[Official diagnostic and measured samples](compiler-boundaries/regex-literal-v1/)']
    queen = [(name,r) for name,r in zip(names,releases,strict=True) if 'holdout-black-queen-corner-playing' in r.get('examples',{})]
    if queen:
        output += ['','## The same checkmate under three claims','',
          'Black has a king on b3 and queen on d2. White has only its king on a1. After Qd2–b2, White has no legal reply and is in check. Each of these writes submits the same move and board. [Original native position and replies](exploration/hosted-holdout-v1/controls/native.json)','',
          '| Claimed result | Native | '+' | '.join(n for n,_ in queen)+' |','| --- | --- | '+' | '.join('---' for _ in queen)+' |']
        for status in ('playing','draw','won'):
            key='holdout-black-queen-corner-'+status
            output.append('| '+' | '.join([status,queen[0][1]['examples'][key]['native'],*[r['examples'][key]['production'] for _,r in queen]])+' |')
    output += ['','## Sensitivity to faulty implementations','',
        '| Batch | Fault | First case | Native | Faulty |','| --- | --- | --- | --- | --- |']
    for record in sorted((HERE/'batches').glob('*/v1/mutations.json')):
        data=json.loads(record.read_bytes())
        for item in data['results']:
            first=item['firstDivergence']
            output.append('| '+' | '.join([LABELS[data['batch']],item['name'],'['+first['id']+']('+str(record.relative_to(HERE))+')',
                'ALLOW' if first['native'] else 'DENY','ALLOW' if first['mutant'] else 'DENY'])+' |')
    output += ['','Matching cloud and local decisions establishes agreement on the submitted writes. The local expression counts and local failure classifications describe the local evaluator. Firestore supplied the signed write decision, full stored match and server versions.','',
        '## Broader local evidence','',
        '| Cohort | Cases | Native matches | Other outcomes |','| --- | ---: | ---: | --- |']
    def append(label,rows):
        rest=', '.join(f'{v} {k}' for k,v in rows.items() if k!='match' and v)
        output.append(f"| {label} | {sum(rows.values())} | {rows.get('match',0)} | {rest or '—'} |")
    for group,data in report['discovery']['cohorts'].items():append(group,data['outcomes'])
    if 'absolutePinRays' in report:
        append('Pinned knight and safe twin on every slider ray',report['absolutePinRays']['stats'])
    for group,h in report['history'].items():append('Recorded traces, '+group,{'match':h['allow'],'false refusal':h['falseRefusals']})
    append('Consecutive saved match histories and refusal probes',report['lifecycle']['outcomes'])
    ep=report['enPassantContinuations']; counts=Counter()
    for data in ep['groups'].values():counts.update(data)
    append('En passant with actual previous double push',counts)
    if report['sealedReferee']['status']=='scored':
        for key,data in report['sealedReferee']['groups'].items():append('Private traces, '+key,data)
    else:output += ['','The optional private trace corpus was not scored in this replay.']
    output+=['','The cohort totals are independent measurements. Some corpora share positions or requests. [Native answers and mutation controls](batches/) · [Third-referee checks](exploration/independent-review/) · [Public package scoring](README.md)']
    for record in report.get('openings',[]):
        output += ['', '## Authenticated opening under '+record['rulesSha256'][:12], '',
                   ' | '.join(f'{action} {verdict} (ply {ply})' for action,verdict,ply in record['rows']),
                   '', f"Final stored status was **{record['finalStatus']}**. [Full signed readbacks](live/openings/{record['rulesSha256']}/{record['plan']}.json.gz)"]
    evidence=report.get('management',{})
    if evidence.get('managementFailures') or evidence.get('unqualified'):
        output += ['', '## Unscored live attempts','',
                   f"{len(evidence.get('managementFailures',[]))} management failures produced no qualifying case observations. {len(evidence.get('unqualified',[]))} completed attempts failed the evidence checks. [Management journal summaries](live/failures/) · [Excluded receipts](live/unqualified/)"]
    return '\n'.join(output)+'\n'

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('report',type=Path)
    args=p.parse_args()
    print(render(json.loads(args.report.read_bytes())),end='')
