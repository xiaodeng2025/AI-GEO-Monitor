import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const profileDir = resolve('runtime-data', 'browser-profile');
const home = 'https://www.doubao.com/';
const deadlineMs = 10 * 60 * 1000;
const intervalMs = 5_000;

async function loginState(page) {
  const state = await page.evaluate(() => {
    const visibleExactText = (value) => [...document.querySelectorAll('*')].some((node) => {
      const style = getComputedStyle(node);
      return node.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden'
        && String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim() === value;
    });
    return { url: location.href, loginControlVisible: visibleExactText('登录') };
  });
  return { ...state, authenticated: !state.url.includes('from_logout=1') && !state.loginControlVisible };
}

await mkdir(profileDir, { recursive: true });
async function openProfile() {
  return chromium.launchPersistentContext(profileDir, {
    channel: 'msedge', headless: false, viewport: null, ignoreDefaultArgs: ['--no-sandbox']
  });
}

let context = await openProfile();
try {
  let page = context.pages()[0] || await context.newPage();
  await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  // The anonymous landing shell briefly omits its login action during initial
  // hydration, so do not evaluate authentication until it has settled.
  await page.waitForTimeout(2_500);
  console.log(`AI-GEO-Monitor persistent profile: ${profileDir}`);
  console.log('Complete Doubao login manually in the visible Edge window. No credentials are read or stored by this command.');
  const startedAt = Date.now();
  while (Date.now() - startedAt < deadlineMs) {
    const state = await loginState(page).catch(() => ({ url: page.url(), loginControlVisible: true, authenticated: false }));
    if (state.authenticated) {
      console.log(`Manual Doubao login detected: ${state.url}`);
      break;
    }
    await page.waitForTimeout(intervalMs);
  }
  const authenticated = await loginState(page).then((state) => state.authenticated).catch(() => false);
  if (!authenticated) {
    console.log('Persistent profile created — waiting for manual Doubao login');
    process.exitCode = 2;
  } else {
    // Verify that authentication comes from the persistent profile, then retain
    // the second visible browser window for manual inspection rather than
    // closing it immediately after the check.
    await context.close();
    context = await openProfile();
    page = context.pages()[0] || await context.newPage();
    await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2_500);
    const restarted = await loginState(page);
    if (!restarted.authenticated) {
      console.log(`Persistent Doubao login did not survive restart: ${restarted.url}`);
      process.exitCode = 1;
    } else {
      console.log(`Persistent Doubao login verified after restart: ${restarted.url}`);
      console.log('The verified project Edge window will remain open for up to ten minutes; close it manually when finished.');
      await page.waitForTimeout(deadlineMs);
    }
  }
} finally {
  await context.close();
}
