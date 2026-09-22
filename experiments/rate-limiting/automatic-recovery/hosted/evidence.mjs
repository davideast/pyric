import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, isAbsolute } from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export const sharedSource = [
    'architecture/recovery-claim.mjs',
    'architecture/reconcile.mjs',
    'fixtures/contracts.mjs',
    'hosted/http-app.mjs',
    'hosted/provider.mjs',
].map(path => `experiments/rate-limiting/automatic-recovery/${path}`)
 .concat([
     'experiments/rate-limiting/integrated-admission/architecture/admission.mjs',
     'experiments/rate-limiting/integrated-admission/architecture/transitions.mjs',
     'experiments/rate-limiting/integrated-admission/fixtures/policy.mjs',
     'experiments/rate-limiting/inference-allowance/architecture/bucket.mjs',
     'experiments/rate-limiting/inference-allowance/adapters/store.mjs',
 ]);

export async function verifyDeployedSource(directory, expectedHash) {
    const provenance = JSON.parse(await readFile(join(directory, 'deployment-provenance.json'), 'utf8'));
    if (!provenance.files || Object.keys(provenance.files).length < 10)
        throw new Error('Incomplete deployment provenance');
    const hashes = {};
    for (const [path, expected] of Object.entries(provenance.files)) {
        if (isAbsolute(path) || path.split('/').includes('..')) throw new Error('Unsafe provenance path');
        hashes[path] = sha(await readFile(join(directory, path)));
        if (hashes[path] !== expected) throw new Error(`Source hash mismatch: ${path}`);
    }
    if (sha(JSON.stringify(hashes)) !== expectedHash || provenance.sourceHash !== expectedHash)
        throw new Error('Aggregate source hash mismatch');
    return { verified: true, sourceHash: expectedHash, files: hashes };
}

export async function compareSources(left, right, paths = sharedSource) {
    const files = await Promise.all(paths.map(async path => ({
        path,
        left:  sha(await readFile(join(left, path))),
        right: sha(await readFile(join(right, path))),
    })));
    return { identical: files.every(file => file.left === file.right), files };
}
