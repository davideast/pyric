import { initializeApp } from 'firebase-admin/app';

const app = initializeApp();
process.stdout.write(`RESULT ${JSON.stringify({ projectId: app.options.projectId ?? null })}\n`);
