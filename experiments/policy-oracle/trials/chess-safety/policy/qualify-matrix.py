"""Re-run the full application matrix and verify only newly enforced king safety changed."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
BUNDLE = HERE / '../../chess/bundle'


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('reference', type=Path)
    p.add_argument('releases', type=Path, nargs='+')
    args = p.parse_args()
    golden = json.loads((BUNDLE / 'local-results.json').read_bytes())
    results = []
    for release in args.releases:
        cmd = ['bun', BUNDLE / 'verify.mjs', '--archived-native', args.reference.resolve(),
               release.resolve(), '--king-safety']
        observed = json.loads(subprocess.check_output(cmd))
        assert observed['cases'] == golden['cases'] == 150
        assert observed['profiles'] == golden['profiles']
        changed = []
        for case, control in golden['verdicts'].items():
            for i, profile in enumerate(golden['profiles']):
                actual = observed['verdicts'][case][i]
                if actual != control[i]:
                    changed.append([case, profile, control[i], actual])
        expected = [['pinned-slider','stronger','ALLOW','DENY'],
                    ['castle-attacked-transit','stronger','ALLOW','DENY']]
        assert sorted(changed) == sorted(expected), changed
        results.append({'rulesSha256': hashlib.sha256(release.read_bytes()).hexdigest(),
                        'cases':observed['cases'], 'profiles':observed['profiles'],
                        'decisions':600, 'changed':changed, 'peak':observed['peak']['stronger']})
    print(json.dumps({'authority':'independent complete Rules simulation','releases':results}, indent=2))


if __name__ == '__main__':
    main()
