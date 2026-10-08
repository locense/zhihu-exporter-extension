import { ERROR_CODE, MESSAGE } from '../shared/constants.js';
import { sleep } from '../shared/utils.js';

function abortError() {
  const error = new Error('任务已取消');
  error.name = 'AbortError';
  error.code = ERROR_CODE.CANCELLED;
  return error;
}

function waitForTabComplete(tabId, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      callback(value);
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish(resolve);
    };
    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) finish(reject, new Error('读取页面被关闭'));
    };
    const onAbort = () => finish(reject, abortError());
    const timer = setTimeout(() => finish(reject, new Error('页面加载超时')), timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    signal?.addEventListener?.('abort', onAbort, { once: true });

    chrome.tabs.get(tabId)
      .then((tab) => {
        if (tab.status === 'complete') finish(resolve);
      })
      .catch((error) => finish(reject, error));
  });
}

async function sendTabMessage(tabId, message, options = {}) {
  const attempts = options.attempts ?? 30;
  const delayMs = options.delayMs ?? 500;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) throw abortError();
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      lastError = error;
      await sleep(delayMs);
    }
  }
  throw lastError || new Error('无法连接知乎页面脚本');
}

async function withHiddenTab(url, callback, options = {}) {
  const signal = options.signal;
  if (signal?.aborted) throw abortError();
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    if (!tab?.id) throw new Error('无法创建后台页面');
    await waitForTabComplete(tab.id, options.loadTimeoutMs ?? 45000, signal);
    return await callback(tab.id);
  } finally {
    if (tab?.id) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        // The tab may already have been closed by the user.
      }
    }
  }
}

function ensureResponse(response, action) {
  if (!response?.ok) {
    const error = new Error(response?.error || `${action}失败`);
    error.code = response?.code;
    throw error;
  }
  return response;
}

export async function parseArticleInTab(url, options = {}) {
  return withHiddenTab(url, async (tabId) => {
    const response = await sendTabMessage(tabId, {
      type: MESSAGE.PARSE_ARTICLE,
      waitMs: options.waitMs ?? 20000
    }, { signal: options.signal, attempts: options.attempts ?? 40 });
    return ensureResponse(response, '读取文章').article;
  }, options);
}

export async function discoverCollectionsInTab(options = {}) {
  return withHiddenTab('https://www.zhihu.com/collections', async (tabId) => {
    const response = await sendTabMessage(tabId, {
      type: MESSAGE.EXTRACT_COLLECTIONS,
      options: { loadAllTabs: true, tabWaitMs: options.tabWaitMs ?? 1200 }
    }, {
      signal: options.signal,
      attempts: options.attempts ?? 30
    });
    return ensureResponse(response, '读取收藏夹列表');
  }, options);
}

export async function extractCollectionInTab(url, options = {}) {
  return withHiddenTab(url, async (tabId) => {
    const collected = new Map();
    const warnings = [];
    let collection = null;
    let currentUrl = url;
    let reachedEnd = false;
    const maxPages = options.maxPages ?? 50;

    for (let page = 0; page < maxPages; page += 1) {
      const response = await sendTabMessage(tabId, {
        type: MESSAGE.EXTRACT_COLLECTION_ITEMS,
        loadAll: options.loadAll !== false,
        options: {
          maxSteps: options.maxSteps,
          stableRoundsToStop: options.stableRoundsToStop,
          waitMs: options.waitMs
        }
      }, { signal: options.signal, attempts: options.attempts ?? 40 });
      ensureResponse(response, '读取收藏夹内容');
      collection = response.collection || collection;
      for (const item of response.items || []) collected.set(`${item.type}:${item.contentId || item.url}`, item);
      for (const warning of response.warnings || []) if (!warnings.includes(warning)) warnings.push(warning);
      reachedEnd = Boolean(response.reachedEnd);
      const nextUrl = String(response.nextUrl || '');
      if (!nextUrl || nextUrl === currentUrl) break;
      currentUrl = nextUrl;
      await chrome.tabs.update(tabId, { url: nextUrl });
      await waitForTabComplete(tabId, options.loadTimeoutMs ?? 45000, options.signal);
    }

    if (collected.size && !reachedEnd && !warnings.length) warnings.push('分页读取可能未覆盖全部条目');
    return { collection, items: [...collected.values()], reachedEnd, warnings };
  }, options);
}
