(function installUnifiedPlatformRouter(global) {
  'use strict';

  function resolvePlatform(pageUrl = global.location?.href, registry = global.__AI_GEO_UNIFIED_PLATFORM_REGISTRY__) {
    let url;
    try { url = new URL(pageUrl); } catch (_) { return null; }
    if (url.protocol !== 'https:') return null;
    return (registry || []).find((descriptor) => descriptor.exact_hosts.includes(url.hostname.toLowerCase())) || null;
  }

  global.__AI_GEO_UNIFIED_PLATFORM_ROUTER__ = Object.freeze({ resolvePlatform });
})(globalThis);
