"""Check the original scope of a previously measured local chess program."""
import gzip
from hashlib import sha256
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parents[1]
MOBILITY_FLAGS = {'replies-v1': '--terminal-replies', 'interior-v1': '--interior'}


def verify_prior(record, report, reference=None):
    variant = report['variant']
    if record['scope'] not in {'king mobility only', 'prior modeled move submissions',
                               'source emission only; no prior game score'}:
        raise ValueError('Unknown historical experiment scope')
    checked = []
    for item in record['inputs']:
        path = Path(item['file'])
        location = HERE / path
        if location.resolve() != location or not location.is_relative_to(HERE):
            raise ValueError('Unexpected historical evidence path')
        payload = location.read_bytes()
        if sha256(payload).hexdigest() != item['sha256']:
            raise ValueError('Historical input changed: ' + str(path))
        if path.parent == Path('revisions/recovered-inputs') / variant and path.name == 'previous-primary.json.gz':
            earlier = json.loads(gzip.decompress(payload))
            rows = [row for batch in earlier.values() for row in batch]
            if len(rows) != len(report['linkedWrites']):
                raise ValueError('Historical primary case count changed')
            for old, new in zip(rows, report['linkedWrites']):
                before = (old['id'], old['expected'], old['observed'], old['expressions'], old['limit'])
                after = (new['id'], new['expected'], new['decision'], new['cost'],
                         (new.get('detail') or {}).get('kind') if new.get('error') == 'resource-limit' else None)
                error = 'resource-limit' if old['limit'] else (
                    'rule-error' if old['errors'] and old['observed'] == 'DENY' else None)
                if before != after or error != new.get('error'):
                    raise ValueError(f'Historical complete write changed: {before} vs {after}')
            checked.append({'file': path.as_posix(), 'sha256': item['sha256'], 'cases': len(rows)})
        elif path.parent.parent == Path('exploration') and path.parent.name in MOBILITY_FLAGS:
            result = json.loads(payload)
            if result['rulesSha256'] != report['linkedRulesSha256']:
                raise ValueError('Historical mobility score refers to different complete Rules')
            if reference is not None:
                command = ['bun', 'v1/score.mjs', reference,
                           HERE/'artefacts'/(variant+'.rules'), MOBILITY_FLAGS[path.parent.name]]
                observed = json.loads(subprocess.check_output(command, cwd=HERE/'exploration'))
                # The original report stores per-group counts, expression peaks and a
                # digest of every individual verdict, including its error classification.
                for key in ['rulesSha256', 'corpusSha256', 'caseCount', 'scoreSha256', 'groups']:
                    if observed[key] != result[key]:
                        raise ValueError(f'Historical mobility evidence changed: {path}: {key}')
            checked.append({'file': path.as_posix(), 'sha256': item['sha256'], 'cases': result['caseCount'],
                            'decisionsSha256': result['scoreSha256']})
        else:
            raise ValueError('Unknown historical evidence kind: ' + str(path))
    if record['scope'].startswith('source emission only') != (not checked):
        raise ValueError('Prior game evidence does not agree with the recorded scope')
    return {'scope': record['scope'], 'inputs': checked}
