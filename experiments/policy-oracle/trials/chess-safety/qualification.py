"""Pin reproducible candidate behavior independently from accumulating hosted evidence."""
import json


def local_projection(result):
    """Include exact decision streams where the local referee exposes one."""
    return {key:result[key] for key in (
        'packageSha256','variant','coreBatches','primaryNative','coreDiagnostics','corePass',
        'nativeEndgames','originalFilePins','targetRegexLiterals','discovery','residuals','absolutePinRays',
        'namedSnapshots','supplementalControls','enPassantContinuations','history','lifecycle'
    )}


def receipt_projection(result):
    """Identify immutable proofs. Future observations can extend each independent group."""
    groups={}
    for release in result['releaseComparisons']:
        if release['receipts']:
            groups['writes/'+release['sha256']]=sorted(release['receipts'])
    for record in result['openings']:
        groups.setdefault('opening/'+record['rulesSha256'],[]).append(record['receipt'])
    for entry in result['management']['compileDiagnostics']:
        groups['compile/'+entry['rulesSha256']]=[entry['receipt']]
    groups['publication-rejections']=sorted(row['journalSha256'] for row in result['management']['compilerRejections'])
    return groups


def verify_thresholds(diagnostics):
    by_name={row['subject']:row for row in diagnostics}
    outcomes={}
    for name,succeeds in [('groups-100',True),('groups-101',False),('literal-4096',True),('literal-4097',False)]:
        row=by_name[name]
        expected='compiled' if succeeds else 'compile-error'
        if row['state']!=expected or row['caseWrites']!=0:
            raise ValueError(f'Official compiler boundary changed for {name}')
        outcomes[name]={'state':expected,'rulesSha256':row['rulesSha256'],'receipt':row['receipt']}
    return outcomes


def check(result, directory):
    digest=result['hosted']['rulesSha256']
    if directory.name!=digest:
        raise ValueError('Qualification file belongs to a different emitted Rules digest')
    expected=json.loads((directory/'local.json').read_bytes())
    actual=local_projection(result)
    if set(expected)!=set(actual):
        raise ValueError('Qualification fields changed')
    for key,value in expected.items():
        if key=='supplementalControls':
            for cohort,score in value.items():
                if actual[key].get(cohort)!=score:
                    raise ValueError(f'Local qualification changed for {digest}: {cohort}')
        elif value!=actual[key]:
            raise ValueError(f'Local qualification changed for {digest}: {key}')
    receipts=receipt_projection(result)
    pinned=json.loads((directory/'receipts.json').read_bytes())
    for group,proofs in pinned.items():
        missing=set(proofs)-set(receipts.get(group,[]))
        if missing:
            raise ValueError(f'Missing qualified live evidence for {group}: {sorted(missing)}')
    if result['sealedReferee']['status']=='scored':
        if result['sealedReferee']!=json.loads((directory/'sealed.json').read_bytes()):
            raise ValueError('Sealed referee qualification changed')
    return {'status':'reproduced','rulesSha256':digest,'historicalProofs':sum(map(len,pinned.values()))}
