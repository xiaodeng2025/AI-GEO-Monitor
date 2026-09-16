import { resolve } from 'node:path';
import { ArtifactStore } from '../core/artifact-store.js';
import { BrowserRuntime } from '../core/browser-runtime.js';
import { RunService } from '../core/run-service.js';
import { KIMI_CAPABILITY } from '../platforms/kimi/kimi-adapter.js';
import { DEEPSEEK_CAPABILITY } from '../platforms/deepseek/deepseek-adapter.js';
import { YUANBAO_CAPABILITY } from '../platforms/yuanbao/yuanbao-adapter.js';
import { yuanbaoRuntimeConfig } from '../platforms/yuanbao/yuanbao-runtime-config.js';
import { DeepSeekPlaywrightSession } from '../runtime/playwright/deepseek-playwright-session.js';
import { KimiPlaywrightSession } from '../runtime/playwright/kimi-playwright-session.js';
import { PlaywrightEvidenceProvider } from '../runtime/playwright/playwright-evidence-provider.js';
import { YuanbaoPlaywrightSession } from '../runtime/playwright/yuanbao-playwright-session.js';

const DEFINITIONS = Object.freeze({
  kimi: { capability: KIMI_CAPABILITY, parserVersion: 'kimi-web-2026-09-02.1', timeoutMs: 90_000 },
  yuanbao: { capability: YUANBAO_CAPABILITY, parserVersion: 'yuanbao-web-2026-09-03.1', timeoutMs: 120_000 },
  deepseek: { capability: DEEPSEEK_CAPABILITY, parserVersion: 'deepseek-web-2026-09-03.1', timeoutMs: 90_000 }
});

function definitionFor(platform) {
  const definition = DEFINITIONS[platform];
  if (!definition) throw new Error(`Unsupported production platform: ${platform}`);
  return definition;
}

/**
 * Builds one platform-specific runtime while keeping its Adapter and Session
 * knowledge at the runtime boundary. No browser is opened until session.run().
 */
export function createPlatformRuntime({ platform, repository, artifactStore, profilesRoot = resolve('profiles'), timeoutMs = null }) {
  const definition = definitionFor(platform);
  const effectiveTimeout = timeoutMs ?? definition.timeoutMs;
  const runtimeOptions = platform === 'kimi'
    ? { profileDir: resolve(profilesRoot, 'kimi'), headless: false, viewport: null }
    : platform === 'yuanbao'
      ? { profileDir: resolve(profilesRoot, 'yuanbao'), headless: false, ...yuanbaoRuntimeConfig }
      : { profileDir: resolve(profilesRoot, 'deepseek'), headless: false, viewport: null, args: ['--start-maximized'] };
  const runtime = new BrowserRuntime(runtimeOptions);
  const evidenceProvider = new PlaywrightEvidenceProvider();
  const session = platform === 'kimi'
    ? new KimiPlaywrightSession({ runtime, evidenceProvider })
    : platform === 'yuanbao'
      ? new YuanbaoPlaywrightSession({ runtime, evidenceProvider })
      : new DeepSeekPlaywrightSession({ runtime, evidenceProvider });
  const service = new RunService({ repository, artifactStore, parserVersion: definition.parserVersion, timeoutMs: effectiveTimeout });
  return { ...definition, service, session, closeSession: () => session.close() };
}

export class PlatformRuntimeFactory {
  constructor({ repository, artifactStore = new ArtifactStore({ rootDir: resolve('artifacts') }), profilesRoot = resolve('profiles'), timeoutMsByPlatform = {} }) {
    if (!repository) throw new Error('PlatformRuntimeFactory requires a repository.');
    this.repository = repository;
    this.artifactStore = artifactStore;
    this.profilesRoot = profilesRoot;
    this.timeoutMsByPlatform = timeoutMsByPlatform;
  }

  create(platform) {
    return createPlatformRuntime({
      platform,
      repository: this.repository,
      artifactStore: this.artifactStore,
      profilesRoot: this.profilesRoot,
      timeoutMs: this.timeoutMsByPlatform[platform] ?? null
    });
  }
}

export const PRODUCTION_PLATFORM_DEFINITIONS = DEFINITIONS;
