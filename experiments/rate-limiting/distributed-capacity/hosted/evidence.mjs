import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const sharedSource = ['architecture/capacity.mjs', 'hosted/http-app.mjs', 'hosted/provider.mjs']
    .map(path => `experiments/rate-limiting/distributed-capacity/${path}`)
    .concat('experiments/rate-limiting/inference-allowance/adapters/store.mjs');
export async function verifyDeployedSource(directory, expectedHash) {
    const provenance = JSON.parse(await readFile(join(directory, 'deployment-provenance.json'), 'utf8'));
    if (!provenance.files || Object.keys(provenance.files).length !== 9) throw new Error('Incomplete deployment provenance');
    const hashes = {};
    for (const [path, expected] of Object.entries(provenance.files)) {
        if (isAbsolute(path) || path.split('/').includes('..')) throw new Error('Unsafe provenance path');
        hashes[path] = sha(await readFile(join(directory, path)));
        if (hashes[path] !== expected) throw new Error(`Source hash mismatch: ${path}`);
    }
    if (sha(JSON.stringify(hashes)) !== expectedHash || provenance.sourceHash !== expectedHash) throw new Error('Aggregate source hash mismatch');
    return { verified: true, sourceHash: expectedHash, files: hashes };
}
export async function compareSources(left, right, paths = sharedSource) {
    const files = await Promise.all(paths.map(async path => ({ path,
        left: sha(await readFile(join(left, path))), right: sha(await readFile(join(right, path))) })));
    return { identical: files.every(file => file.left === file.right), files };
}
