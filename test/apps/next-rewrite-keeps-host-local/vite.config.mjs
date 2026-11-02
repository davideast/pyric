import { defineConfig } from 'vite';

const target = process.env.PYRIC_SANDBOX?.replace(/^remote:/, '');

export default defineConfig({
  server: { proxy: { '/__pyric': { target, ws: true } } },
});
