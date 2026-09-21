import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const root = new URL('../', import.meta.url);
const files = {
    'package.json': 'deployment/cloudrun-package.json',
    'package-lock.json': 'deployment/cloudrun-package-lock.json',
    'Dockerfile': 'deployment/Dockerfile.cloudrun',
    'services/cloudrun-entry.mjs': 'services/cloudrun-entry.mjs',
    'services/observability-preflight.mjs': 'services/observability-preflight.mjs',
    'services/cloudrun-app.mjs': 'services/cloudrun-app.mjs',
    'services/inference-http.mjs': 'services/inference-http.mjs',
    'services/execution-app.mjs': 'services/execution-app.mjs',
    'services/lifecycle-inference.mjs': 'services/lifecycle-inference.mjs',
    'scenarios/http-overload.mjs': 'scenarios/http-overload.mjs',
    'analysis/execution-checks.mjs': 'analysis/execution-checks.mjs',
    'services/fake-inference.mjs': 'services/fake-inference.mjs',
    'architecture/gateway.mjs': 'architecture/gateway.mjs',
    'architecture/admission.mjs': 'architecture/admission.mjs',
    'architecture/bucket.mjs': 'architecture/bucket.mjs',
    'adapters/store.mjs': 'adapters/store.mjs',
    'fixtures/policies.json': 'fixtures/policies.json',
};
export async function prepareCloudRun() {
    const directory = await mkdtemp(join(tmpdir(), 'allowance-cloudrun-source-'));
    const hashes = {};
    for (const [target, source] of Object.entries(files)) {
        const bytes = await readFile(new URL(source, root));
        const path = join(directory, target);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
        hashes[target] = createHash('sha256').update(bytes).digest('hex');
    }
    const sourceHash = createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
    await writeFile(join(directory, 'deployment-provenance.json'), JSON.stringify({ sourceHash, files: hashes }, null, 2));
    await writeFile(join(directory, '.gcloudignore'), '.git\nnode_modules\n');
    await writeFile(join(directory, '.dockerignore'), '.git\nnode_modules\n');
    return { directory, sourceHash, files: Object.keys(files) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await prepareCloudRun(), null, 2));
