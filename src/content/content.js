import { MESSAGE, OUTPUT_FORMAT } from '../shared/constants.js';
import {
  extractArticleFromDocument,
  extractCollectionItemsFromDocument,
  extractCollectionsFromAllTabs,
  extractCollectionsFromDocument,
  loadAllCollectionItems
} from './parser.js';
import { isArticlePageUrl, isCollectionPageUrl, normalizeWhitespace, sleep } from '../shared/utils.js';

const TOOLBAR_ID = 'zhihu-exporter-toolbar';
let currentRoute = '';
let routeTimer = null;

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

function showToast(message, type = 'info') {
  let toast = document.getElementById('zhihu-exporter-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'zhihu-exporter-toast';
    document.documentElement.appendChild(toast);
  }
  toast.className = `zhihu-exporter-toast ${type}`;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => {
    toast.hidden = true;
  }, 4200);
}

function setToolbarStatus(text, type = 'info') {
  const status = document.querySelector(`#${TOOLBAR_ID} .zhihu-exporter-status`);
  if (!status) return;
  status.textContent = text;
  status.dataset.type = type;
}

function makeButton(label, title, handler, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `zhihu-exporter-button ${className}`.trim();
  button.textContent = label;
  button.title = title;
  button.addEventListener('click', handler);
  return button;
}

async function exportCurrentArticle(format, button) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = '准备中…';
  setToolbarStatus('正在读取页面正文…');
  try {
    const article = await extractArticleFromDocument(document, location.href);
    const response = await sendRuntimeMessage({ type: MESSAGE.EXPORT_ARTICLE, article, format });
    if (!response?.ok) throw new Error(response?.error || '导出任务创建失败');
    setToolbarStatus('已加入导出队列', 'success');
    showToast('已加入导出队列，可在扩展管理页查看进度', 'success');
  } catch (error) {
    setToolbarStatus(error.message || '导出失败', 'error');
    showToast(`导出失败：${error.message || error}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function findInsertionAnchor() {
  const selectors = [
    '.QuestionActions',
    '.ContentItem-actions',
    '.Post-ActionBar',
    '.Post-Sub',
    '.AuthorInfo',
    '.Post-Main'
  ];
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element) return element;
  }
  return null;
}

function createToolbar() {
  const existing = document.getElementById(TOOLBAR_ID);
  if (existing) return existing;

  const toolbar = document.createElement('div');
  toolbar.id = TOOLBAR_ID;
  toolbar.className = 'zhihu-exporter-toolbar';
  toolbar.setAttribute('data-zhihu-exporter-ui', 'true');

  const label = document.createElement('span');
  label.className = 'zhihu-exporter-label';
  label.textContent = '导出';

  const markdownButton = makeButton('Markdown', '导出为 Markdown 文件', (event) => exportCurrentArticle(OUTPUT_FORMAT.MARKDOWN, event.currentTarget));
  const textButton = makeButton('TXT', '导出为纯文本文件', (event) => exportCurrentArticle(OUTPUT_FORMAT.TEXT, event.currentTarget));
  const zipButton = makeButton('图片 ZIP', '导出 Markdown 和本地图片 ZIP', (event) => exportCurrentArticle(OUTPUT_FORMAT.ZIP, event.currentTarget));
  const copyButton = makeButton('复制链接', '复制当前原文链接', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setToolbarStatus('链接已复制', 'success');
    } catch {
      showToast('复制失败，请手动复制地址栏链接', 'error');
    }
  });

  const status = document.createElement('span');
  status.className = 'zhihu-exporter-status';
  status.textContent = '';

  toolbar.append(label, markdownButton, textButton, zipButton, copyButton, status);
  return toolbar;
}

async function injectArticleToolbar() {
  const toolbar = createToolbar();
  if (toolbar.isConnected) return;
  const anchor = findInsertionAnchor();
  if (anchor && anchor.parentElement) {
    anchor.insertAdjacentElement('afterend', toolbar);
  } else {
    toolbar.classList.add('floating');
    document.documentElement.appendChild(toolbar);
  }
}

function injectCollectionToolbar() {
  if (document.getElementById(TOOLBAR_ID)) return;
  const toolbar = document.createElement('div');
  toolbar.id = TOOLBAR_ID;
  toolbar.className = 'zhihu-exporter-toolbar floating collection-toolbar';
  toolbar.setAttribute('data-zhihu-exporter-ui', 'true');
  const label = document.createElement('span');
  label.className = 'zhihu-exporter-label';
  label.textContent = '收藏夹导出';
  const openButton = makeButton('打开批量管理器', '打开收藏夹批量导出管理器', async () => {
    try {
      await sendRuntimeMessage({ type: MESSAGE.OPEN_MANAGER, collectionUrl: location.href });
    } catch (error) {
      showToast(`无法打开管理器：${error.message}`, 'error');
    }
  });
  const status = document.createElement('span');
  status.className = 'zhihu-exporter-status';
  status.textContent = '支持多选、暂停和断点恢复';
  toolbar.append(label, openButton, status);
  document.documentElement.appendChild(toolbar);
}

function routeChanged() {
  const route = location.href;
  if (route === currentRoute) return;
  currentRoute = route;
  document.getElementById(TOOLBAR_ID)?.remove();
  if (!document.documentElement) return;
  if (isArticlePageUrl(route)) injectArticleToolbar().catch(() => {});
  else if (isCollectionPageUrl(route)) injectCollectionToolbar();
}

function bootstrapRouteWatcher() {
  routeChanged();
  if (routeTimer) return;
  routeTimer = setInterval(routeChanged, 1200);
  window.addEventListener('popstate', routeChanged, { passive: true });
  window.addEventListener('hashchange', routeChanged, { passive: true });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) return false;

  if (message.type === MESSAGE.PING) {
    sendResponse({ ok: true, url: location.href });
    return false;
  }

  if (message.type === MESSAGE.PARSE_ARTICLE) {
    extractArticleFromDocument(document, location.href, { waitMs: message.waitMs ?? 15000 })
      .then((article) => sendResponse({ ok: true, article }))
      .catch((error) => sendResponse({ ok: false, error: error.message, code: error.code }));
    return true;
  }

  if (message.type === MESSAGE.EXTRACT_COLLECTIONS) {
    extractCollectionsFromAllTabs(document, window, message.options || {})
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message, code: error.code }));
    return true;
  }

  if (message.type === MESSAGE.EXTRACT_COLLECTION_ITEMS) {
    (async () => {
      if (message.loadAll !== false) {
        const result = await loadAllCollectionItems(document, window, message.options || {});
        sendResponse({ ok: true, ...result });
      } else {
        const items = extractCollectionItemsFromDocument(document, location.href);
        sendResponse({ ok: true, items, reachedEnd: false, warnings: [] });
      }
    })().catch((error) => sendResponse({ ok: false, error: error.message, code: error.code }));
    return true;
  }

  if (message.type === MESSAGE.TRIGGER_EXPORT) {
    const buttons = document.querySelectorAll(`#${TOOLBAR_ID} .zhihu-exporter-button`);
    const target = buttons[message.format === OUTPUT_FORMAT.TEXT ? 1 : message.format === OUTPUT_FORMAT.ZIP ? 2 : 0];
    target?.click();
    sendResponse({ ok: Boolean(target) });
    return false;
  }

  return false;
});

if (window.top === window) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrapRouteWatcher, { once: true });
  else bootstrapRouteWatcher();
}

window.addEventListener('unhandledrejection', (event) => {
  const reason = normalizeWhitespace(String(event.reason?.message || event.reason || ''));
  if (reason) showToast(`扩展后台错误：${reason}`, 'error');
});
