(function installExtensionSnapshotBackground(global) {
  'use strict';

  const DOUBAO_READY = 'AI_GEO_DOUBAO_SNAPSHOT_READY';
  const DEEPSEEK_READY = 'AI_GEO_DEEPSEEK_SNAPSHOT_READY';
  const YUANBAO_READY = 'AI_GEO_YUANBAO_SNAPSHOT_READY';
  const WENXIN_READY = 'AI_GEO_WENXIN_SNAPSHOT_READY';
  const DOUBAO_PREPARE = 'AI_GEO_DOUBAO_SNAPSHOT_PREPARE';
  const DEEPSEEK_PREPARE = 'AI_GEO_DEEPSEEK_SNAPSHOT_PREPARE';
  const YUANBAO_PREPARE = 'AI_GEO_YUANBAO_SNAPSHOT_PREPARE';
  const WENXIN_PREPARE = 'AI_GEO_WENXIN_SNAPSHOT_PREPARE';
  const DEEPSEEK_FREEZE = 'AI_GEO_DEEPSEEK_SNAPSHOT_FREEZE';
  const DOUBAO_RESTORE = 'AI_GEO_DOUBAO_SNAPSHOT_RESTORE';
  const DEBUG = 'GET_SNAPSHOT_DEBUG_STATE';
  const DEBUG_KEY = 'ai_geo_doubao_snapshot_debug';
  const SNAPSHOT_DATABASE = 'ai_geo_monitor_snapshots';
  const SNAPSHOT_STORE = 'snapshots';
  const inFlight = new Set();
  const completed = new Set();
  let debugState = Object.freeze({ timestamp: null, status: 'idle', last_error: null });

  async function updateDebug(changes) {
    debugState = Object.freeze({ ...debugState, ...changes, timestamp: new Date().toISOString() });
    try { await global.chrome.storage?.session?.set({ [DEBUG_KEY]: debugState }); } catch (_) {}
    return debugState;
  }

  async function readDebug() {
    try {
      const stored = await global.chrome.storage?.session?.get(DEBUG_KEY);
      return stored?.[DEBUG_KEY] || debugState;
    } catch (_) {
      return debugState;
    }
  }

  function snapshotIdentity({ trigger }) {
    return [trigger.platform, trigger.conversation_url].join('|');
  }

  function filename(platform) {
    const capturedAt = new Date().toISOString().replace(/[:.]/g, '-');
    return platform === 'deepseek'
      ? `deepseek-dead-snapshot-v3-${capturedAt}.html`
      : platform === 'yuanbao'
        ? `yuanbao-snapshot-${capturedAt}.mhtml`
        : platform === 'wenxin'
          ? `wenxin-snapshot-${capturedAt}.mhtml`
      : `doubao-cropped-snapshot-v4-${capturedAt}.mhtml`;
  }

  function conversationId(conversationUrl) {
    try { return new URL(conversationUrl).pathname.match(/^\/chat\/([^/?#]+)$/)?.[1] || null; } catch (_) { return null; }
  }

  function base64DataUrl(mimeType, bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `data:${mimeType || 'application/octet-stream'};base64,${global.btoa(binary)}`;
  }

  function quotedPrintableBytes(value) {
    const output = [];
    const normalized = String(value || '').replace(/=\r?\n/g, '');
    for (let index = 0; index < normalized.length; index += 1) {
      if (normalized[index] === '=' && /^[0-9a-f]{2}$/i.test(normalized.slice(index + 1, index + 3))) {
        output.push(Number.parseInt(normalized.slice(index + 1, index + 3), 16));
        index += 2;
      } else output.push(normalized.charCodeAt(index) & 0xff);
    }
    return new Uint8Array(output);
  }

  function decodeResourceText(bytes) {
    try { return new global.TextDecoder().decode(bytes); } catch (_) { return ''; }
  }

  function mhtmlResources(rawMhtml) {
    const boundary = /boundary\s*=\s*"?([^";\r\n]+)"?/i.exec(rawMhtml)?.[1];
    if (!boundary) return [];
    const resources = [];
    for (const section of rawMhtml.split(`--${boundary}`).slice(1)) {
      const separator = /\r?\n\r?\n/.exec(section);
      if (!separator) continue;
      const headers = section.slice(0, separator.index);
      const body = section.slice(separator.index + separator[0].length).replace(/\r?\n$/, '');
      const location = /^Content-Location:\s*(.+)$/im.exec(headers)?.[1]?.trim();
      if (!location) continue;
      const mimeType = /^Content-Type:\s*([^;\r\n]+)/im.exec(headers)?.[1]?.trim() || 'application/octet-stream';
      const encoding = /^Content-Transfer-Encoding:\s*(.+)$/im.exec(headers)?.[1]?.trim().toLowerCase();
      let bytes;
      if (encoding === 'base64') {
        try { bytes = Uint8Array.from(global.atob(body.replace(/\s/g, '')), (character) => character.charCodeAt(0)); } catch (_) { continue; }
      } else if (encoding === 'quoted-printable') bytes = quotedPrintableBytes(body);
      else bytes = new global.TextEncoder().encode(body);
      const keys = [location, location.replace(/#.*/, '')];
      try { keys.push(decodeURIComponent(location), decodeURIComponent(location.replace(/#.*/, ''))); } catch (_) {}
      resources.push({ keys: [...new Set(keys)], mime_type: mimeType, data_url: base64DataUrl(mimeType, bytes), text: /(?:css|javascript|json|xml|svg)/i.test(mimeType) ? decodeResourceText(bytes) : null });
    }
    return resources;
  }

  function openSnapshotDatabase() {
    if (!global.indexedDB) throw new Error('IndexedDB is unavailable for Extension Snapshot storage.');
    return new Promise((resolve, reject) => {
      const request = global.indexedDB.open(SNAPSHOT_DATABASE, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(SNAPSHOT_STORE)) request.result.createObjectStore(SNAPSHOT_STORE, { keyPath: 'snapshot_id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Unable to open Extension Snapshot storage.'));
    });
  }

  async function storeSnapshot(record) {
    const database = await openSnapshotDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(SNAPSHOT_STORE, 'readwrite');
        const request = transaction.objectStore(SNAPSHOT_STORE).put(record);
        request.onerror = () => reject(request.error || new Error('Unable to store Extension Snapshot.'));
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error('Unable to store Extension Snapshot.'));
        transaction.onabort = () => reject(transaction.error || new Error('Extension Snapshot storage was aborted.'));
      });
    } finally {
      database.close?.();
    }
  }

  async function capture(sender, message) {
    const platform = message.trigger.platform;
    const tabId = sender?.tab?.id;
    if (!Number.isInteger(tabId)) throw new Error(`${platform} Snapshot requires a tab sender.`);
    const key = snapshotIdentity(message);
    if (inFlight.has(key) || completed.has(key)) {
      await updateDebug({ trigger_seen: true, trigger_sent: true, background_received: true, status: 'deduped', conversation_url: message.trigger.conversation_url, observation_id: message.trigger.observation_id || null });
      return { status: 'deduped' };
    }
    inFlight.add(key);
    await updateDebug({ trigger_seen: true, trigger_sent: true, background_received: true, status: 'received', conversation_url: message.trigger.conversation_url, observation_id: message.trigger.observation_id || null, last_error: null });
    const snapshotId = key;
    let prepared = false;
    try {
      await updateDebug({ prepare_started: true, prepare_ok: false, prepare_failed: false, status: 'preparing' });
      const prepareType = platform === 'deepseek'
        ? DEEPSEEK_PREPARE
        : platform === 'yuanbao'
          ? YUANBAO_PREPARE
          : platform === 'wenxin'
            ? WENXIN_PREPARE
          : DOUBAO_PREPARE;
      const preparation = await global.chrome.tabs.sendMessage(tabId, { type: prepareType, snapshot_id: snapshotId });
      if (!preparation?.prepared) {
        const error = new Error(preparation?.error || `${platform} Snapshot preparation failed.`);
        await updateDebug({ prepare_failed: true, status: 'failed', last_error: error.message });
        throw error;
      }
      prepared = true;
      await updateDebug({ prepare_ok: true, capture_started: true, capture_ok: false, capture_failed: false, status: 'capturing' });
      let blob;
      try {
        if (platform === 'deepseek') {
          const rawMhtml = await global.chrome.pageCapture.saveAsMHTML({ tabId });
          if (!rawMhtml || typeof rawMhtml.text !== 'function' || rawMhtml.size === 0) throw new Error('DeepSeek MHTML resource capture returned no data.');
          const frozen = await global.chrome.tabs.sendMessage(tabId, {
            type: DEEPSEEK_FREEZE,
            snapshot_id: snapshotId,
            expected: preparation.expected || 0,
            resources: mhtmlResources(await rawMhtml.text())
          });
          if (typeof frozen?.artifact_html !== 'string' || !frozen.artifact_html.trim()) throw new Error(frozen?.error || 'DeepSeek dead Snapshot serialization returned no HTML.');
          blob = new Blob([frozen.artifact_html], { type: 'text/html' });
        } else {
          blob = await global.chrome.pageCapture.saveAsMHTML({ tabId });
          if (!blob || typeof blob.arrayBuffer !== 'function' || blob.size === 0) throw new Error(`${platform} MHTML capture returned no data.`);
        }
      } catch (error) {
        await updateDebug({ capture_failed: true, status: 'failed', last_error: String(error?.message || error) });
        throw error;
      }
      await updateDebug({ capture_ok: true, captured_blob_bytes: blob.size, storage_started: true, storage_ok: false, storage_failed: false, snapshot_id: snapshotId, stored_bytes: null, status: 'storing' });
      try {
        await storeSnapshot({
          snapshot_id: snapshotId,
          platform,
          conversation_url: message.trigger.conversation_url,
          conversation_id: conversationId(message.trigger.conversation_url),
          observation_id: message.trigger.observation_id || null,
          captured_at: new Date().toISOString(),
          bytes: blob.size,
          mime_type: blob.type || 'multipart/related',
          filename: filename(platform),
          blob
        });
        completed.add(key);
        await updateDebug({ storage_ok: true, storage_failed: false, stored_bytes: blob.size, status: 'stored' });
        return { status: 'captured', snapshot_id: snapshotId, bytes: blob.size };
      } catch (error) {
        await updateDebug({ storage_failed: true, status: 'failed', last_error: String(error?.message || error) });
        throw error;
      }
    } finally {
      inFlight.delete(key);
      if (prepared && platform === 'doubao') await global.chrome.tabs.sendMessage(tabId, { type: DOUBAO_RESTORE, snapshot_id: snapshotId }).catch(() => {});
    }
  }

  global.chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === DEBUG) {
      readDebug().then(sendResponse);
      return true;
    }
    const isDoubao = message?.type === DOUBAO_READY && message?.trigger?.platform === 'doubao';
    const isDeepSeek = message?.type === DEEPSEEK_READY && message?.trigger?.platform === 'deepseek';
    const isYuanbao = message?.type === YUANBAO_READY && message?.trigger?.platform === 'yuanbao';
    const isWenxin = message?.type === WENXIN_READY && message?.trigger?.platform === 'wenxin';
    if (!isDoubao && !isDeepSeek && !isYuanbao && !isWenxin) return false;
    capture(sender, message).then(sendResponse).catch((error) => {
      console.error(`[AI-GEO ${message.trigger.platform} Snapshot]`, error);
      sendResponse({ status: 'failed', error: String(error?.message || error) });
    });
    return true;
  });

})(globalThis);
