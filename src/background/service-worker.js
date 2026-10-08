import { ERROR_CODE, MESSAGE, OUTPUT_FORMAT } from '../shared/constants.js';
import { dbGetAll, getSettings, saveSettings, STORES } from '../shared/db.js';
import {
  bootstrapQueue,
  cancelAll,
  cancelTask,
  clearHistory,
  enqueueArticle,
  enqueueBatch,
  getDashboardState,
  getQueueSummary,
  pauseQueue,
  pumpQueue,
  recoverAndFinalizeBatches,
  resumeQueue,
  retryTask
} from './queue.js';
import { discoverCollectionsInTab, extractCollectionInTab } from './tab-reader.js';
import { buildFailureReport, downloadBlob } from './exporters.js';

function responseError(error) {
  return {
    ok: false,
    error: String(error?.message || error || '未知错误'),
    code: error?.code || ERROR_CODE.UNKNOWN
  };
}

function toPublicCollection(collection) {
  return {
    id: collection.id || '',
    url: collection.url || (collection.id ? `https://www.zhihu.com/collection/${collection.id}` : ''),
    title: collection.title || `收藏夹-${collection.id || ''}`,
    count: collection.count ?? null,
    visibility: collection.visibility || 'unknown',
    description: collection.description || ''
  };
}

async function openManager(collectionUrl = '') {
  const url = new URL(chrome.runtime.getURL('pages/manager.html'));
  if (collectionUrl) url.searchParams.set('collection', collectionUrl);
  const tab = await chrome.tabs.create({ url: url.href, active: true });
  return { tabId: tab.id };
}

async function loadCollections(collections) {
  const output = [];
  for (const collection of collections || []) {
    const publicCollection = toPublicCollection(collection);
    try {
      const result = await extractCollectionInTab(publicCollection.url, { loadAll: true });
      output.push({
        ...publicCollection,
        ...(result.collection || {}),
        items: result.items || [],
        reachedEnd: Boolean(result.reachedEnd),
        warnings: result.warnings || [],
        error: ''
      });
    } catch (error) {
      output.push({
        ...publicCollection,
        items: [],
        reachedEnd: false,
        warnings: [],
        error: String(error?.message || error),
        errorCode: error?.code || ERROR_CODE.UNKNOWN
      });
    }
  }
  return output;
}

function validateBatchPayload(payload) {
  if (!Array.isArray(payload?.collections) || payload.collections.length === 0) throw new Error('没有选择收藏夹');
  const collections = payload.collections
    .map((collection) => ({ ...toPublicCollection(collection), items: Array.isArray(collection.items) ? collection.items : [] }))
    .filter((collection) => collection.items.length > 0);
  if (!collections.length) throw new Error('没有选择可导出的文章');
  const format = Object.values(OUTPUT_FORMAT).includes(payload.format) ? payload.format : OUTPUT_FORMAT.ZIP;
  return { collections, format };
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case MESSAGE.EXPORT_ARTICLE: {
      if (!message.article?.url) throw new Error('文章数据不完整');
      const format = Object.values(OUTPUT_FORMAT).includes(message.format) ? message.format : OUTPUT_FORMAT.MARKDOWN;
      const task = await enqueueArticle(message.article, format);
      return { taskId: task.id };
    }
    case MESSAGE.OPEN_MANAGER:
      return openManager(message.collectionUrl || '');
    case MESSAGE.DISCOVER_COLLECTIONS: {
      const result = await discoverCollectionsInTab();
      return { collections: (result.collections || []).map(toPublicCollection), warnings: result.warnings || [] };
    }
    case MESSAGE.LOAD_COLLECTIONS:
      return { collections: await loadCollections(message.collections || []) };
    case MESSAGE.START_BATCH: {
      const { collections, format } = validateBatchPayload(message);
      return enqueueBatch(collections, format);
    }
    case MESSAGE.GET_DASHBOARD_STATE:
      return getDashboardState();
    case MESSAGE.SAVE_SETTINGS: {
      const settings = await saveSettings(message.settings || {});
      return { settings };
    }
    case MESSAGE.PAUSE_QUEUE:
      return { queue: await pauseQueue() };
    case MESSAGE.RESUME_QUEUE:
      return { queue: await resumeQueue() };
    case MESSAGE.CANCEL_ALL:
      return { cancelled: await cancelAll() };
    case MESSAGE.RETRY_TASK:
      return { task: await retryTask(message.taskId) };
    case MESSAGE.CANCEL_TASK:
      return { task: await cancelTask(message.taskId) };
    case MESSAGE.EXPORT_FAILURE_REPORT: {
      const tasks = await dbGetAll(STORES.TASKS);
      const content = buildFailureReport(tasks);
      await downloadBlob(new Blob([content], { type: 'application/json;charset=utf-8' }), `知乎导出失败报告-${Date.now()}.json`, false);
      return { count: tasks.filter((task) => task.status === 'failed').length };
    }
    case MESSAGE.CLEAR_HISTORY:
      return { removed: await clearHistory() };
    default:
      throw new Error(`未知消息类型：${message?.type || ''}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type || message.type === MESSAGE.QUEUE_UPDATED || String(message.type).startsWith('OFFSCREEN_DOWNLOAD')) return false;
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...(result || {}) }))
    .catch((error) => sendResponse(responseError(error)));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('zhihu-exporter-queue', { periodInMinutes: 1 });
  bootstrapQueue().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('zhihu-exporter-queue', { periodInMinutes: 1 });
  bootstrapQueue().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'zhihu-exporter-queue') return;
  bootstrapQueue()
    .then(() => pumpQueue())
    .then(() => recoverAndFinalizeBatches())
    .catch(() => {});
});

bootstrapQueue().catch(() => {});
