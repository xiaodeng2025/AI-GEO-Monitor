(function installUnifiedPlatformRegistry(global) {
  'use strict';

  const descriptors = [
    {
      id: 'doubao',
      exact_hosts: ['www.doubao.com'],
      bootstrap_script: 'platforms/doubao/bootstrap.js',
      injection: { content_world: 'ISOLATED', future_probe_world: 'MAIN' }
    },
    {
      id: 'yuanbao',
      exact_hosts: ['yuanbao.tencent.com'],
      bootstrap_script: 'platforms/yuanbao/bootstrap.js',
      injection: { content_world: 'ISOLATED', future_probe_world: 'MAIN' }
    },
    {
      id: 'deepseek',
      exact_hosts: ['chat.deepseek.com'],
      bootstrap_script: 'platforms/deepseek/bootstrap.js',
      injection: { content_world: 'ISOLATED', future_probe_world: null }
    },
    {
      id: 'wenxin',
      exact_hosts: ['wenxin.baidu.com'],
      bootstrap_script: 'platforms/wenxin/bootstrap.js',
      injection: { content_world: 'ISOLATED', future_probe_world: 'MAIN' }
    }
  ];

  function createPlatformRegistry(entries) {
    if (!Array.isArray(entries) || entries.length === 0) throw new Error('Platform registry requires descriptors.');
    const ids = new Set();
    const hosts = new Set();
    const normalized = entries.map((entry) => {
      if (!entry || typeof entry.id !== 'string' || !entry.id) throw new Error('Platform descriptor requires an id.');
      if (ids.has(entry.id)) throw new Error(`Duplicate platform id: ${entry.id}`);
      ids.add(entry.id);
      if (!Array.isArray(entry.exact_hosts) || entry.exact_hosts.length === 0) throw new Error(`Platform descriptor requires exact hosts: ${entry.id}`);
      const exactHosts = entry.exact_hosts.map((host) => String(host).toLowerCase());
      exactHosts.forEach((host) => {
        if (!host || host.includes('*') || host.includes('/') || hosts.has(host)) throw new Error(`Invalid or duplicate exact host: ${host}`);
        hosts.add(host);
      });
      return Object.freeze({ ...entry, exact_hosts: Object.freeze(exactHosts) });
    });
    return Object.freeze(normalized);
  }

  global.__AI_GEO_UNIFIED_PLATFORM_REGISTRY__ = createPlatformRegistry(descriptors);
  global.__AI_GEO_UNIFIED_PLATFORM_REGISTRY_API__ = Object.freeze({ createPlatformRegistry });
})(globalThis);
