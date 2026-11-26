"""Verify every disjoint shard of the emitted three-piece result helper probe."""
import json
from collections import Counter
from pathlib import Path
import sys


def summarize(paths):
    native = json.loads((Path(__file__).parents[1] / 'table-v2/native.json').read_bytes())
    rows = sorted((json.loads(path.read_bytes()) for path in paths), key=lambda row: row['shard'])
    if not rows:
        raise ValueError('No shards')
    shards = rows[0]['shards']
    if [row['shard'] for row in rows] != list(range(shards)):
        raise ValueError('Missing or duplicate shard')
    positions = native['positions']
    counts = Counter()
    for index, row in enumerate(rows):
        for field in ['authority', 'bundleSha256', 'helperScopeSha256', 'functions', 'shards']:
            if row[field] != rows[0][field]:
                raise ValueError(f'Shard {index} differs in {field}')
        expected = len(range(index, positions, shards))
        if (row['nativeSha256'], row['available'], row['checked'], row['writes']) != (
                native['sha256'], positions, expected, 3 * expected):
            raise ValueError(f'Incomplete native population in shard {index}')
        if bool(row['mismatches']) != bool(row['first']) or row['runtimeErrors'] > row['mismatches']:
            raise ValueError(f'Inconsistent error evidence in shard {index}')
        totals = Counter()
        for outcome, count in row['counts'].items():
            totals[outcome.split('-')[0]] += count
        if totals != dict.fromkeys(('playing', 'draw', 'won'), expected):
            raise ValueError(f'Incomplete result claims in shard {index}')
        counts.update(row['counts'])
    return {
        **{field: rows[0][field] for field in ['authority', 'bundleSha256', 'helperScopeSha256', 'nativeSha256']},
        'positions': positions, 'claims': 3 * positions, 'counts': dict(sorted(counts.items())),
        'runtimeErrors': sum(row['runtimeErrors'] for row in rows),
        'mismatches': sum(row['mismatches'] for row in rows),
        'firstByShard': [row['first'] for row in rows],
        'shardDecisionHashes': [row['scoreSha256'] for row in rows],
    }


if __name__ == '__main__':
    print(json.dumps(summarize([Path(arg) for arg in sys.argv[1:]]), indent=2))
