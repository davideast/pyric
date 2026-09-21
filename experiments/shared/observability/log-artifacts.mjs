import { readdir, readFile, writeFile, mkdir, cp, realpath, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, basename, relative, isAbsolute } from 'node:path';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export async function captureCollectorSource(out, adapterUrl) {
    const files = [];
    const source = new URL('./', import.meta.url);
    for (const name of (await readdir(source)).filter(name => name.endsWith('.mjs')).sort()) {
        files.push({ source: new URL(name, source), path: `experiments/shared/observability/${name}` });
    }
    files.push({ source: new URL(adapterUrl), path: 'experiments/rate-limiting/inference-allowance/deployment/capture-logs.mjs' });
    const hashes = {};
    for (const file of files) {
        const path = join(out, 'collector-source', file.path);
        await mkdir(dirname(path), { recursive: true });
        await cp(file.source, path);
        hashes[file.path] = sha(await readFile(path));
    }
    return { method: 'collector source copied before export; dependencies external', files: hashes };
}

export async function sealLogExport(out) {
    const files = [];
    async function visit(directory, prefix = '') {
        for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const path = prefix + item.name;
            if (path === 'manifest.json') continue;
            if (item.isDirectory()) await visit(join(directory, item.name), path + '/');
            else {
                const bytes = await readFile(join(directory, item.name));
                files.push({ path, sha256: sha(bytes), bytes: bytes.length });
            }
        }
    }
    await visit(out);
    await writeFile(join(out, 'manifest.json'), JSON.stringify({ formatVersion: 1, captureKind: 'scoped-workload-log-export', files, credentialsBundled: false }, null, 2) + '\n', { mode: 0o600 });
}

// Resolve existing symlink ancestors even when the destination does not exist.
async function canonicalPath(path) {
    let current = resolve(path);
    const tail = [];
    for (;;) {
        try { return join(await realpath(current), ...tail); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            tail.unshift(basename(current)); current = dirname(current);
        }
    }
}
export async function isSealedDestination(measurement, destination) {
    try { await access(join(measurement, 'manifest.json')); } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
    const path = relative(await canonicalPath(measurement), await canonicalPath(destination));
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'));
}
