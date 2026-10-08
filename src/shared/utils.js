import { CONTENT_TYPE, ERROR_CODE, IMAGE_HOST_SUFFIXES } from './constants.js';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export function createId(prefix = 'id') {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}

export function normalizeUrl(input, baseUrl = undefined) {
  if (!input) return '';
  try {
    const url = new URL(String(input).trim(), baseUrl);
    return url.href;
  } catch {
    return String(input).trim();
  }
}

export function stripUrlFragment(input) {
  try {
    const url = new URL(input);
    url.hash = '';
    return url.href;
  } catch {
    return input;
  }
}

export function parseZhihuUrl(input) {
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, '');
    const article = path.match(/\/p\/(\d+)/);
    if (article) {
      return {
        type: CONTENT_TYPE.ARTICLE,
        id: article[1],
        canonicalUrl: `${url.origin}/p/${article[1]}`
      };
    }

    const answer = path.match(/\/question\/(\d+)\/answer\/(\d+)/);
    if (answer) {
      return {
        type: CONTENT_TYPE.ANSWER,
        questionId: answer[1],
        id: answer[2],
        canonicalUrl: `${url.origin}/question/${answer[1]}/answer/${answer[2]}`
      };
    }

    const pin = path.match(/\/pin\/(\d+)/);
    if (pin) {
      return {
        type: CONTENT_TYPE.PIN,
        id: pin[1],
        canonicalUrl: `${url.origin}/pin/${pin[1]}`
      };
    }

    const video = path.match(/\/(?:video|zvideo)\/(\d+)/);
    if (video) {
      return {
        type: CONTENT_TYPE.VIDEO,
        id: video[1],
        canonicalUrl: `${url.origin}/video/${video[1]}`
      };
    }

    const collection = path.match(/\/collection\/(\d+)/);
    if (collection) {
      return {
        type: 'collection',
        id: collection[1],
        canonicalUrl: `${url.origin}/collection/${collection[1]}`
      };
    }

    if (host === 'www.zhihu.com' && path === '/collections') {
      return { type: 'collections', id: 'all', canonicalUrl: `${url.origin}/collections` };
    }
  } catch {
    return { type: CONTENT_TYPE.UNKNOWN, id: '', canonicalUrl: '' };
  }

  return { type: CONTENT_TYPE.UNKNOWN, id: '', canonicalUrl: '' };
}

export function isSupportedArticleUrl(input) {
  const parsed = parseZhihuUrl(input);
  return [CONTENT_TYPE.ARTICLE, CONTENT_TYPE.ANSWER, CONTENT_TYPE.PIN, CONTENT_TYPE.VIDEO].includes(parsed.type);
}

export function isArticlePageUrl(input) {
  const parsed = parseZhihuUrl(input);
  return [CONTENT_TYPE.ARTICLE, CONTENT_TYPE.ANSWER].includes(parsed.type);
}

export function isCollectionPageUrl(input) {
  const parsed = parseZhihuUrl(input);
  return ['collection', 'collections'].includes(parsed.type);
}

export function sanitizeFilename(input, fallback = '未命名') {
  let value = String(input || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*#\[\]]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();

  if (!value) value = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) value = `_${value}`;
  const chars = Array.from(value);
  if (chars.length > 120) value = chars.slice(0, 120).join('').replace(/[. ]+$/g, '');
  return value || fallback;
}

export function safePathSegment(value, fallback = '未命名') {
  return sanitizeFilename(value, fallback).replace(/_+/g, (match) => (match.length > 1 ? '_' : match));
}

export function formatDateForFilename(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function formatIsoDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

export function truncateText(value, maxLength = 80) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join('')}…` : text;
}

export function cleanImageUrl(input, baseUrl = undefined) {
  const normalized = normalizeUrl(input, baseUrl);
  if (!normalized) return '';
  if (normalized.startsWith('data:') || normalized.startsWith('blob:')) return normalized;
  try {
    const url = new URL(normalized);
    const removable = ['width', 'height', 'w', 'h', 'quality', 'q', 'resize', 'crop'];
    for (const key of removable) url.searchParams.delete(key);
    url.pathname = url.pathname.replace(/(?:_(?:[0-9]+w|[0-9]+x[0-9]+|qhd|hd|md|ld))(?=\.[a-z0-9]{3,5}$)/i, '');
    url.hash = '';
    return url.href;
  } catch {
    return normalized;
  }
}

export function isLikelyImageUrl(input) {
  if (!input) return false;
  if (input.startsWith('data:image/') || input.startsWith('blob:')) return true;
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase();
    if (IMAGE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
    return /\.(?:avif|bmp|gif|jpe?g|png|webp)(?:$|[?#])/i.test(url.pathname + url.search);
  } catch {
    return false;
  }
}

export function parseSrcset(value, baseUrl = undefined) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const pieces = part.split(/\s+/);
      const url = normalizeUrl(pieces.shift(), baseUrl);
      const descriptor = pieces.join(' ');
      const widthMatch = descriptor.match(/([0-9.]+)w/i);
      const densityMatch = descriptor.match(/([0-9.]+)x/i);
      const score = widthMatch ? Number(widthMatch[1]) : densityMatch ? Number(densityMatch[1]) * 1000 : 1;
      return { url, score };
    })
    .filter((item) => item.url)
    .sort((a, b) => b.score - a.score);
}

export function htmlDecodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

export function normalizeWhitespace(value) {
  return htmlDecodeEntities(value).replace(/\s+/g, ' ').trim();
}

export function getErrorCode(error) {
  const code = String(error?.code || '').toUpperCase();
  if (Object.values(ERROR_CODE).includes(code)) return code;
  const message = String(error?.message || error || '').toLowerCase();
  if (message.includes('401') || message.includes('登录') || message.includes('sign in')) return ERROR_CODE.AUTH_REQUIRED;
  if (message.includes('403') || message.includes('forbidden')) return ERROR_CODE.FORBIDDEN;
  if (message.includes('429') || message.includes('rate limit')) return ERROR_CODE.RATE_LIMITED;
  if (message.includes('parse') || message.includes('正文')) return ERROR_CODE.PARSE_FAILED;
  if (message.includes('fetch') || message.includes('network')) return ERROR_CODE.NETWORK;
  if (message.includes('cancel') || message.includes('abort')) return ERROR_CODE.CANCELLED;
  return ERROR_CODE.UNKNOWN;
}

export function errorToRecord(error, context = {}) {
  return {
    code: getErrorCode(error),
    message: String(error?.message || error || '未知错误'),
    retryable: Boolean(error?.retryable),
    at: new Date().toISOString(),
    ...context
  };
}

export function uniqueBy(items, keyFn) {
  const seen = new Set();
  const output = [];
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

export function omitEmpty(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== '' && value !== null && value !== undefined));
}

export function toPositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function isAbortError(error) {
  return error?.name === 'AbortError' || getErrorCode(error) === ERROR_CODE.CANCELLED;
}
