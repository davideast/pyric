"""Lock reproducible decisions independently from append-only hosted captures."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def local_projection(result):
    """Pin exact decision streams where the referee exposes one. Omit changing cloud totals."""
    return {key: result[key] for key in (
        'packageSha256', 'variant', 'coreBatches', 'coreDiagnostics', 'corePass', 'nativeEndgames', 'originalFilePins', 'targetRegexLiterals',
        'discovery', 'absolutePinRays', 'supplementalControls', 'enPassantContinuations', 'history', 'lifecycle'
    )}


def receipt_projection(result):
    return {release['sha256']: sorted(release['receipts'])
            for release in result['releaseComparisons'] if release['receipts']}


def check(result, directory):
    digest = result['hosted']['rulesSha256']
    if directory.name != digest:
        raise ValueError('Qualification file does not belong to this emitted Rules digest')
    expected = json.loads((directory / 'local.json').read_bytes())
    actual = local_projection(result)
    for key in sorted(set(expected) | set(actual)):
        if key not in actual or actual[key] != expected.get(key):
            raise ValueError(f'Local qualification changed for {digest}: {key}')
    receipts = receipt_projection(result)
    for release, required in json.loads((directory / 'receipts.json').read_bytes()).items():
        missing = set(required) - set(receipts.get(release, []))
        if missing:
            raise ValueError(f'Missing qualified live receipts for {release}: {sorted(missing)}')
    sealed = result['sealedReferee']
    if sealed['status'] == 'scored':
        expected = json.loads((directory / 'sealed.json').read_bytes())
        if sealed != expected:
            raise ValueError('Sealed referee qualification changed')
    return {'status': 'reproduced', 'rulesSha256': digest}
