import { BATCH_STATUS, ERROR_CODE, MESSAGE, OUTPUT_FORMAT, RETRYABLE_ERROR_CODES, TASK_STATUS } from '../shared/constants.js';
import {
  addEvent,
  dbDeleteMany,
  dbGet,
  dbGetAll,
  dbGetAllByIndex,
  dbPut,
  dbPutMany,
  getSettings,
  saveSettings,
  STORES
} from '../shared/db.js';
import { createId, errorToRecord, formatDateForFilename, isAbortError, safePathSegment, sleep } from '../shared/utils.js';
import { parseArticleInTab } from './tab-reader.js';
import {
  buildCollectionIndex,
  buildMergedCollectionIndex,
  createZip,
  downloadBlob,
  prepareArticleFiles
} from './exporters.js';

let initialized = false;
let paused = false;
let activeCount = 0;
let pumpTimer = null;
let pumpInProgress = false;
const activeControllers = new Map();
const runtimePayloads = new Map();
const finalizingBatches = new Set();

function retryDelay(retryCount) {
  return [0, 1500, 5000, 15000, 30000][Math.min(retryCount, 4)];
}

async function notifyQueueUpdated() {
  try {
    const snapshot = await getQueueSummary();
    chrome.runtime.sendMessage({ type: MESSAGE.QUEUE_UPDATED, state: snapshot }).catch?.(() => {});
  } catch {
    // No open extension page is a normal condition.
  }
}

export async function getQueueSummary() {
  const [tasks, batches, settings] = await Promise.all([
    dbGetAll(STORES.TASKS),
    dbGetAll(STORES.BATCHES),
    getSettings()
  ]);
  const counts = Object.fromEntries(Object.values(TASK_STATUS).map((status) => [status, 0]));
  for (const task of tasks) counts[task.status] = (counts[task.status] || 0) + 1;
  return {
    paused,
    activeCount,
    totalTasks: tasks.length,
    counts,
    batches: batches.length,
    settings
  };
}

async function recoverInterruptedTasks() {
  const running = await dbGetAllByIndex(STORES.TASKS, 'status', TASK_STATUS.RUNNING);
  if (!running.length) return;
  for (const task of running) {
    task.status = TASK_STATUS.PENDING;
    task.error = '浏览器中断后自动恢复';
    task.errorCode = ERROR_CODE.NETWORK;
    task.updatedAt = new Date().toISOString();
    await dbPut(STORES.TASKS, task);
  }
  await addEvent({ type: 'queue_recovered', count: running.length });
}

export async function bootstrapQueue() {
  if (initialized) return getQueueSummary();
  const settings = await getSettings();
  paused = Boolean(settings.queuePaused);
  initialized = true;
  await recoverInterruptedTasks();
  schedulePump(250);
  return getQueueSummary();
}

function schedulePump(delay = 0) {
  if (pumpTimer) clearTimeout(pumpTimer);
  pumpTimer = setTimeout(() => {
    pumpTimer = null;
    pumpQueue().catch(() => {});
  }, delay);
}

async function markTask(task, patch) {
  Object.assign(task, patch, { updatedAt: new Date().toISOString() });
  await dbPut(STORES.TASKS, task);
  return task;
}

function taskBaseRecord(input) {
  const now = new Date().toISOString();
  return {
    id: createId('task'),
    url: input.url,
    contentId: input.contentId || '',
    type: input.type || 'unknown',
    title: input.title || '',
    author: input.author || { name: '', url: '' },
    collectionId: input.collectionId || '',
    collectionName: input.collectionName || '',
    batchId: input.batchId || '',
    mode: input.mode || 'single',
    format: input.format,
    status: TASK_STATUS.PENDING,
    retryCount: 0,
    maxRetries: input.maxRetries ?? 3,
    error: '',
    errorCode: '',
    filePath: '',
    imageCount: 0,
    downloadId: null,
    createdAt: now,
    updatedAt: now,
    startedAt: '',
    finishedAt: ''
  };
}

export async function enqueueArticle(article, format) {
  const settings = await getSettings();
  const task = taskBaseRecord({
    url: article.canonicalUrl || article.url,
    contentId: article.contentId,
    type: article.type,
    title: article.title,
    author: article.author,
    format,
    mode: 'single',
    maxRetries: settings.maxRetries
  });
  runtimePayloads.set(task.id, article);
  await dbPut(STORES.TASKS, task);
  schedulePump();
  await notifyQueueUpdated();
  return task;
}

function collectionSnapshot(collection, index) {
  return {
    id: collection.id || '',
    title: String(collection.title || `收藏夹-${collection.id || index + 1}`).trim(),
    url: collection.url || '',
    visibility: collection.visibility || 'unknown',
    listType: collection.listType || 'unknown',
    count: collection.count ?? collection.items?.length ?? null
  };
}

function createTaskForCollectionItem(collection, collectionTitle, item, batchId, format, settings, collectionDirectory = '') {
  const task = taskBaseRecord({
    url: item.url,
    contentId: item.contentId,
    type: item.type,
    title: item.title,
    author: item.author,
    collectionId: collection.id || '',
    collectionName: collectionTitle,
    batchId,
    mode: 'batch',
    format,
    maxRetries: settings.maxRetries
  });
  task.collectionDirectory = collectionDirectory;
  if (item.article) runtimePayloads.set(task.id, item.article);
  return task;
}

export async function enqueueBatch(collections, format, options = {}) {
  const settings = await getSettings();
  const batches = [];
  const tasks = [];
  const sourceCollections = (collections || []).map(collectionSnapshot);
  const now = new Date().toISOString();

  if (options.mergeCollections && sourceCollections.length > 1) {
    const mergedTitle = `收藏夹合并导出-${formatDateForFilename(new Date())}`;
    const directoryName = safePathSegment(mergedTitle, '收藏夹合并导出');
    const directoryByIndex = new Map();
    const usedDirectories = new Set();
    sourceCollections.forEach((collection, index) => {
      let directory = safePathSegment(collection.title, `收藏夹-${collection.id || index + 1}`);
      if (usedDirectories.has(directory)) directory = safePathSegment(`${directory}-${collection.id || index + 1}`, directory);
      usedDirectories.add(directory);
      directoryByIndex.set(index, directory);
    });

    const total = collections.reduce((sum, collection) => sum + (collection.items?.length || 0), 0);
    const batch = {
      id: createId('batch'),
      collectionId: 'merged',
      title: mergedTitle,
      url: '',
      visibility: 'mixed',
      directoryName,
      format,
      status: BATCH_STATUS.PENDING,
      total,
      success: 0,
      failed: 0,
      cancelled: 0,
      pending: total,
      running: 0,
      mergeCollections: true,
      collections: sourceCollections,
      createdAt: now,
      updatedAt: now,
      error: '',
      filePath: '',
      finalized: false
    };
    batches.push(batch);

    sourceCollections.forEach((collection, index) => {
      const collectionTitle = collection.title;
      const collectionDirectory = directoryByIndex.get(index);
      for (const item of collections[index]?.items || []) {
        tasks.push(createTaskForCollectionItem(collection, collectionTitle, item, batch.id, format, settings, collectionDirectory));
      }
    });
  } else {
    for (let index = 0; index < sourceCollections.length; index += 1) {
      const collection = sourceCollections[index];
      const source = collections[index] || {};
      const collectionTitle = collection.title || `收藏夹-${collection.id || Date.now()}`;
      const directoryName = safePathSegment(collectionTitle, `收藏夹-${collection.id || Date.now()}`);
      const batch = {
        id: createId('batch'),
        collectionId: collection.id || '',
        title: collectionTitle,
        url: collection.url || '',
        visibility: collection.visibility || 'unknown',
        directoryName,
        format,
        status: BATCH_STATUS.PENDING,
        total: source.items?.length || 0,
        success: 0,
        failed: 0,
        cancelled: 0,
        pending: source.items?.length || 0,
        running: 0,
        mergeCollections: false,
        collections: [collection],
        createdAt: now,
        updatedAt: now,
        error: '',
        filePath: '',
        finalized: false
      };
      batches.push(batch);

      for (const item of source.items || []) {
        tasks.push(createTaskForCollectionItem(collection, collectionTitle, item, batch.id, format, settings));
      }
    }
  }

  await dbPutMany(STORES.BATCHES, batches);
  await dbPutMany(STORES.TASKS, tasks);
  schedulePump();
  await notifyQueueUpdated();
  return { batches, taskCount: tasks.length };
}

async function updateBatchStats(batchId) {
  const batch = await dbGet(STORES.BATCHES, batchId);
  if (!batch) return null;
  const tasks = await dbGetAllByIndex(STORES.TASKS, 'batchId', batchId);
  batch.total = tasks.length;
  batch.success = tasks.filter((task) => task.status === TASK_STATUS.SUCCESS).length;
  batch.failed = tasks.filter((task) => task.status === TASK_STATUS.FAILED).length;
  batch.cancelled = tasks.filter((task) => task.status === TASK_STATUS.CANCELLED).length;
  batch.pending = tasks.filter((task) => task.status === TASK_STATUS.PENDING).length;
  batch.running = tasks.filter((task) => task.status === TASK_STATUS.RUNNING).length;
  batch.updatedAt = new Date().toISOString();
  if (batch.status !== BATCH_STATUS.FINALIZING && !batch.finalized) {
    if (batch.running || batch.pending) batch.status = paused ? BATCH_STATUS.PENDING : BATCH_STATUS.RUNNING;
    else if (batch.success && (batch.failed || batch.cancelled)) batch.status = BATCH_STATUS.PARTIAL;
    else if (batch.success) batch.status = BATCH_STATUS.SUCCESS;
    else if (batch.failed) batch.status = BATCH_STATUS.FAILED;
    else if (batch.cancelled) batch.status = BATCH_STATUS.CANCELLED;
  }
  await dbPut(STORES.BATCHES, batch);
  return batch;
}

async function processBatchTask(task, article, signal) {
  const batch = await dbGet(STORES.BATCHES, task.batchId);
  if (!batch) throw new Error('批量任务记录不存在');
  const collectionDirectory = batch.mergeCollections && task.collectionDirectory
    ? safePathSegment(task.collectionDirectory)
    : '';
  const outputDirectory = collectionDirectory
    ? `${batch.directoryName}/${collectionDirectory}`
    : batch.directoryName;
  const bundle = await prepareArticleFiles(article, batch.format, {
    directory: outputDirectory,
    assetPrefix: article.contentId || task.contentId || task.id,
    includeFrontmatter: true,
    imageConcurrency: (await getSettings()).imageConcurrency,
    signal
  });
  const records = bundle.files.map((file) => ({
    id: createId('file'),
    batchId: batch.id,
    path: file.path,
    blob: file.blob
  }));
  await dbPutMany(STORES.BATCH_FILES, records);
  task.title = article.title || task.title;
  task.author = article.author || task.author;
  task.type = article.type || task.type;
  task.imageCount = article.images?.length || 0;
  task.filePath = bundle.indexEntry.file;
  task.warnings = bundle.warnings;
  return task;
}

async function processSingleTask(task, article, signal) {
  const settings = await getSettings();
  const directory = safePathSegment(article.title || task.title || '未命名文章');
  const bundle = await prepareArticleFiles(article, task.format, {
    directory,
    includeFrontmatter: settings.includeFrontmatter,
    imageConcurrency: settings.imageConcurrency,
    signal
  });
  let blob;
  let filename;
  if (task.format === OUTPUT_FORMAT.ZIP) {
    blob = await createZip(bundle.files, { compression: settings.zipCompression });
    filename = `${directory}.zip`;
  } else {
    const file = bundle.files[0];
    blob = file.blob;
    filename = file.path.split('/').slice(1).join('/') || file.path;
  }
  const downloadId = await downloadBlob(blob, filename, settings.saveAs);
  task.title = article.title || task.title;
  task.author = article.author || task.author;
  task.type = article.type || task.type;
  task.imageCount = article.images?.length || 0;
  task.filePath = filename;
  task.downloadId = downloadId;
  task.warnings = bundle.warnings;
  return task;
}

async function executeTask(task) {
  const controller = new AbortController();
  activeControllers.set(task.id, controller);
  activeCount += 1;
  await markTask(task, { status: TASK_STATUS.RUNNING, startedAt: new Date().toISOString(), error: '', errorCode: '' });
  await updateBatchStats(task.batchId).catch(() => {});
  await notifyQueueUpdated();

  try {
    const settings = await getSettings();
    if (settings.delayMs) await sleep(settings.delayMs);
    if (controller.signal.aborted) throw Object.assign(new Error('任务已取消'), { name: 'AbortError', code: ERROR_CODE.CANCELLED });
    const article = runtimePayloads.get(task.id) || await parseArticleInTab(task.url, { signal: controller.signal });
    if (task.mode === 'batch') await processBatchTask(task, article, controller.signal);
    else await processSingleTask(task, article, controller.signal);
    if (controller.signal.aborted) throw Object.assign(new Error('任务已取消'), { name: 'AbortError', code: ERROR_CODE.CANCELLED });
    await markTask(task, { status: TASK_STATUS.SUCCESS, finishedAt: new Date().toISOString(), progress: 100 });
    await addEvent({ type: 'task_success', taskId: task.id, url: task.url });
  } catch (error) {
    const code = isAbortError(error) ? ERROR_CODE.CANCELLED : (error.code || ERROR_CODE.UNKNOWN);
    const retryable = RETRYABLE_ERROR_CODES.includes(code);
    if (code === ERROR_CODE.CANCELLED) {
      await markTask(task, { status: TASK_STATUS.CANCELLED, error: '任务已取消', errorCode: code, finishedAt: new Date().toISOString() });
    } else if (retryable && task.retryCount < task.maxRetries) {
      task.retryCount += 1;
      await markTask(task, {
        status: TASK_STATUS.PENDING,
        error: error.message || String(error),
        errorCode: code,
        nextAttemptAt: new Date(Date.now() + retryDelay(task.retryCount)).toISOString()
      });
      schedulePump(retryDelay(task.retryCount));
    } else {
      await markTask(task, {
        status: TASK_STATUS.FAILED,
        error: error.message || String(error),
        errorCode: code,
        errorRecord: errorToRecord(error),
        finishedAt: new Date().toISOString()
      });
    }
    await addEvent({ type: 'task_error', taskId: task.id, url: task.url, code, message: error.message || String(error) });
  } finally {
    activeControllers.delete(task.id);
    runtimePayloads.delete(task.id);
    activeCount = Math.max(0, activeCount - 1);
    if (task.batchId) {
      const batch = await updateBatchStats(task.batchId).catch(() => null);
      if (batch && !batch.pending && !batch.running) schedulePump(100);
    }
    await notifyQueueUpdated();
    schedulePump();
  }
}

export async function pumpQueue() {
  if (paused || pumpInProgress) return;
  pumpInProgress = true;
  try {
    const settings = await getSettings();
    while (!paused && activeCount < settings.concurrency) {
      const pending = await dbGetAllByIndex(STORES.TASKS, 'status', TASK_STATUS.PENDING);
      const now = Date.now();
      const next = pending
        .filter((task) => !task.nextAttemptAt || new Date(task.nextAttemptAt).getTime() <= now)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
      if (!next) break;
      next.status = TASK_STATUS.RUNNING;
      await dbPut(STORES.TASKS, next);
      void executeTask(next);
    }
  } finally {
    pumpInProgress = false;
  }
}

export async function pauseQueue() {
  paused = true;
  await saveSettings({ queuePaused: true });
  await addEvent({ type: 'queue_paused' });
  await notifyQueueUpdated();
  return getQueueSummary();
}

export async function resumeQueue() {
  paused = false;
  await saveSettings({ queuePaused: false });
  await addEvent({ type: 'queue_resumed' });
  schedulePump();
  await notifyQueueUpdated();
  return getQueueSummary();
}

export async function cancelTask(taskId) {
  const task = await dbGet(STORES.TASKS, taskId);
  if (!task) throw new Error('任务不存在');
  if (task.status === TASK_STATUS.RUNNING) {
    activeControllers.get(taskId)?.abort();
  } else if ([TASK_STATUS.PENDING, TASK_STATUS.FAILED].includes(task.status)) {
    await markTask(task, { status: TASK_STATUS.CANCELLED, finishedAt: new Date().toISOString(), error: '任务已取消' });
  }
  if (task.batchId) await updateBatchStats(task.batchId);
  schedulePump();
  await notifyQueueUpdated();
  return task;
}

export async function cancelAll() {
  const tasks = await dbGetAll(STORES.TASKS);
  const cancellable = tasks.filter((task) => [TASK_STATUS.PENDING, TASK_STATUS.RUNNING, TASK_STATUS.FAILED].includes(task.status));
  for (const task of cancellable) {
    if (task.status === TASK_STATUS.RUNNING) activeControllers.get(task.id)?.abort();
    else await markTask(task, { status: TASK_STATUS.CANCELLED, finishedAt: new Date().toISOString(), error: '任务已取消' });
  }
  const batchIds = [...new Set(cancellable.map((task) => task.batchId).filter(Boolean))];
  for (const batchId of batchIds) await updateBatchStats(batchId);
  await addEvent({ type: 'queue_cancel_all', count: cancellable.length });
  schedulePump();
  await notifyQueueUpdated();
  return cancellable.length;
}

export async function retryTask(taskId) {
  const task = await dbGet(STORES.TASKS, taskId);
  if (!task) throw new Error('任务不存在');
  await markTask(task, {
    status: TASK_STATUS.PENDING,
    retryCount: 0,
    error: '',
    errorCode: '',
    nextAttemptAt: '',
    finishedAt: ''
  });
  if (task.batchId) {
    const batch = await dbGet(STORES.BATCHES, task.batchId);
    if (batch) {
      batch.finalized = false;
      batch.filePath = '';
      batch.status = BATCH_STATUS.PENDING;
      batch.updatedAt = new Date().toISOString();
      await dbPut(STORES.BATCHES, batch);
    }
    await updateBatchStats(task.batchId);
  }
  schedulePump();
  await notifyQueueUpdated();
  return task;
}

async function finalizeBatch(batchId) {
  if (finalizingBatches.has(batchId)) return;
  finalizingBatches.add(batchId);
  try {
    const batch = await dbGet(STORES.BATCHES, batchId);
    if (!batch || batch.finalized) return;
    const tasks = await dbGetAllByIndex(STORES.TASKS, 'batchId', batchId);
    if (tasks.some((task) => [TASK_STATUS.PENDING, TASK_STATUS.RUNNING].includes(task.status))) return;
    const successful = tasks.filter((task) => task.status === TASK_STATUS.SUCCESS);
    if (!successful.length) {
      batch.finalized = true;
      batch.status = tasks.some((task) => task.status === TASK_STATUS.CANCELLED) ? BATCH_STATUS.CANCELLED : BATCH_STATUS.FAILED;
      batch.updatedAt = new Date().toISOString();
      await dbPut(STORES.BATCHES, batch);
      return;
    }

    batch.status = BATCH_STATUS.FINALIZING;
    batch.updatedAt = new Date().toISOString();
    await dbPut(STORES.BATCHES, batch);
    const fileRecords = await dbGetAllByIndex(STORES.BATCH_FILES, 'batchId', batchId);
    const indexTasks = tasks.map((task) => ({
      ...task,
      filePath: String(task.filePath || '').startsWith(`${batch.directoryName}/`)
        ? String(task.filePath).slice(batch.directoryName.length + 1)
        : task.filePath
    }));
    const entries = fileRecords.map((record) => ({ path: record.path, blob: record.blob }));
    const indexContent = batch.mergeCollections
      ? buildMergedCollectionIndex(batch.collections || [], indexTasks)
      : buildCollectionIndex({ title: batch.title, url: batch.url }, indexTasks);
    entries.push({ path: `${batch.directoryName}/index.md`, content: indexContent });
    entries.push({
      path: `${batch.directoryName}/export-report.json`,
      content: JSON.stringify({
        type: batch.mergeCollections ? 'merged' : 'collection',
        collection: batch.mergeCollections ? undefined : { id: batch.collectionId, title: batch.title, url: batch.url },
        collections: batch.mergeCollections ? (batch.collections || []) : undefined,
        generatedAt: new Date().toISOString(),
        total: tasks.length,
        success: tasks.filter((task) => task.status === TASK_STATUS.SUCCESS).length,
        failed: tasks.filter((task) => task.status === TASK_STATUS.FAILED).length,
        cancelled: tasks.filter((task) => task.status === TASK_STATUS.CANCELLED).length,
        tasks: tasks.map((task) => ({
          title: task.title,
          url: task.url,
          status: task.status,
          error: task.error || '',
          errorCode: task.errorCode || ''
        }))
      }, null, 2)
    });
    const blob = await createZip(entries, { compression: 6 });
    const filename = `${batch.directoryName}.zip`;
    const settings = await getSettings();
    const downloadId = await downloadBlob(blob, filename, settings.saveAs);
    batch.finalized = true;
    batch.downloadId = downloadId;
    batch.filePath = filename;
    batch.status = tasks.some((task) => [TASK_STATUS.FAILED, TASK_STATUS.CANCELLED].includes(task.status)) ? BATCH_STATUS.PARTIAL : BATCH_STATUS.SUCCESS;
    batch.updatedAt = new Date().toISOString();
    await dbPut(STORES.BATCHES, batch);
    await addEvent({ type: 'batch_finalized', batchId, filename });
    setTimeout(() => dbDeleteMany(STORES.BATCH_FILES, fileRecords.map((record) => record.id)).catch(() => {}), 120000);
  } finally {
    finalizingBatches.delete(batchId);
    await notifyQueueUpdated();
  }
}

async function maybeFinalizeBatches() {
  const batches = await dbGetAll(STORES.BATCHES);
  for (const batch of batches) {
    if (!batch.finalized && batch.status !== BATCH_STATUS.FINALIZING) {
      const tasks = await dbGetAllByIndex(STORES.TASKS, 'batchId', batch.id);
      if (tasks.length && !tasks.some((task) => [TASK_STATUS.PENDING, TASK_STATUS.RUNNING].includes(task.status))) {
        await finalizeBatch(batch.id);
      }
    }
  }
}

export async function getDashboardState() {
  const [tasks, batches, settings] = await Promise.all([
    dbGetAll(STORES.TASKS),
    dbGetAll(STORES.BATCHES),
    getSettings()
  ]);
  tasks.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  batches.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return {
    queue: { paused, activeCount },
    settings,
    tasks: tasks.slice(0, 500),
    batches: batches.slice(0, 100)
  };
}

export async function clearHistory() {
  const [tasks, batches, files] = await Promise.all([
    dbGetAll(STORES.TASKS),
    dbGetAll(STORES.BATCHES),
    dbGetAll(STORES.BATCH_FILES)
  ]);
  const removableTasks = tasks.filter((task) => [TASK_STATUS.SUCCESS, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED, TASK_STATUS.SKIPPED].includes(task.status));
  await dbDeleteMany(STORES.TASKS, removableTasks.map((task) => task.id));
  const finalBatchIds = new Set(removableTasks.map((task) => task.batchId).filter(Boolean));
  const removableBatches = batches.filter((batch) => batch.finalized && finalBatchIds.has(batch.id));
  await dbDeleteMany(STORES.BATCHES, removableBatches.map((batch) => batch.id));
  const removableFileIds = files.filter((file) => finalBatchIds.has(file.batchId)).map((file) => file.id);
  await dbDeleteMany(STORES.BATCH_FILES, removableFileIds);
  await notifyQueueUpdated();
  return removableTasks.length;
}

export async function recoverAndFinalizeBatches() {
  await maybeFinalizeBatches();
}

export { finalizeBatch, schedulePump };
