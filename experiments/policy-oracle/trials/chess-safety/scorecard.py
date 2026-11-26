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
          '12-terminal-holdout':'Ten moves × three result claims','13-sole-pawn':'Sole pawn reply or stalemate','14-bare-king':'Bare king and sole knight reply','15-fourth-ply-and-knight':'Actual fourth ply and knight interposition','16-held-rook-promotion':'Mating promotion with or without a castling right','17-rook-interposition':'Sole rook interposition or mate'}


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
    labels={'5365dc51':'Fixed-width policy','911e4b24':'Packed v4','fa5ed317':'Pawn witness','523c4c13':'Prior stronger baseline','2d793f90':'Quick status','a53c2fed':'Three-piece status',
            '9b31d40d':'Bare king','d0a6af91':'Packed v3','fe6ae708':'Long-ray optimization'}
    names=[labels.get(r['sha256'][:8], 'Selected' if r['sha256']==report['hosted'].get('rulesSha256') else Path(r['rules']).stem) for r in releases]
    output = ['# Cumulative chess oracle scorecard','',
              'Each score counts agreements with the independently frozen native answer. The safety column asks whether the moving king is safe. The board and write columns additionally cover move legality and the claimed successor.',
              '',f"Selected program `{report['variant']}`.",'',
              '| Primary batch | Native allow / deny | Standalone safety | Standalone board | Local linked write |',
              '| --- | ---: | ---: | ---: | ---: |']
    for group,planes in sorted(report['coreBatches'].items()):
        admission=report.get('primaryNative',{}).get(group)
        row=[LABELS.get(group,group), f"{admission['allow']} / {admission['deny']}" if admission else '—']
        for field in ('kingSafety','standaloneBoard','linkedWrites'):
            plane=planes[field]
            row.append(f"{plane['counts'].get('match',0)}/{plane['cases']}")
        output.append('| '+' | '.join(row)+' |')
    output+=['','## Live observations by batch','',
             'Each cell gives native matches divided by distinct authenticated writes. A dash means that the release has no completed observation for that batch.']
    # Limit the width of each table as additional releases accumulate.
    for offset in range(0,len(releases),4):
        selected=releases[offset:offset+4]
        output+=['','| Batch | '+' | '.join(names[offset:offset+4])+' |','| --- | '+' | '.join('---:' for _ in selected)+' |']
        for group in sorted(set().union(*(r['batches'] for r in selected))):
            row=[LABELS.get(group,group)]
            for release in selected:
                batch=release['batches'].get(group)
                row.append(f"{batch['nativeMatches']}/{batch['cases']}" if batch else '—')
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
    if report.get('namedSnapshots'):
        keys={r['id']:r for r in report['namedSnapshots']}
        names_for_cases=[(n,r) for n,r in zip(names,releases,strict=True) if any(k in r['examples'] for k in keys)]
        output+=['','## Same move, different result claim or defender','',
            'The first two submissions use the genuine fourth-ply match snapshot after 1.f3 e5 2.g4. The last two both submit Ra8–h8 and claim a draw. Taking the white queen off b4 frees a black knight. [Complete inputs and independently frozen native replies](reachable/lifecycle-v1/named/v1/)',
            '', '| Case | Native | Selected local | '+' | '.join(n for n,_ in names_for_cases)+' |',
            '| '+' | '.join('---' for _ in range(3+len(names_for_cases)))+' |']
        for key,v in keys.items():
            output.append('| '+' | '.join([key,v['expected'],v['decision'],*[r['examples'].get(key,{}).get('production','—') for _,r in names_for_cases]])+' |')
    for cohort,title,description in [
        ('rook-interposition-v1','A rook with one legal reply',
         'White plays Qg4–g8 on both boards. A black rook on c5 can block with Rc8. A black rook on h5 has no legal reply.'),
        ('held-rook-promotion-v1','A legal mating promotion with different prior rights',
         'Black plays g2xh1=Q# on both boards. The only change is whether White still holds the kingside castling right before the capture.'),
    ]:
        source = Path('exploration')/cohort/'controls/native.json'
        cases = json.loads((HERE/source).read_bytes())['cases']
        observed = [(name,rel['examples']) for name,rel in zip(names,releases,strict=True)
                    if any(case['id'] in rel['examples'] for case in cases)]
        if observed:
            output += ['', '## '+title, '', f'{description} [Native successors and replies]({source})', '',
                       '| Case | Native | '+' | '.join(label for label,_ in observed)+' |',
                       '| '+' | '.join('---' for _ in range(2+len(observed)))+' |']
            for case in cases:
                key=case['id']
                row=[key,'ALLOW' if case['nativeAdmission'] else 'DENY']
                row += [examples.get(key,{}).get('production','—') for _,examples in observed]
                output.append('| '+' | '.join(row)+' |')
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
    if report.get('residuals'):
        breakdown=report['residuals']
        output+=['','## Remaining obligations on the broader local corpus','',
                 f"{breakdown['distinctWrites']} distinct writes disagreed with native. The second replay independently reproduced every original decision and expression-count digest.",'',
                 '| Obligation | Distinct writes |','| --- | ---: |']
        output.extend(f"| {kind} | {count} |" for kind,count in sorted(breakdown['obligations'].items()))
    for record in report.get('openings',[]):
        output += ['', '## Authenticated opening under '+record['rulesSha256'][:12], '',
                   ' | '.join(f'{action} {verdict} (ply {ply})' for action,verdict,ply in record['rows']),
                   '', f"Final stored status was **{record['finalStatus']}**. [Full signed readbacks](live/openings/{record['rulesSha256']}/{record['plan']}.json.gz)"]
    evidence=report.get('management',{})
    if evidence.get('compileDiagnostics'):
        output+=['','## Official source compilation','',
                 'Each static test submitted source to Google’s Rules service. A successful static result qualifies that compiler observation; the signed-write table reports live match decisions.',
                 '','| Source or control | Static result | First diagnostic |','| --- | --- | --- |']
        for item in sorted(evidence['compileDiagnostics'],key=lambda r:r['subject']):
            issue=next((a['message'] for a in item['issues'] if a['severity']=='ERROR'),'—')
            output.append(f"| [{item['subject']}](live/diagnostics/{item['rulesSha256']}.json) | {item['state']} | {issue} |")
        for item in evidence['compilerRejections']:
            output+=['',f"Google returned HTTP {item['httpStatus']} on publication of the intended `{item['plan']}` release and received {item['caseWrites']} case writes. "
                      f"[Management journal summary](live/failures/{item['journalSha256']}.json)"]
    if evidence.get('managementFailures') or evidence.get('unqualified'):
        output += ['', '## Unscored live attempts','',
                   f"{len(evidence.get('managementFailures',[]))} management failures produced no qualifying case observations. {len(evidence.get('unqualified',[]))} completed attempts failed the evidence checks. [Management journal summaries](live/failures/) · [Excluded receipts](live/unqualified/)"]
    return '\n'.join(output)+'\n'

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('report',type=Path)
    args=p.parse_args()
    print(render(json.loads(args.report.read_bytes())),end='')
