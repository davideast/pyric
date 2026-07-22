import { initializeApp, deleteApp, type FirebaseOptions } from 'firebase/app';
import { getAuth, signInWithCustomToken } from 'firebase/auth';
import { getDatabase, onDisconnect, ref } from 'firebase/database';

interface Input {
  config: FirebaseOptions;
  token: string;
  path: string;
  value: unknown;
}

const input = JSON.parse(await new Response(Bun.stdin.stream()).text()) as Input;
const app = initializeApp(input.config, `abrupt-writer-${Date.now()}`);
await signInWithCustomToken(getAuth(app), input.token);
await onDisconnect(ref(getDatabase(app), input.path)).set(input.value);
process.stdout.write(`${JSON.stringify({ registered: true })}\n`);

// The parent intentionally terminates this process. This fallback only runs if
// the parent closes the capture unexpectedly.
await new Promise<void>((resolve) => process.once('SIGTERM', resolve));
await deleteApp(app);
