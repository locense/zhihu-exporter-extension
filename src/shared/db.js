import { DEFAULT_SETTINGS } from './constants.js';

const DB_NAME = 'zhihu-exporter';
const DB_VERSION = 2;
const STORES = Object.freeze({
  TASKS: 'tasks',
  BATCHES: 'batches',
  BATCH_FILES: 'batchFiles',
  SETTINGS: 'settings',
  EVENTS: 'events',
  DOWNLOADS: 'downloads'
});

let dbPromise;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

export function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORES.TASKS)) {
        const tasks = db.createObjectStore(STORES.TASKS, { keyPath: 'id' });
        tasks.createIndex('status', 'status', { unique: false });
        tasks.createIndex('batchId', 'batchId', { unique: false });
        tasks.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.BATCHES)) {
        const batches = db.createObjectStore(STORES.BATCHES, { keyPath: 'id' });
        batches.createIndex('status', 'status', { unique: false });
        batches.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.BATCH_FILES)) {
        const files = db.createObjectStore(STORES.BATCH_FILES, { keyPath: 'id' });
        files.createIndex('batchId', 'batchId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
        db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORES.EVENTS)) {
        const events = db.createObjectStore(STORES.EVENTS, { keyPath: 'id', autoIncrement: true });
        events.createIndex('at', 'at', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.DOWNLOADS)) {
        db.createObjectStore(STORES.DOWNLOADS, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Unable to open IndexedDB'));
  });
  return dbPromise;
}

export async function dbGet(storeName, key) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, 'readonly');
  return requestToPromise(transaction.objectStore(storeName).get(key));
}

export async function dbGetAll(storeName) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, 'readonly');
  return requestToPromise(transaction.objectStore(storeName).getAll());
}

export async function dbGetAllByIndex(storeName, indexName, value) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, 'readonly');
  return requestToPromise(transaction.objectStore(storeName).index(indexName).getAll(value));
}

export async function dbPut(storeName, value) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).put(value);
  await transactionDone(transaction);
  return value;
}

export async function dbPutMany(storeName, values) {
  if (!values?.length) return [];
  const db = await openDatabase();
  const transaction = db.transaction(storeName, 'readwrite');
  const store = transaction.objectStore(storeName);
  for (const value of values) store.put(value);
  await transactionDone(transaction);
  return values;
}

export async function dbDelete(storeName, key) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).delete(key);
  await transactionDone(transaction);
}

export async function dbDeleteMany(storeName, keys) {
  if (!keys?.length) return;
  const db = await openDatabase();
  const transaction = db.transaction(storeName, 'readwrite');
  const store = transaction.objectStore(storeName);
  for (const key of keys) store.delete(key);
  await transactionDone(transaction);
}

export async function dbClear(storeName) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).clear();
  await transactionDone(transaction);
}

export async function getSettings() {
  const record = await dbGet(STORES.SETTINGS, 'global');
  return { ...DEFAULT_SETTINGS, ...(record?.value || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const value = { ...current, ...(patch || {}) };
  await dbPut(STORES.SETTINGS, { key: 'global', value });
  return value;
}

export async function addEvent(event) {
  try {
    return await dbPut(STORES.EVENTS, { ...event, at: event.at || new Date().toISOString() });
  } catch {
    return null;
  }
}

export { STORES };
