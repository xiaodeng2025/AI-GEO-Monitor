(function installObservationSnapshotTrigger(global) {
  'use strict';

  const CONTEXT_KEY = '__AI_GEO_OBSERVATION_SNAPSHOT_CONTEXT__';
  const TRANSPORT_KEY = '__AI_GEO_OBSERVATION_SNAPSHOT_TRANSPORT__';
  const MESSAGE_NAMESPACE = 'AI_GEO_OBSERVATION_SNAPSHOT';
  const MESSAGE_TYPE = 'OBSERVATION_SNAPSHOT_READY';

  function optionalIdentity(context, key) {
    return typeof context?.[key] === 'string' && context[key] ? context[key] : null;
  }

  function isSnapshotReady(platform, observation) {
    if (platform === 'wenxin') {
      let conversationUrl;
      try { conversationUrl = new URL(observation?.conversation_url); } catch (_) { return false; }
      return conversationUrl.protocol === 'https:' &&
        conversationUrl.hostname === 'wenxin.baidu.com' &&
        /^\/search\/[^/]+$/.test(conversationUrl.pathname) &&
        observation?.observation_state === 'entry_observed' &&
        observation?.response?.present === true &&
        observation?.final_answer?.status === 'observed' &&
        typeof observation?.final_answer?.text === 'string' && observation.final_answer.text.trim().length > 0;
    }
    if (platform === 'yuanbao') {
      let conversationUrl;
      try { conversationUrl = new URL(observation?.conversation_url); } catch (_) { return false; }
      return conversationUrl.protocol === 'https:' &&
        conversationUrl.hostname === 'yuanbao.tencent.com' &&
        /^\/chat\/[^/]+\/[^/]+$/.test(conversationUrl.pathname) &&
        observation?.observation_state === 'expansion_complete' &&
        observation?.response?.attributes?.['data-conv-outputting'] === 'false';
    }
    if (platform !== 'doubao') return true;
    let conversationUrl;
    try { conversationUrl = new URL(observation?.conversation_url); } catch (_) { return false; }
    return conversationUrl.protocol === 'https:' &&
      conversationUrl.hostname === 'www.doubao.com' &&
      /^\/chat\/[^/]+$/.test(conversationUrl.pathname) &&
      observation?.observation_status === 'stable' &&
      observation?.question?.status === 'confirmed' &&
      observation?.answer?.status === 'confirmed';
  }

  function triggerFor({ platform, observation, observationId = null }) {
    const context = global[CONTEXT_KEY] || {
      session_id: global.document?.documentElement?.getAttribute('data-ai-geo-observation-session-id') || null,
      page_id: global.document?.documentElement?.getAttribute('data-ai-geo-observation-page-id') || null
    };
    const trigger = Object.freeze({
      type: 'observation_snapshot_ready',
      platform,
      observation_id: observationId || null,
      session_id: optionalIdentity(context, 'session_id'),
      page_id: optionalIdentity(context, 'page_id'),
      conversation_url: typeof observation?.conversation_url === 'string' ? observation.conversation_url : null,
      readiness: 'observation_ready'
    });
    if (!trigger.conversation_url || !isSnapshotReady(platform, observation)) return false;
    const transport = global[TRANSPORT_KEY];
    const envelope = { namespace: MESSAGE_NAMESPACE, type: MESSAGE_TYPE, trigger, observation };
    const readyMessageType = platform === 'doubao'
      ? 'AI_GEO_DOUBAO_SNAPSHOT_READY'
      : platform === 'deepseek'
        ? 'AI_GEO_DEEPSEEK_SNAPSHOT_READY'
        : platform === 'yuanbao'
          ? 'AI_GEO_YUANBAO_SNAPSHOT_READY'
          : platform === 'wenxin'
            ? 'AI_GEO_WENXIN_SNAPSHOT_READY'
        : null;
    if (readyMessageType && global.chrome?.runtime?.sendMessage) {
      try {
        const published = global.chrome.runtime.sendMessage({ type: readyMessageType, trigger, observation });
        if (published && typeof published.catch === 'function') published.catch(() => {});
        return true;
      } catch (_) {
        return false;
      }
    }
    if (typeof transport?.publish !== 'function') {
      try { global.postMessage(envelope, '*'); return true; } catch (_) { return false; }
    }
    try {
      const published = transport.publish({ trigger, observation });
      if (published && typeof published.catch === 'function') published.catch(() => {});
      return true;
    } catch (_) {
      return false;
    }
  }

  global.__AI_GEO_OBSERVATION_SNAPSHOT_TRIGGER__ = Object.freeze({ triggerFor });
})(globalThis);
