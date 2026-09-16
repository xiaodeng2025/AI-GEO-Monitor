import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime, DEFAULT_VIEWPORT } from '../src/core/browser-runtime.js';
import { yuanbaoRuntimeConfig } from '../src/platforms/yuanbao/yuanbao-runtime-config.js';

test('BrowserRuntime retains its fixed viewport by default', () => {
  const runtime = new BrowserRuntime({ profileDir: 'profiles/kimi' });
  assert.deepEqual(runtime.contextOptions(), {
    headless: false,
    slowMo: 0,
    viewport: DEFAULT_VIEWPORT
  });
  assert.deepEqual(DEFAULT_VIEWPORT, { width: 1440, height: 1100 });
});

test('BrowserRuntime accepts an explicit null viewport', () => {
  const runtime = new BrowserRuntime({ profileDir: 'profiles/yuanbao', viewport: null });
  assert.equal(runtime.contextOptions().viewport, null);
});

test('Yuanbao runtime configuration does not alter BrowserRuntime defaults', () => {
  const kimiRuntime = new BrowserRuntime({ profileDir: 'profiles/kimi' });
  const yuanbaoRuntime = new BrowserRuntime({ profileDir: 'profiles/yuanbao', ...yuanbaoRuntimeConfig });

  assert.deepEqual(kimiRuntime.contextOptions().viewport, DEFAULT_VIEWPORT);
  assert.equal(yuanbaoRuntime.contextOptions().viewport, null);
});
