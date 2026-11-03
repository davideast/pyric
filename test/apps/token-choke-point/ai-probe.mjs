// Run as `pyric sandbox -- node ai-probe.mjs` in production AI mode, where the
// register hands firebase/ai to the Firebase SDK on purpose. Its request
// carries the API key, never a Google access token, so the guard lets it
// through to the trap.
import { initializeApp } from 'firebase/app';
import { getAI, getGenerativeModel } from 'firebase/ai';
import { outcomeOf, report } from './outcome.mjs';

const app = initializeApp({
  apiKey: 'AIzaSyDemoKeyForReproOnly000000000000',
  projectId: 'demo-token-choke-point',
  appId: '1:123456789012:web:abcdef0123456789',
});
const model = getGenerativeModel(getAI(app), { model: 'gemini-flash-lite-latest' });
const generateContent = await model.generateContent('Reply with one word: pong').then(() => 'answered', outcomeOf);

report('production AI', { generateContent });
