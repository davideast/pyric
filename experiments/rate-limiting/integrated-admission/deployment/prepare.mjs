import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root  = new URL('../../../../', import.meta.url);
const base  = 'experiments/rate-limiting/integrated-admission';
const prior = 'experiments/rate-limiting/inference-allowance';

const files = {
    'package.json':      `${prior}/deployment/cloudrun-package.json`,
    'package-lock.json': `${prior}/deployment/cloudrun-package-lock.json`,
    'Dockerfile':        `${base}/deployment/Dockerfile`,
    ...Object.fromEntries([
        'architecture/admission.mjs',
        'architecture/transitions.mjs',
        'fixtures/policy.mjs',
        'hosted/entry.mjs',
        'hosted/http-app.mjs',
        'hosted/provider.mjs',
    ].map(path => [`${base}/${path}`, `${base}/${path}`])),
    [`${prior}/architecture/bucket.mjs`]:              `${prior}/architecture/bucket.mjs`,
    [`${prior}/adapters/store.mjs`]:                   `${prior}/adapters/store.mjs`,
    [`${prior}/services/observability-preflight.mjs`]: `${prior}/services/observability-preflight.mjs`,
};

export async function prepareCloudRun() {
    const directory = await mkdtemp(join(tmpdir(), 'integrated-admission-cloudrun-source-'));
    const hashes = {};
    for (const [target, source] of Object.entries(files)) {
        let bytes = await readFile(new URL(source, root));
        if (target === 'package.json' || target === 'package-lock.json') {
            const pkg = JSON.parse(bytes.toString());
            pkg.name = 'integrated-admission-experiment';
            if (target === 'package.json') pkg.scripts.start = `node ${base}/hosted/entry.mjs`;
            else pkg.packages[''].name = pkg.name;
            bytes = Buffer.from(JSON.stringify(pkg, null, 2) + '\n');
        }
        await mkdir(dirname(join(directory, target)), { recursive: true });
        await writeFile(join(directory, target), bytes);
        hashes[target] = createHash('sha256').update(bytes).digest('hex');
    }
    const sourceHash = createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
    await writeFile(join(directory, 'deployment-provenance.json'), JSON.stringify({ sourceHash, files: hashes }, null, 2));
    await writeFile(join(directory, '.gcloudignore'), '.git\nnode_modules\n');
    await writeFile(join(directory, '.dockerignore'), '.git\nnode_modules\n');
    return { directory, sourceHash, files: Object.keys(files) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    console.log(JSON.stringify(await prepareCloudRun(), null, 2));
