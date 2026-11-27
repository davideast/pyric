"""Compare two releases on the same frozen wider-corpus writes and list every changed or remaining error."""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import subprocess
import sys

TRIAL = Path(__file__).resolve().parents[1]
OLD = TRIAL.parent / 'chess-safety'
EXPLORATION = OLD/'exploration'
PRIOR_RULES = OLD/'artefacts/knight-endgame-paired-pawn-combined-bare-fixed-comma-packed-v5.rules'


def read(path):
    return json.loads(path.read_bytes())


def residuals(reference, rules, summary):
    report = json.loads(subprocess.check_output(['bun', '--no-install', EXPLORATION/'residuals-v1/measure.mjs',
                                                reference, rules, summary, '--records']))
    rows = report.pop('records')
    by_id = {}
    for row in rows:
        keys = [(case['cohort'], case['id']) for case in row['occurrences']]
        for key in keys:
            assert key not in by_id
            by_id[key] = (row['writeSha256'], row['observation']['outcome'])
    assert len(rows) == report['distinctWrites']
    return report, by_id


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    reference = args.reference.resolve(strict=True)
    subprocess.run([sys.executable, '-B', EXPLORATION/'v1/verify-simulator.py', reference], check=True)
    old_file, new_file = EXPLORATION/'independent-review/knight-fixed-comma.json', TRIAL/'supplemental/selected.json'
    old_freeze, new_freeze = read(old_file), read(new_file)
    assert old_freeze['cases'] == new_freeze['cases'] == 15905
    assert {k:v['cases'] for k,v in old_freeze['cohorts'].items()} == {k:v['cases'] for k,v in new_freeze['cohorts'].items()}
    prior, before = residuals(reference, PRIOR_RULES, old_file)
    assert prior == read(EXPLORATION/'residuals-v1/selected.json')
    selected, after = residuals(reference, TRIAL/'live/releases'/new_freeze['rulesSha256']/'firestore.rules', new_file)
    groups = {name:defaultdict(list) for name in new_freeze['cohorts']}
    movements = Counter()
    write_groups = defaultdict(set)
    for key in sorted(before.keys() | after.keys()):
        old_sha, old = before.get(key, (None, 'match'))
        new_sha, new = after.get(key, (None, 'match'))
        if old_sha and new_sha:
            assert old_sha == new_sha, key
        classification = 'repaired' if new == 'match' else 'regressed' if old == 'match' else 'remaining'
        groups[key[0]][classification].append(key[1])
        movements[(old,new)] += 1
        write_groups[classification].add(old_sha or new_sha)
    totals = {key:sum(len(items.get(key,[])) for items in groups.values()) for key in ('repaired','regressed','remaining')}
    assert totals['repaired'] + totals['remaining'] == len(before) == old_freeze['cases'] - old_freeze['outcomes']['match']
    assert totals['regressed'] + totals['remaining'] == len(after) == new_freeze['cases'] - new_freeze['outcomes']['match']
    assert all(write_groups[a].isdisjoint(write_groups[b]) for a,b in [('repaired','regressed'),('repaired','remaining'),('regressed','remaining')])
    output = {'authority':'Local full-write evaluator. Each release independently reproduces its frozen decision and expression-cost digest for all eleven cohorts.',
              'cases':new_freeze['cases'],'priorRulesSha256':prior['rulesSha256'],'selectedRulesSha256':selected['rulesSha256'],
              'priorResidualsSha256':prior['recordsSha256'],'selectedResidualsSha256':selected['recordsSha256'],
              'priorOutcomes':old_freeze['outcomes'],'selectedOutcomes':new_freeze['outcomes'],
              'caseOccurrences':totals,'distinctAffectedWrites':{key:len(write_groups[key]) for key in totals},
              'transitions':[{'prior':old,'selected':new,'cases':n} for (old,new),n in sorted(movements.items())],
              'selectedFailureReasons':selected['obligations'],'caseIdsByCohort':groups}
    args.output.write_text(json.dumps(output, indent=2)+'\n')


if __name__ == '__main__':
    main()
