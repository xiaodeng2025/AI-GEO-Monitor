import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { BrowserRuntime } from './core/browser-runtime.js';

const runtime = new BrowserRuntime({ profileDir: resolve('profiles', 'kimi'), headless: false });
try {
  const page = await runtime.newPage();
  await page.goto('https://www.kimi.com/', { waitUntil: 'domcontentloaded' });
  console.log('A project-owned Kimi browser window is open. Log in manually; no credentials are read or exported. Press Enter here only after login is complete.');
  const terminal = createInterface({ input, output });
  await terminal.question('Press Enter to save the browser session and close this helper: ');
  terminal.close();
} finally {
  await runtime.close();
}
