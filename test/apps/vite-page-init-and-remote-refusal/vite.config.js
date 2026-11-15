import { defineConfig } from 'vite';
import { pyric } from '@pyric/cli/vite';

const hosted = process.env.SCENARIO_HOSTED === '1';
const host = process.env.SCENARIO_HOST || '127.0.0.1';
const allowedHost = process.env.SCENARIO_ALLOWED_HOST;

const serverConfig = { host };
if (allowedHost) {
  serverConfig.allowedHosts = [allowedHost];
}

const customHtmlMiddleware = {
  name: 'custom-html-bypass-transform',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const rawUrl = req.url ?? '/';
      const pathOnly = rawUrl.split('?')[0];
      if (pathOnly !== '/custom-html') {
        next();
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        '<!doctype html><html><head><title>custom</title></head>'
        + '<body><pre id="out">loading</pre>'
        + '<script type="module" src="/src/main.js"></script></body></html>',
      );
    });
  },
};

export default defineConfig({
  server: serverConfig,
  plugins: [
    pyric({ hosted }),
    customHtmlMiddleware,
  ],
});
