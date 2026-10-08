export const EXTENSION_NAME = '知乎导出器';

export const MESSAGE = Object.freeze({
  PING: 'PING',
  PARSE_ARTICLE: 'PARSE_ARTICLE',
  EXTRACT_COLLECTIONS: 'EXTRACT_COLLECTIONS',
  EXTRACT_COLLECTION_ITEMS: 'EXTRACT_COLLECTION_ITEMS',
  EXPORT_ARTICLE: 'EXPORT_ARTICLE',
  TRIGGER_EXPORT: 'TRIGGER_EXPORT',
  OPEN_MANAGER: 'OPEN_MANAGER',
  DISCOVER_COLLECTIONS: 'DISCOVER_COLLECTIONS',
  LOAD_COLLECTIONS: 'LOAD_COLLECTIONS',
  START_BATCH: 'START_BATCH',
  GET_DASHBOARD_STATE: 'GET_DASHBOARD_STATE',
  SAVE_SETTINGS: 'SAVE_SETTINGS',
  PAUSE_QUEUE: 'PAUSE_QUEUE',
  RESUME_QUEUE: 'RESUME_QUEUE',
  CANCEL_ALL: 'CANCEL_ALL',
  RETRY_TASK: 'RETRY_TASK',
  CANCEL_TASK: 'CANCEL_TASK',
  EXPORT_FAILURE_REPORT: 'EXPORT_FAILURE_REPORT',
  CLEAR_HISTORY: 'CLEAR_HISTORY',
  QUEUE_UPDATED: 'QUEUE_UPDATED',
  OFFSCREEN_DOWNLOAD_BEGIN: 'OFFSCREEN_DOWNLOAD_BEGIN',
  OFFSCREEN_DOWNLOAD_CHUNK: 'OFFSCREEN_DOWNLOAD_CHUNK',
  OFFSCREEN_DOWNLOAD_END: 'OFFSCREEN_DOWNLOAD_END'
});

export const TASK_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCESS: 'success',
  SKIPPED: 'skipped',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

export const BATCH_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  FINALIZING: 'finalizing',
  SUCCESS: 'success',
  PARTIAL: 'partial',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

export const OUTPUT_FORMAT = Object.freeze({
  MARKDOWN: 'markdown',
  TEXT: 'text',
  ZIP: 'zip'
});

export const CONTENT_TYPE = Object.freeze({
  ARTICLE: 'article',
  ANSWER: 'answer',
  PIN: 'pin',
  VIDEO: 'video',
  QUESTION: 'question',
  UNKNOWN: 'unknown'
});

export const ERROR_CODE = Object.freeze({
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  PARSE_FAILED: 'PARSE_FAILED',
  NETWORK: 'NETWORK',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  UNSUPPORTED: 'UNSUPPORTED',
  CANCELLED: 'CANCELLED',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  UNKNOWN: 'UNKNOWN'
});

export const DEFAULT_SETTINGS = Object.freeze({
  concurrency: 1,
  delayMs: 1200,
  maxRetries: 3,
  requestTimeoutMs: 30000,
  imageConcurrency: 2,
  includeFrontmatter: true,
  saveAs: false,
  zipCompression: 6,
  queuePaused: false
});

export const RETRYABLE_ERROR_CODES = Object.freeze([
  ERROR_CODE.NETWORK,
  ERROR_CODE.RATE_LIMITED,
  ERROR_CODE.FORBIDDEN,
  ERROR_CODE.UNKNOWN
]);

export const SUPPORTED_HOSTS = Object.freeze([
  'www.zhihu.com',
  'zhuanlan.zhihu.com'
]);

export const IMAGE_HOST_SUFFIXES = Object.freeze([
  '.zhimg.com',
  '.zhimg.cn'
]);

export const MANAGER_PAGE = 'pages/manager.html';
export const POPUP_PAGE = 'pages/popup.html';
