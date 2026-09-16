(function installUnifiedExtensionRuntime(global) {
  'use strict';

  const STATUS_KEY = '__AI_GEO_UNIFIED_EXTENSION_RUNTIME_STATUS__';
  const initialStatus = {
    state: 'starting',
    platform_id: null,
    adapter_status: 'inactive',
    observation_status: 'not_implemented',
    publish_count: 0,
    semantic_fingerprint: null,
    failure_reason: null
  };

  function setStatus(changes) {
    global[STATUS_KEY] = Object.freeze({ ...global[STATUS_KEY], ...changes });
    return global[STATUS_KEY];
  }

  function activatePlatform(platformId) {
    const descriptor = (global.__AI_GEO_UNIFIED_PLATFORM_REGISTRY__ || []).find((entry) => entry.id === platformId);
    const resolved = global.__AI_GEO_UNIFIED_PLATFORM_ROUTER__?.resolvePlatform();
    if (!descriptor || !resolved || resolved.id !== platformId) {
      setStatus({ state: 'inactive', adapter_status: 'inactive', failure_reason: 'platform_route_mismatch' });
      return null;
    }
    setStatus({ state: 'active', platform_id: platformId, adapter_status: 'registered', failure_reason: null });
    return Object.freeze({
      descriptor,
      publishObservation(observation, semanticFingerprint) {
        if (!observation || typeof observation !== 'object') throw new Error('Observation must be plain data.');
        const current = global[STATUS_KEY];
        if (semanticFingerprint && semanticFingerprint === current.semantic_fingerprint) return false;
        setStatus({ observation_status: 'stable', publish_count: current.publish_count + 1, semantic_fingerprint: semanticFingerprint || null });
        global.__AI_GEO_OBSERVATION_SNAPSHOT_TRIGGER__?.triggerFor({
          platform: descriptor.id,
          observation,
          observationId: semanticFingerprint || null
        });
        return true;
      }
    });
  }

  global[STATUS_KEY] = Object.freeze(initialStatus);
  global.__AI_GEO_UNIFIED_EXTENSION_RUNTIME__ = Object.freeze({ activatePlatform, statusKey: STATUS_KEY });
})(globalThis);
