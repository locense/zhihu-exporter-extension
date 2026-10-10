import { zipSync } from 'fflate';
import { ERROR_CODE, MESSAGE, OUTPUT_FORMAT } from '../shared/constants.js';
import { createId, errorToRecord, formatIsoDate, safePathSegment } from '../shared/utils.js';

function yamlQuote(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

function normalizeMarkdown(article, includeFrontmatter) {
  let markdown = String(article?.markdown || '').trim();
  if (!markdown) {
    const fallback = String(article?.contentHtml || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|h[1-6]|li|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/\n{3,}/g, '\n\n');
    markdown = fallback.trim();
  }

  if (markdown.startsWith('---\n')) return markdown;
  const title = article?.title || '未命名文章';
  const titleHeading = /^#\s+/m.test(markdown) ? '' : `# ${title}\n\n`;
  const frontmatter = includeFrontmatter
    ? [
        '---',
        `title: ${yamlQuote(title)}`,
        `author: ${yamlQuote(article?.author?.name || '')}`,
        `source: ${yamlQuote(article?.canonicalUrl || article?.url || '')}`,
        `content_type: ${yamlQuote(article?.type || '')}`,
        ...(article?.publishedAt ? [`published_at: ${yamlQuote(article.publishedAt)}`] : []),
        `exported_at: ${yamlQuote(formatIsoDate(new Date()))}`,
        '---',
        ''
      ].join('\n')
    : '';
  return `${frontmatter}${titleHeading}${markdown}`.trim();
}

function buildTextDocument(article, body) {
  const lines = [
    `标题：${article?.title || '未命名文章'}`,
    `作者：${article?.author?.name || '未知'}`,
    `原文：${article?.canonicalUrl || article?.url || ''}`
  ];
  if (article?.publishedAt) lines.push(`发布时间：${article.publishedAt}`);
  lines.push('', '---', '');
  return `${lines.join('\n')}${String(body || '').trim()}`.trim();
}

function markdownToPlainText(markdown) {
  return String(markdown || '')
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (_match, code) => code)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, url) => `[图片${alt ? `：${alt}` : ''}] ${url}`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-+*]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function replaceImageTokens(markdown, mapping) {
  let output = String(markdown || '');
  for (const [token, target] of mapping.entries()) output = output.replaceAll(token, target);
  return output;
}

function extensionFromMime(contentType, url) {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  const map = {
    'image/avif': '.avif',
    'image/bmp': '.bmp',
    'image/gif': '.gif',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/svg+xml': '.svg',
    'image/webp': '.webp'
  };
  if (map[mime]) return map[mime];
  try {
    const ext = new URL(url).pathname.match(/\.[a-z0-9]{2,5}$/i)?.[0]?.toLowerCase();
    if (ext) return ext;
  } catch {
    // Fall through to the neutral extension.
  }
  return '.jpg';
}

async function sha256(blob) {
  try {
    const buffer = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

async function fetchImage(image, options) {
  const response = await fetch(image.url, {
    credentials: 'include',
    cache: 'force-cache',
    signal: options.signal,
    headers: { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' }
  });
  if (!response.ok) {
    const error = new Error(`图片请求失败：HTTP ${response.status}`);
    error.code = response.status === 403 ? ERROR_CODE.FORBIDDEN : response.status === 429 ? ERROR_CODE.RATE_LIMITED : ERROR_CODE.NETWORK;
    error.retryable = response.status === 403 || response.status === 429 || response.status >= 500;
    throw error;
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error('图片内容为空');
  return blob;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, runner));
  return output;
}

async function localizeImages(article, options = {}) {
  const images = article?.images || [];
  const directory = options.directory || safePathSegment(article?.title || '未命名文章');
  const assetPrefix = options.assetPrefix ? `${safePathSegment(options.assetPrefix)}-` : '';
  const mapping = new Map();
  const files = [];
  const errors = [];

  const results = await mapWithConcurrency(images, options.imageConcurrency || 2, async (image, index) => {
    try {
      const blob = await fetchImage(image, options);
      return {
        image,
        blob,
        hash: await sha256(blob),
        extension: extensionFromMime(blob.type, image.url),
        index
      };
    } catch (error) {
      errors.push(errorToRecord(error, { url: image.url, token: image.token, type: 'image' }));
      return { image, failed: true, index };
    }
  });

  const hashToRelative = new Map();
  for (const item of results) {
    if (item.failed) {
      mapping.set(item.image.token, item.image.url);
      continue;
    }
    const cachedRelative = item.hash ? hashToRelative.get(item.hash) : '';
    if (cachedRelative) {
      mapping.set(item.image.token, cachedRelative);
      continue;
    }
    const filename = `${assetPrefix}image-${String(item.index + 1).padStart(3, '0')}${item.extension}`;
    const relativePath = `assets/${filename}`;
    const entryPath = `${directory}/${relativePath}`;
    mapping.set(item.image.token, encodeURI(relativePath).replace(/%2F/g, '/'));
    files.push({ path: entryPath, blob: item.blob });
    if (item.hash) hashToRelative.set(item.hash, mapping.get(item.image.token));
  }

  return { mapping, files, errors };
}

export async function prepareArticleFiles(article, format, options = {}) {
  const directory = options.directory || safePathSegment(article?.title || '未命名文章');
  const baseFilename = safePathSegment(article?.title || '未命名文章');
  const includeFrontmatter = options.includeFrontmatter !== false;
  let markdown = normalizeMarkdown(article, includeFrontmatter);
  if (format !== OUTPUT_FORMAT.ZIP) {
    const remoteMapping = new Map((article?.images || []).map((image) => [image.token, image.url]));
    markdown = replaceImageTokens(markdown, remoteMapping);
  }
  let text = markdownToPlainText(markdown);
  const files = [];
  const errors = [];
  const warnings = [...(article?.warnings || [])];

  if (format === OUTPUT_FORMAT.ZIP) {
    const localized = await localizeImages(article, {
      directory,
      signal: options.signal,
      imageConcurrency: options.imageConcurrency,
      assetPrefix: options.assetPrefix || ''
    });
    markdown = replaceImageTokens(markdown, localized.mapping);
    text = markdownToPlainText(markdown);
    files.push(...localized.files);
    errors.push(...localized.errors);
    if (localized.errors.length) warnings.push(`${localized.errors.length} 张图片未能本地化，已保留远程地址`);
  }

  if (format === OUTPUT_FORMAT.TEXT) {
    text = buildTextDocument(article, text);
    files.unshift({
      path: `${directory}/${baseFilename}.txt`,
      blob: new Blob([text], { type: 'text/plain;charset=utf-8' })
    });
  } else {
    files.unshift({
      path: `${directory}/${baseFilename}.md`,
      blob: new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
    });
  }

  if (errors.length) {
    files.push({
      path: `${directory}/errors.json`,
      blob: new Blob([JSON.stringify({ article: article?.url, errors }, null, 2)], { type: 'application/json;charset=utf-8' })
    });
  }

  return {
    directory,
    filename: baseFilename,
    markdown,
    text,
    files,
    errors,
    warnings,
    indexEntry: {
      title: article?.title || '未命名文章',
      type: article?.type || 'unknown',
      author: article?.author?.name || '',
      publishedAt: article?.publishedAt || '',
      source: article?.canonicalUrl || article?.url || '',
      file: format === OUTPUT_FORMAT.TEXT ? `${directory}/${baseFilename}.txt` : `${directory}/${baseFilename}.md`,
      imageCount: format === OUTPUT_FORMAT.ZIP ? (article?.images?.length || 0) : 0
    }
  };
}

export async function createZip(entries, options = {}) {
  const encoder = new TextEncoder();
  const files = {};
  for (const entry of entries || []) {
    if (!entry?.path) continue;
    if (entry.content !== undefined) files[entry.path] = encoder.encode(String(entry.content));
    else if (entry.blob) files[entry.path] = new Uint8Array(await entry.blob.arrayBuffer());
  }
  const zipped = zipSync(files, {
    level: Math.min(9, Math.max(0, options.compression ?? 6)),
    mtime: new Date()
  });
  return new Blob([zipped], { type: 'application/zip' });
}

export function buildCollectionIndex(collection, tasks) {
  const lines = [
    `# ${collection.title || '知乎收藏导出'}`,
    '',
    `- 收藏夹链接：${collection.url || ''}`,
    `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
    `- 成功：${tasks.filter((task) => task.status === 'success').length}`,
    `- 失败：${tasks.filter((task) => task.status === 'failed').length}`,
    `- 取消：${tasks.filter((task) => task.status === 'cancelled').length}`,
    '',
    '## 文章目录',
    ''
  ];
  tasks.forEach((task, index) => {
    const title = String(task.title || `未命名内容 ${index + 1}`).replace(/[\[\]]/g, '');
    const file = String(task.filePath || '').replace(/\\/g, '/');
    const suffix = file ? ` - [${title}](${encodeURI(file)})` : ` - ${title}`;
    lines.push(`${index + 1}. ${suffix}（${task.status}）`);
  });
  return `${lines.join('\n')}\n`;
}

export function buildMergedCollectionIndex(collections, tasks) {
  const lines = [
    '# 知乎收藏合并导出',
    '',
    `- 收藏夹数量：${collections.length}`,
    `- 内容条数：${tasks.length}`,
    `- 成功：${tasks.filter((task) => task.status === 'success').length}`,
    `- 失败：${tasks.filter((task) => task.status === 'failed').length}`,
    `- 取消：${tasks.filter((task) => task.status === 'cancelled').length}`,
    `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
    ''
  ];

  for (const collection of collections) {
    const collectionTasks = tasks.filter((task) => String(task.collectionId || '') === String(collection.id || '') && task.collectionName === collection.title);
    lines.push(`## ${collection.title || `收藏夹-${collection.id || ''}`}`, '');
    lines.push(`- 来源：${({ created: '我创建的', followed: '我关注的', both: '创建+关注' })[collection.listType] || '未知'}`);
    lines.push(`- 链接：${collection.url || ''}`);
    lines.push(`- 内容：${collectionTasks.length} 条`, '');
    collectionTasks.forEach((task, index) => {
      const title = String(task.title || `未命名内容 ${index + 1}`).replace(/[\[\]]/g, '');
      const file = String(task.filePath || '').replace(/\\/g, '/');
      lines.push(`${index + 1}. ${file ? `[${title}](${encodeURI(file)})` : title}（${task.status}）`);
    });
    lines.push('');
  }

  const unmatched = tasks.filter((task) => !collections.some((collection) => String(collection.id || '') === String(task.collectionId || '') && task.collectionName === collection.title));
  if (unmatched.length) {
    lines.push('## 未归类内容', '');
    unmatched.forEach((task, index) => {
      const title = String(task.title || `未命名内容 ${index + 1}`).replace(/[\[\]]/g, '');
      const file = String(task.filePath || '').replace(/\\/g, '/');
      lines.push(`${index + 1}. ${file ? `[${title}](${encodeURI(file)})` : title}（${task.status}）`);
    });
  }
  return `${lines.join('\n').trim()}\n`;
}

export function buildFailureReport(tasks) {
  const failed = tasks.filter((task) => ['failed', 'cancelled'].includes(task.status));
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    total: tasks.length,
    failed: failed.length,
    tasks: failed.map((task) => ({
      id: task.id,
      title: task.title || '',
      url: task.url,
      type: task.type || '',
      status: task.status,
      retryCount: task.retryCount || 0,
      error: task.error || '',
      errorCode: task.errorCode || '',
      updatedAt: task.updatedAt || ''
    }))
  }, null, 2);
}

let offscreenDocumentPromise = null;

async function hasOffscreenDocument() {
  if (!chrome.offscreen) return false;
  if (typeof chrome.offscreen.hasDocument !== 'function') return false;
  try {
    return await chrome.offscreen.hasDocument();
  } catch {
    return false;
  }
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) throw new Error('当前浏览器不支持离线下载组件');
  if (await hasOffscreenDocument()) return;
  if (!offscreenDocumentPromise) {
    offscreenDocumentPromise = (async () => {
      let lastError;
      for (const reason of ['BLOBS', 'DOM_SCRAPING']) {
        try {
          await chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: [reason],
            justification: '创建本地 Blob URL，用于把生成的 Markdown、TXT 或 ZIP 交给浏览器下载'
          });
          return;
        } catch (error) {
          lastError = error;
          if (String(error?.message || error).includes('single offscreen')) return;
        }
      }
      throw lastError;
    })();
  }
  try {
    await offscreenDocumentPromise;
  } finally {
    offscreenDocumentPromise = null;
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

function createDownloadPort() {
  const port = chrome.runtime.connect({ name: 'zhihu-exporter-download' });
  const pending = new Map();
  let requestId = 0;

  port.onMessage.addListener((message) => {
    const entry = pending.get(message?.requestId);
    if (!entry) return;
    pending.delete(message.requestId);
    if (message.ok) entry.resolve(message);
    else entry.reject(new Error(message.error || '离线下载组件返回错误'));
  });
  port.onDisconnect.addListener(() => {
    const error = new Error(chrome.runtime.lastError?.message || '离线下载组件连接断开');
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  });

  return {
    port,
    request(message) {
      requestId += 1;
      const id = requestId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        port.postMessage({ ...message, requestId: id });
      });
    }
  };
}

async function downloadViaOffscreen(blob, filename, saveAs) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 1024 * 1024;
  const chunkCount = Math.ceil(bytes.length / chunkSize);
  let lastError;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await ensureOffscreenDocument();
    const connection = createDownloadPort();
    const transferId = createId('download');
    try {
      await connection.request({
        type: MESSAGE.OFFSCREEN_DOWNLOAD_BEGIN,
        transferId,
        filename,
        saveAs,
        mime: blob.type || 'application/octet-stream',
        size: bytes.length
      });
      for (let index = 0; index < chunkCount; index += 1) {
        const offset = index * chunkSize;
        const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
        await connection.request({
          type: MESSAGE.OFFSCREEN_DOWNLOAD_CHUNK,
          transferId,
          index,
          data: bytesToBase64(chunk)
        });
      }
      const response = await connection.request({
        type: MESSAGE.OFFSCREEN_DOWNLOAD_END,
        transferId
      });
      return await chrome.downloads.download({
        url: response.objectUrl,
        filename,
        saveAs,
        conflictAction: 'uniquify'
      });
    } catch (error) {
      lastError = error;
    } finally {
      connection.port.disconnect();
    }
  }

  throw lastError || new Error('离线下载失败');
}

export async function downloadBlob(blob, filename, saveAs = false) {
  if (typeof URL.createObjectURL === 'function') {
    let objectUrl = '';
    try {
      objectUrl = URL.createObjectURL(blob);
      const downloadId = await chrome.downloads.download({
        url: objectUrl,
        filename,
        saveAs,
        conflictAction: 'uniquify'
      });
      setTimeout(() => URL.revokeObjectURL(objectUrl), 120000);
      return downloadId;
    } catch {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  try {
    return await downloadViaOffscreen(blob, filename, saveAs);
  } catch (error) {
    const wrapped = new Error(`浏览器下载失败：${error.message || error}`);
    wrapped.code = ERROR_CODE.DOWNLOAD_FAILED;
    throw wrapped;
  }
}

export { markdownToPlainText };
