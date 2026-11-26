"""Verify every disjoint shard of the emitted three-piece result helper probe."""
from hashlib import sha256
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


def checked_archive(directory):
    root = directory.parent.parent.parent
    summary = summarize(sorted(directory.glob('shard-*.json')))
    if summary != json.loads((directory/'summary.json').read_bytes()):
        raise ValueError(f'Shard evidence differs for {directory.name}')
    release = summary['bundleSha256']
    if not release.startswith(directory.name):
        raise ValueError('Archive directory and measured Rules differ')
    sources = [file for file in (root/'artefacts').glob('*.rules') if sha256(file.read_bytes()).hexdigest()==release]
    if not sources:
        raise ValueError('Missing the measured complete Rules source')
    return {**summary, 'rules':sources[0].relative_to(root).as_posix()}


if __name__ == '__main__':
    print(json.dumps(summarize([Path(arg) for arg in sys.argv[1:]]), indent=2))
