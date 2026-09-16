(function installSnapshotDebugPage(global) {
  'use strict';

  const DATABASE = 'ai_geo_monitor_snapshots';
  const STORE = 'snapshots';
  const empty = document.getElementById('empty');
  const details = document.getElementById('details');
  const exportButton = document.getElementById('export');
  const saveStatus = document.getElementById('save-status');
  let latest = null;

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = global.indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'snapshot_id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('无法读取快照。'));
    });
  }

  async function latestSnapshot() {
    const database = await openDatabase();
    try {
      const records = await new Promise((resolve, reject) => {
        const request = database.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || new Error('无法读取快照。'));
      });
      return records.sort((left, right) => String(right.captured_at).localeCompare(String(left.captured_at)))[0] || null;
    } finally { database.close?.(); }
  }

  function render(record) {
    latest = record;
    empty.hidden = Boolean(record);
    details.hidden = !record;
    exportButton.disabled = !record;
    if (!record) return;
    document.getElementById('platform').textContent = record.platform || '';
    document.getElementById('captured-at').textContent = record.captured_at || '';
    document.getElementById('conversation-url').textContent = record.conversation_url || '';
    document.getElementById('bytes').textContent = `${record.bytes || 0} bytes`;
    document.getElementById('snapshot-id').textContent = record.snapshot_id || '';
  }

  async function load() {
    try { render(await latestSnapshot()); } catch (_) { render(null); }
  }

  function exportFilename(record) {
    const timestamp = String(record.captured_at || new Date().toISOString()).replace(/[:.]/g, '-');
    return record.filename || `snapshot-${timestamp}.mhtml`;
  }

  exportButton.addEventListener('click', async () => {
    if (!latest?.blob) return;
    if (typeof global.showSaveFilePicker !== 'function') {
      saveStatus.textContent = '当前浏览器不支持直接保存测试快照。';
      return;
    }
    try {
      const handle = await global.showSaveFilePicker({
        suggestedName: exportFilename(latest),
        types: [{ description: 'MHTML Snapshot', accept: { 'multipart/related': ['.mhtml'] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(latest.blob);
      await writable.close();
      saveStatus.textContent = '测试快照已保存。';
    } catch (error) {
      saveStatus.textContent = error?.name === 'AbortError' ? '已取消保存。' : '保存测试快照失败。';
    }
  });

  load();
})(globalThis);
