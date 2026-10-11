import { MESSAGE, OUTPUT_FORMAT } from '../shared/constants.js';
import {
  collectQuestionAnswers,
  extractArticleFromDocument,
  extractCollectionItemsFromDocument,
  extractCollectionsFromAllTabs,
  extractCollectionsFromDocument,
  extractFeedItems,
  loadAllCollectionItems
} from './parser.js';
import { isArticlePageUrl, isCollectionPageUrl, isQuestionPageUrl, normalizeWhitespace, parseZhihuUrl, sleep } from '../shared/utils.js';

const TOOLBAR_ID = 'zhihu-exporter-toolbar';
const CARD_BUTTON_CLASS = 'zhihu-exporter-card-button';
let currentRoute = '';
let routeTimer = null;
let cardObserver = null;
let cardTimer = null;

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

async function exportUrl(url, button, title = '') {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = '提交中…';
  try {
    const parsed = parseZhihuUrl(url);
    const response = await sendRuntimeMessage({
      type: MESSAGE.EXPORT_URL,
      url,
      format: OUTPUT_FORMAT.ZIP,
      metadata: { title, author: { name: '', url: '' }, contentId: parsed.id || '', type: parsed.type }
    });
    if (!response?.ok) throw new Error(response?.error || '导出任务创建失败');
    button.textContent = '已排队';
    showToast(`已加入队列：${title || parsed.canonicalUrl}`, 'success');
  } catch (error) {
    button.textContent = '失败';
    showToast(`导出失败：${error.message || error}`, 'error');
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = originalText;
    }, 1800);
  }
}

function findCardActionAnchor(card) {
  const selectors = ['.ContentItem-actions', '.AnswerActions', '.RichContent-actions', '[class*="Actions"]', '[class*="actions"]'];
  for (const selector of selectors) {
    const element = card?.querySelector?.(selector);
    if (element) return element;
  }
  return card;
}

function createCardButton(item) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = CARD_BUTTON_CLASS;
  button.textContent = '导出';
  button.title = `用知乎导出器下载：${item.title || item.url}`;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    exportUrl(item.url, button, item.title);
  });
  return button;
}

function injectCardButtons() {
  if (!document.body || isArticlePageUrl(location.href) || isCollectionPageUrl(location.href)) return;
  for (const item of extractFeedItems(document, location.href)) {
    const card = item.card;
    if (!card) continue;
    const existing = [...card.querySelectorAll(`.${CARD_BUTTON_CLASS}`)].some((button) => button.dataset.zhihuExportUrl === item.url);
    if (existing) continue;
    const button = createCardButton(item);
    button.dataset.zhihuExportUrl = item.url;
    button.setAttribute('data-zhihu-exporter-ui', 'true');
    const anchor = findCardActionAnchor(card);
    if (anchor === card) card.append(button);
    else anchor.prepend(button);
  }
}

function scheduleCardScan() {
  clearTimeout(cardTimer);
  cardTimer = setTimeout(injectCardButtons, 300);
}

function startCardObserver() {
  if (cardObserver || !document.body) return;
  cardObserver = new MutationObserver(scheduleCardScan);
  cardObserver.observe(document.body, { childList: true, subtree: true });
  scheduleCardScan();
}

async function exportQuestionBatch(button, loadAll) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = loadAll ? '加载回答中…' : '读取回答中…';
  try {
    const result = await collectQuestionAnswers(document, window, {
      maxSteps: loadAll ? 40 : 1,
      stableRoundsToStop: loadAll ? 3 : 1,
      waitMs: loadAll ? 800 : 300,
      baseUrl: location.href
    });
    if (!result.items.length) throw new Error('没有读取到可导出的回答');
    const items = result.items.map(({ card, ...item }) => item);
    const response = await sendRuntimeMessage({
      type: MESSAGE.START_BATCH,
      format: OUTPUT_FORMAT.ZIP,
      mergeCollections: false,
      collections: [{
        id: `question-${result.question.id}`,
        title: result.question.title || '知乎问题回答',
        url: location.href,
        visibility: 'unknown',
        listType: 'question',
        items
      }]
    });
    if (!response?.ok) throw new Error(response?.error || '批量任务创建失败');
    showToast(`已加入 ${response.taskCount} 个回答，完成后自动生成 ZIP`, 'success');
  } catch (error) {
    showToast(`导出失败：${error.message || error}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function createQuestionToolbar() {
  const existing = document.getElementById(TOOLBAR_ID);
  if (existing) return existing;
  const toolbar = document.createElement('div');
  toolbar.id = TOOLBAR_ID;
  toolbar.className = 'zhihu-exporter-toolbar';
  toolbar.setAttribute('data-zhihu-exporter-ui', 'true');
  const label = document.createElement('span');
  label.className = 'zhihu-exporter-label';
  label.textContent = '问题导出';
  const loadedButton = makeButton('导出已加载回答', '导出当前页面已经加载的回答', (event) => exportQuestionBatch(event.currentTarget, false));
  const allButton = makeButton('加载并导出全部', '自动滚动并导出当前问题尽可能多的回答', (event) => exportQuestionBatch(event.currentTarget, true));
  const status = document.createElement('span');
  status.className = 'zhihu-exporter-status';
  status.textContent = '每个回答独立获取正文';
  toolbar.append(label, loadedButton, allButton, status);
  const anchor = document.querySelector('.QuestionHeader') || document.querySelector('.QuestionHeader-title')?.parentElement;
  if (anchor?.parentElement) anchor.insertAdjacentElement('afterend', toolbar);
  else {
    toolbar.classList.add('floating');
    document.documentElement.appendChild(toolbar);
  }
  return toolbar;
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
  else if (isQuestionPageUrl(route)) createQuestionToolbar();
  else if (isCollectionPageUrl(route)) injectCollectionToolbar();
  scheduleCardScan();
}

function bootstrapRouteWatcher() {
  routeChanged();
  startCardObserver();
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

  if (message.type === MESSAGE.EXTRACT_QUESTION_ANSWERS) {
    collectQuestionAnswers(document, window, message.options || {})
      .then((result) => sendResponse({ ok: true, ...result, items: result.items.map(({ card, ...item }) => item) }))
      .catch((error) => sendResponse({ ok: false, error: error.message, code: error.code }));
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
