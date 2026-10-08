import { MESSAGE, OUTPUT_FORMAT, TASK_STATUS } from '../shared/constants.js';
import { parseZhihuUrl, toPositiveInt } from '../shared/utils.js';

const state = {
  collections: [],
  loaded: new Map(),
  selectedCollectionIds: new Set(),
  selectedItemKeys: new Set(),
  dashboard: null,
  settingsDirty: false,
  typeFilter: 'all',
  collectionListFilter: 'all',
  refreshTimer: null
};

const elements = {
  queueSummary: document.getElementById('queue-summary'),
  collectionList: document.getElementById('collection-list'),
  collectionStatus: document.getElementById('collection-status'),
  batchFormat: document.getElementById('batch-format'),
  collectionListFilter: document.getElementById('collection-list-filter'),
  itemTypeFilter: document.getElementById('item-type-filter'),
  taskCounts: document.getElementById('task-counts'),
  taskList: document.getElementById('task-list'),
  batchList: document.getElementById('batch-list'),
  toast: document.getElementById('toast'),
  pauseButton: document.getElementById('pause-button'),
  resumeButton: document.getElementById('resume-button')
};

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (!response?.ok) reject(new Error(response?.error || '操作失败'));
      else resolve(response);
    });
  });
}

function createElement(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function makeButton(label, className, action, payload = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  Object.assign(button.dataset, action, payload);
  return button;
}

function showToast(message, type = 'info') {
  elements.toast.textContent = message;
  elements.toast.className = `toast ${type}`;
  elements.toast.hidden = false;
  clearTimeout(elements.toast._timer);
  elements.toast._timer = setTimeout(() => { elements.toast.hidden = true; }, 4200);
}

function setCollectionStatus(message, type = '') {
  elements.collectionStatus.textContent = message;
  elements.collectionStatus.className = `status-line ${type}`.trim();
}

function itemKey(collectionId, url) {
  return `${collectionId}::${url}`;
}

function filterCollections(collections) {
  if (state.collectionListFilter === 'all') return collections;
  if (state.collectionListFilter === 'created') return collections.filter((collection) => ['created', 'both'].includes(collection.listType));
  if (state.collectionListFilter === 'followed') return collections.filter((collection) => ['followed', 'both'].includes(collection.listType));
  return collections;
}

function formatCollectionListType(listType) {
  return ({
    created: '我创建的',
    followed: '我关注的',
    both: '创建+关注',
    unknown: '来源未知'
  })[listType] || '来源未知';
}

function filterCollectionItems(items) {
  if (state.typeFilter === 'all') return items;
  if (state.typeFilter === 'unsupported') return items.filter((item) => ['pin', 'video'].includes(item.type));
  return items.filter((item) => item.type === state.typeFilter);
}

function formatType(type) {
  return ({ article: '专栏/文章', answer: '回答', pin: '想法', video: '视频', unknown: '未知' })[type] || type || '未知';
}

function formatStatus(status) {
  return ({
    pending: '等待中',
    running: '进行中',
    success: '成功',
    skipped: '已跳过',
    failed: '失败',
    cancelled: '已取消',
    partial: '部分成功',
    finalizing: '正在归档'
  })[status] || status || '未知';
}

function setActiveTab(name) {
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.tab === name);
  for (const panel of document.querySelectorAll('.panel')) panel.classList.toggle('active', panel.dataset.panel === name);
}

function renderQueueSummary() {
  const queue = state.dashboard?.queue || {};
  const counts = state.dashboard?.queue?.counts || {};
  const running = queue.activeCount || 0;
  const pending = counts[TASK_STATUS.PENDING] || 0;
  elements.queueSummary.textContent = queue.paused
    ? `队列已暂停；当前运行 ${running} 个，等待 ${pending} 个`
    : `队列${running ? '正在运行' : '空闲'}；运行 ${running} 个，等待 ${pending} 个`;
  elements.pauseButton.disabled = Boolean(queue.paused);
  elements.resumeButton.disabled = !queue.paused;
}

function renderCollectionList() {
  elements.collectionList.replaceChildren();
  if (!state.collections.length) {
    elements.collectionList.append(createElement('div', 'empty-state', '尚未读取收藏夹。点击“刷新收藏夹”，或从收藏夹页面打开本管理器。'));
    return;
  }

  const visibleCollections = filterCollections(state.collections);
  if (!visibleCollections.length) {
    elements.collectionList.append(createElement('div', 'empty-state', '当前来源筛选下没有收藏夹。'));
    return;
  }

  for (const collection of visibleCollections) {
    const card = createElement('section', 'collection-card');
    card.dataset.collectionId = collection.id;

    const head = createElement('div', 'collection-head');
    const headMain = createElement('div');
    const titleLine = createElement('div', 'collection-title-line');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selectedCollectionIds.has(collection.id);
    checkbox.dataset.role = 'collection-check';
    checkbox.dataset.collectionId = collection.id;
    checkbox.title = '选择此收藏夹';
    const title = createElement('h3', 'collection-title', collection.title || `收藏夹-${collection.id}`);
    const sourceType = createElement('span', 'item-type', formatCollectionListType(collection.listType));
    const visibility = createElement('span', 'item-type', collection.visibility === 'private' ? '私密' : collection.visibility === 'public' ? '公开' : '权限未知');
    titleLine.append(checkbox, title, sourceType, visibility);
    const meta = createElement('p', 'collection-meta', `${collection.count ?? collection.items?.length ?? '未知'} 条内容 · ${collection.url || ''}`);
    headMain.append(titleLine, meta);
    const loadButton = makeButton('读取条目', 'button secondary', { role: 'load-collection' });
    loadButton.dataset.collectionId = collection.id;
    head.append(headMain, loadButton);
    card.append(head);

    const body = createElement('div', 'collection-body');
    if (collection.error) body.append(createElement('p', 'error-text', `读取失败：${collection.error}`));
    for (const warning of collection.warnings || []) body.append(createElement('p', 'warning-text', warning));

    const allItems = collection.items || [];
    const items = filterCollectionItems(allItems);
    if (items.length) {
      const toolbar = createElement('div', 'item-toolbar');
      const selectedCount = items.filter((item) => state.selectedItemKeys.has(itemKey(collection.id, item.url))).length;
      toolbar.append(createElement('span', 'muted', `共 ${items.length} 条，已选 ${selectedCount} 条`));
      const selectButton = makeButton(selectedCount === items.length ? '取消全选' : '全选条目', 'button secondary', { role: 'toggle-all-items' });
      selectButton.dataset.collectionId = collection.id;
      toolbar.append(selectButton);

      const list = createElement('div', 'item-list');
      for (const item of items) {
        const row = createElement('label', 'item-row');
        const itemCheckbox = document.createElement('input');
        itemCheckbox.type = 'checkbox';
        itemCheckbox.checked = state.selectedItemKeys.has(itemKey(collection.id, item.url));
        itemCheckbox.dataset.role = 'item-check';
        itemCheckbox.dataset.collectionId = collection.id;
        itemCheckbox.dataset.url = item.url;
        const main = createElement('span');
        main.append(createElement('span', 'item-title', item.title || '未命名内容'));
        const subParts = [item.author?.name, item.publishedAt, item.url].filter(Boolean);
        main.append(createElement('span', 'item-sub', subParts.join(' · ')));
        const type = createElement('span', 'item-type', formatType(item.type));
        row.append(itemCheckbox, main, type);
        list.append(row);
      }
      body.append(toolbar, list);
    } else if (!collection.error) {
      body.append(createElement('p', 'muted', '尚未读取条目，或收藏夹当前为空。'));
    }
    card.append(body);
    elements.collectionList.append(card);
  }
}

function renderCounts() {
  elements.taskCounts.replaceChildren();
  const counts = state.dashboard?.queue?.counts || {};
  const definitions = [['等待', TASK_STATUS.PENDING], ['运行', TASK_STATUS.RUNNING], ['成功', TASK_STATUS.SUCCESS], ['失败', TASK_STATUS.FAILED], ['取消', TASK_STATUS.CANCELLED]];
  for (const [label, key] of definitions) {
    const card = createElement('div', 'count-card');
    card.append(createElement('strong', '', String(counts[key] || 0)), createElement('span', '', label));
    elements.taskCounts.append(card);
  }
}

function renderBatchList() {
  elements.batchList.replaceChildren();
  const batches = state.dashboard?.batches || [];
  if (!batches.length) {
    elements.batchList.append(createElement('div', 'empty-state', '暂无批量归档记录。'));
    return;
  }
  for (const batch of batches) {
    const card = createElement('article', 'batch-card');
    const head = createElement('div', 'batch-head');
    const main = createElement('div');
    const line = createElement('div', 'batch-title-line');
    line.append(createElement('h3', 'batch-title', batch.title || '未命名收藏夹'));
    line.append(createElement('span', `batch-status ${batch.status}`, formatStatus(batch.status)));
    const meta = createElement('p', 'batch-meta', `成功 ${batch.success || 0} · 失败 ${batch.failed || 0} · 取消 ${batch.cancelled || 0}${batch.filePath ? ` · ${batch.filePath}` : ''}`);
    main.append(line, meta);
    head.append(main);
    card.append(head);
    elements.batchList.append(card);
  }
}

function renderTaskList() {
  elements.taskList.replaceChildren();
  const tasks = state.dashboard?.tasks || [];
  if (!tasks.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7;
    cell.className = 'empty-state';
    cell.textContent = '暂无任务记录。';
    row.append(cell);
    elements.taskList.append(row);
    return;
  }

  for (const task of tasks) {
    const row = document.createElement('tr');
    const titleCell = document.createElement('td');
    const title = task.url ? document.createElement('a') : createElement('span');
    title.textContent = task.title || task.url || '未命名内容';
    if (/^https?:\/\//i.test(task.url || '')) {
      title.href = task.url;
      title.target = '_blank';
      title.rel = 'noopener noreferrer';
    }
    titleCell.append(title);
    if (task.error) titleCell.append(createElement('div', 'item-sub error-text', task.error));
    row.append(titleCell);
    row.append(createElement('td', '', formatType(task.type)));
    row.append(createElement('td', '', task.format === OUTPUT_FORMAT.ZIP ? 'ZIP' : task.format === OUTPUT_FORMAT.TEXT ? 'TXT' : 'Markdown'));
    row.append(createElement('td', `status-${task.status}`, formatStatus(task.status)));
    row.append(createElement('td', '', String(task.retryCount || 0)));
    row.append(createElement('td', '', task.updatedAt ? new Date(task.updatedAt).toLocaleString('zh-CN') : ''));

    const actionCell = document.createElement('td');
    if ([TASK_STATUS.PENDING, TASK_STATUS.RUNNING].includes(task.status)) {
      const cancel = makeButton('取消', 'button danger', { role: 'cancel-task' });
      cancel.dataset.taskId = task.id;
      actionCell.append(cancel);
    }
    if ([TASK_STATUS.FAILED, TASK_STATUS.CANCELLED].includes(task.status)) {
      const retry = makeButton('重试', 'button secondary', { role: 'retry-task' });
      retry.dataset.taskId = task.id;
      actionCell.append(retry);
    }
    row.append(actionCell);
    elements.taskList.append(row);
  }
}

function fillSettings(settings, force = false) {
  if (state.settingsDirty && !force) return;
  document.getElementById('setting-concurrency').value = settings.concurrency;
  document.getElementById('setting-delay').value = settings.delayMs;
  document.getElementById('setting-retries').value = settings.maxRetries;
  document.getElementById('setting-image-concurrency').value = settings.imageConcurrency;
  document.getElementById('setting-compression').value = settings.zipCompression;
  document.getElementById('setting-frontmatter').checked = Boolean(settings.includeFrontmatter);
  document.getElementById('setting-save-as').checked = Boolean(settings.saveAs);
  state.settingsDirty = false;
}

function renderDashboard() {
  renderQueueSummary();
  renderCounts();
  renderBatchList();
  renderTaskList();
  if (state.dashboard?.settings) fillSettings(state.dashboard.settings);
}

async function loadDashboard() {
  const dashboard = await sendMessage({ type: MESSAGE.GET_DASHBOARD_STATE });
  state.dashboard = dashboard;
  renderDashboard();
}

function scheduleDashboardRefresh() {
  if (state.refreshTimer) return;
  state.refreshTimer = setTimeout(async () => {
    state.refreshTimer = null;
    try { await loadDashboard(); } catch { /* Keep the last visible state. */ }
  }, 350);
}

async function refreshCollections() {
  setCollectionStatus('正在通过当前登录页面读取收藏夹列表…');
  try {
    const result = await sendMessage({ type: MESSAGE.DISCOVER_COLLECTIONS });
    state.collections = result.collections || [];
    state.selectedCollectionIds.clear();
    state.loaded.clear();
    state.selectedItemKeys.clear();
    renderCollectionList();
    const typeSummary = result.listTypes ? `我创建的 ${result.listTypes.created || 0} 个，我关注的 ${result.listTypes.followed || 0} 个` : '';
    setCollectionStatus(result.warnings?.join('；') || `已读取 ${state.collections.length} 个收藏夹${typeSummary ? `（${typeSummary}）` : ''}`, 'success');
  } catch (error) {
    setCollectionStatus(`读取收藏夹失败：${error.message}`, 'error');
  }
}

async function loadCollectionsByIds(ids) {
  const targets = state.collections.filter((collection) => ids.has(collection.id));
  if (!targets.length) {
    setCollectionStatus('请先选择收藏夹。', 'error');
    return;
  }
  setCollectionStatus(`正在读取 ${targets.length} 个收藏夹，大量内容需要一些时间…`);
  try {
    const result = await sendMessage({ type: MESSAGE.LOAD_COLLECTIONS, collections: targets });
    for (const loaded of result.collections || []) {
      const index = state.collections.findIndex((collection) => collection.id === loaded.id);
      const oldCollection = index >= 0 ? state.collections[index] : {};
      if (index >= 0) state.collections[index] = { ...oldCollection, ...loaded };
      state.loaded.set(loaded.id, loaded);
    }
    renderCollectionList();
    const total = (result.collections || []).reduce((sum, collection) => sum + (collection.items?.length || 0), 0);
    setCollectionStatus(`已读取 ${result.collections.length} 个收藏夹，共 ${total} 条内容`, 'success');
  } catch (error) {
    setCollectionStatus(`读取条目失败：${error.message}`, 'error');
  }
}

async function startBatch() {
  const groups = [];
  for (const collection of state.collections) {
    const items = (collection.items || []).filter((item) => state.selectedItemKeys.has(itemKey(collection.id, item.url)));
    if (items.length) groups.push({ ...collection, items });
  }
  if (!groups.length) {
    setCollectionStatus('请先读取并勾选至少一条内容。', 'error');
    return;
  }
  const format = elements.batchFormat.value;
  setCollectionStatus(`正在创建 ${groups.reduce((sum, group) => sum + group.items.length, 0)} 个导出任务…`);
  try {
    const result = await sendMessage({ type: MESSAGE.START_BATCH, collections: groups, format });
    setCollectionStatus(`已创建 ${result.taskCount} 个任务，完成后会自动生成收藏夹 ZIP。`, 'success');
    showToast('批量任务已创建', 'success');
    await loadDashboard();
    setActiveTab('tasks');
  } catch (error) {
    setCollectionStatus(`创建任务失败：${error.message}`, 'error');
  }
}

async function saveSettings() {
  const settings = {
    concurrency: toPositiveInt(document.getElementById('setting-concurrency').value, 1, 1, 3),
    delayMs: toPositiveInt(document.getElementById('setting-delay').value, 1200, 0, 60000),
    maxRetries: toPositiveInt(document.getElementById('setting-retries').value, 3, 0, 10),
    imageConcurrency: toPositiveInt(document.getElementById('setting-image-concurrency').value, 2, 1, 4),
    zipCompression: toPositiveInt(document.getElementById('setting-compression').value, 6, 0, 9),
    includeFrontmatter: document.getElementById('setting-frontmatter').checked,
    saveAs: document.getElementById('setting-save-as').checked
  };
  try {
    await sendMessage({ type: MESSAGE.SAVE_SETTINGS, settings });
    state.settingsDirty = false;
    await loadDashboard();
    showToast('设置已保存', 'success');
  } catch (error) {
    showToast(`保存失败：${error.message}`, 'error');
  }
}

function bindEvents() {
  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => setActiveTab(tab.dataset.tab)));
  document.getElementById('refresh-collections').addEventListener('click', refreshCollections);
  document.getElementById('load-selected').addEventListener('click', () => loadCollectionsByIds(state.selectedCollectionIds));
  document.getElementById('start-batch').addEventListener('click', startBatch);
  elements.collectionListFilter.addEventListener('change', () => {
    state.collectionListFilter = elements.collectionListFilter.value;
    renderCollectionList();
  });
  elements.itemTypeFilter.addEventListener('change', () => {
    state.typeFilter = elements.itemTypeFilter.value;
    renderCollectionList();
  });
  document.getElementById('refresh-tasks').addEventListener('click', loadDashboard);
  document.getElementById('pause-button').addEventListener('click', async () => {
    await sendMessage({ type: MESSAGE.PAUSE_QUEUE });
    await loadDashboard();
  });
  document.getElementById('resume-button').addEventListener('click', async () => {
    await sendMessage({ type: MESSAGE.RESUME_QUEUE });
    await loadDashboard();
  });
  document.getElementById('cancel-all').addEventListener('click', async () => {
    if (!confirm('确定取消全部未完成任务吗？')) return;
    await sendMessage({ type: MESSAGE.CANCEL_ALL });
    await loadDashboard();
  });
  document.getElementById('export-failures').addEventListener('click', async () => {
    await sendMessage({ type: MESSAGE.EXPORT_FAILURE_REPORT });
    showToast('失败报告已触发下载', 'success');
  });
  document.getElementById('clear-history').addEventListener('click', async () => {
    if (!confirm('确定清理成功、失败和取消的任务记录吗？已下载文件不会被删除。')) return;
    await sendMessage({ type: MESSAGE.CLEAR_HISTORY });
    await loadDashboard();
  });
  document.getElementById('save-settings').addEventListener('click', saveSettings);
  document.getElementById('settings-form').addEventListener('input', () => { state.settingsDirty = true; });

  elements.collectionList.addEventListener('change', (event) => {
    const target = event.target;
    if (target.dataset.role === 'collection-check') {
      if (target.checked) state.selectedCollectionIds.add(target.dataset.collectionId);
      else state.selectedCollectionIds.delete(target.dataset.collectionId);
      return;
    }
    if (target.dataset.role === 'item-check') {
      const key = itemKey(target.dataset.collectionId, target.dataset.url);
      if (target.checked) state.selectedItemKeys.add(key);
      else state.selectedItemKeys.delete(key);
      renderCollectionList();
    }
  });

  elements.collectionList.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-role]');
    if (!button) return;
    if (button.dataset.role === 'load-collection') {
      await loadCollectionsByIds(new Set([button.dataset.collectionId]));
    }
    if (button.dataset.role === 'toggle-all-items') {
      const collection = state.collections.find((item) => item.id === button.dataset.collectionId);
      const items = filterCollectionItems(collection?.items || []);
      const allSelected = items.length > 0 && items.every((item) => state.selectedItemKeys.has(itemKey(collection.id, item.url)));
      for (const item of items) {
        const key = itemKey(collection.id, item.url);
        if (allSelected) state.selectedItemKeys.delete(key);
        else state.selectedItemKeys.add(key);
      }
      renderCollectionList();
    }
    if (button.dataset.role === 'invert-items') {
      const collection = state.collections.find((item) => item.id === button.dataset.collectionId);
      const items = filterCollectionItems(collection?.items || []);
      for (const item of items) {
        const key = itemKey(collection.id, item.url);
        if (state.selectedItemKeys.has(key)) state.selectedItemKeys.delete(key);
        else state.selectedItemKeys.add(key);
      }
      renderCollectionList();
    }
  });

  elements.taskList.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-role]');
    if (!button) return;
    try {
      if (button.dataset.role === 'cancel-task') await sendMessage({ type: MESSAGE.CANCEL_TASK, taskId: button.dataset.taskId });
      if (button.dataset.role === 'retry-task') await sendMessage({ type: MESSAGE.RETRY_TASK, taskId: button.dataset.taskId });
      await loadDashboard();
    } catch (error) {
      showToast(error.message, 'error');
    }
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MESSAGE.QUEUE_UPDATED) scheduleDashboardRefresh();
});

async function bootstrap() {
  bindEvents();
  const queryCollection = new URLSearchParams(location.search).get('collection');
  try {
    await loadDashboard();
  } catch (error) {
    showToast(`无法读取任务状态：${error.message}`, 'error');
  }

  if (queryCollection) {
    const parsed = parseZhihuUrl(queryCollection);
    if (parsed.type === 'collection') {
      const placeholder = {
        id: parsed.id,
        url: parsed.canonicalUrl,
        title: `收藏夹-${parsed.id}`,
        count: null,
        visibility: 'unknown',
        items: [],
        warnings: []
      };
      state.collections = [placeholder];
      state.selectedCollectionIds.add(parsed.id);
      renderCollectionList();
      await loadCollectionsByIds(new Set([parsed.id]));
      setActiveTab('collections');
    }
  }
}

bootstrap();
