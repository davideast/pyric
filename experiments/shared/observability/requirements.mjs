import { createHash } from 'node:crypto';
export const setupVersion = '1.1.1';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const services = {
    firestore: 'datastore.googleapis.com',
    rtdb: 'firebasedatabase.googleapis.com',
};

export function configuration(input, manifest) {
    const required = ['project', 'database', 'service', 'region', 'collector'];
    for (const key of required) if (!input[key]) throw new Error(`--${key} is required`);
    if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(input.project)) throw new Error('Invalid project ID');
    for (const key of ['database', 'service', 'region']) {
        if (key === 'database' && input[key] === '(default)') continue;
        if (!/^[a-zA-Z0-9][a-zA-Z0-9()-]{0,62}$/.test(input[key])) throw new Error(`Invalid ${key}`);
    }
    if (!/^(serviceAccount|user):[^\s/:]+@[^\s/:]+$/.test(input.collector)) throw new Error('Collector must be user:EMAIL or serviceAccount:EMAIL');
    const optional = (input.optional ?? '').split(',').filter(Boolean).sort();
    if (optional.some(s => !['auth', 'ai', 'rtdb'].includes(s))) throw new Error('Optional services: auth,ai,rtdb');
    const retentionDays = Number(input.retention ?? manifest.retentionDays);
    const minimumRetention = Math.max(30, manifest.retentionDays);
    if (!Number.isInteger(retentionDays) || retentionDays < minimumRetention || retentionDays > 3650) throw new Error(`Retention must be ${minimumRetention}–3650 days`);
    const location = input.location ?? 'global';
    if (!/^[a-z0-9-]+$/.test(location)) throw new Error('Invalid log bucket location');
    return { project: input.project, database: input.database, service: input.service, region: input.region,
        collector: input.collector, optional, retentionDays, location,
        bucket: 'pyric-experiments', sink: `pyric-${input.service}`, manifestHash: digest(manifest) };
}

export function resources(config) {
    const { project, region, service, location, bucket, sink } = config;
    const logging = 'https://logging.googleapis.com/v2';
    const projectPath = `projects/${project}`;
    const bucketPath = `${projectPath}/locations/${location}/buckets/${bucket}`;
    return {
        project: `https://cloudresourcemanager.googleapis.com/v1/projects/${project}`,
        run: `https://run.googleapis.com/v2/${projectPath}/locations/${region}/services/${service}`,
        database: `https://firestore.googleapis.com/v1/${projectPath}/databases/${config.database}`,
        sink: `${logging}/${projectPath}/sinks/${sink}`,
        sinks: `${logging}/${projectPath}/sinks`,
        bucket: `${logging}/${bucketPath}`,
        buckets: `${logging}/${projectPath}/locations/${location}/buckets`,
        bucketPath,
        logs: `${logging}/entries:list`,
        auth: `https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/config`,
    };
}

export function sinkFilter(config) {
    const clauses = [
        `(resource.type="cloud_run_revision" AND resource.labels.service_name="${config.service}" AND resource.labels.location="${config.region}")`,
        '(protoPayload.serviceName="firestore.googleapis.com")',
    ];
    if (config.optional.includes('rtdb')) clauses.push('(protoPayload.serviceName="firebasedatabase.googleapis.com")');
    if (config.optional.includes('auth')) clauses.push('(log_id("identitytoolkit.googleapis.com/requests"))');
    if (config.optional.includes('ai')) clauses.push('(resource.type="firebasevertexai.googleapis.com/Model")');
    return clauses.join(' OR ');
}
