import { execSync, spawn } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import { chromium } from '@playwright/test';

function checkUrl(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function waitForServer(url: string, timeoutMs = 60000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (await checkUrl(url)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms`);
}

async function main() {
  console.log('Ensuring port 4321 is free...');
  try {
    execSync('fuser -k 4321/tcp', { stdio: 'ignore' });
  } catch {
    // ignore if no process running
  }

  console.log('Building site-docs...');
  execSync('npm run build -w packages/site-docs', { stdio: 'inherit' });

  console.log('Starting preview server...');
  const server = spawn('npm', ['run', 'preview', '-w', 'packages/site-docs'], {
    stdio: 'inherit',
  });

  try {
    console.log('Waiting for http://localhost:4321...');
    await waitForServer('http://localhost:4321');
    console.log('Server is ready at http://localhost:4321');

    console.log('Launching browser in headless mode (viewport 1280x720)...');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();

    console.log('Navigating to http://localhost:4321/ and waiting for networkidle...');
    await page.goto('http://localhost:4321/', { waitUntil: 'networkidle' });

    console.log('Capturing JPEG screenshot in memory (quality: 10)...');
    const imageBuffer = await page.screenshot({
      type: 'jpeg',
      quality: 10,
    });

    await browser.close();

    const base64String = imageBuffer.toString('base64');
    const dataUri = `data:image/jpeg;base64,${base64String}`;
    const linkTag = `<a href="${dataUri}" download="site-docs-root.jpg">Download Screenshot</a>`;

    console.log('\n=============================================');
    console.log('Screenshot captured successfully!');
    console.log(`JPEG Buffer size: ${imageBuffer.length} bytes`);
    console.log(`Base64 String length: ${base64String.length} chars`);
    console.log('=============================================\n');

    // Save link tag to temporary file (gitignored or outside repo / tmp) for easy copying
    fs.writeFileSync('/tmp/pr_download_link.html', linkTag, 'utf-8');
    console.log('Link saved to /tmp/pr_download_link.html');
  } finally {
    server.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
