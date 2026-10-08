import { CONTENT_TYPE, ERROR_CODE } from '../shared/constants.js';
import { articleToMarkdown } from '../shared/markdown.js';
import {
  cleanImageUrl,
  normalizeUrl,
  normalizeWhitespace,
  parseSrcset,
  parseZhihuUrl,
  sanitizeFilename,
  sleep,
  truncateText,
  uniqueBy
} from '../shared/utils.js';

const ARTICLE_ROOT_SELECTORS = [
  '.Post-RichTextContainer .RichText',
  '.Post-RichTextContainer',
  '.Post-RichText',
  '.QuestionAnswer-content .RichContent-inner',
  '.QuestionAnswer-content .RichContent',
  '.AnswerCard .RichContent-inner',
  '.RichContent-inner',
  '.RichContent',
  '.RichText',
  'article'
];

const REMOVE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'template',
  'form',
  'button',
  '[role="button"]',
  '.ContentItem-actions',
  '.RichContent-actions',
  '.QuestionActions',
  '.AnswerActions',
  '.Post-ActionBar',
  '.Post-Sub',
  '.RecommendationList',
  '.HotItem',
  '.Reward',
  '.RewardArea',
  '.Modal',
  '.Modal-wrapper',
  '.LoginModal',
  '.SignFlow',
  '.Advert',
  '[data-ad]',
  '[class*="Advert"]',
  '[class*="Recommendation"]',
  '[class*="ShareMenu"]'
];

const VIDEO_SELECTOR = 'video, iframe[src*="video"], .VideoCard, [class*="VideoCard"]';
const MATH_SELECTOR = '.ztext-math, .MathJax, math, [data-tex], [data-formula]';

function candidateScore(element) {
  const textLength = normalizeWhitespace(element?.textContent || '').length;
  const imageCount = element?.querySelectorAll?.('img')?.length || 0;
  const tagBonus = element?.tagName?.toLowerCase() === 'article' ? 50 : 0;
  return textLength + imageCount * 30 + tagBonus;
}

function findAnswerScope(doc, url) {
  const parsed = parseZhihuUrl(url);
  if (parsed.type !== CONTENT_TYPE.ANSWER || !parsed.id) return null;
  const direct = (
    doc.getElementById(`answer-${parsed.id}`) ||
    doc.querySelector(`[data-answerid="${parsed.id}"]`) ||
    doc.querySelector(`[data-answer-id="${parsed.id}"]`) ||
    doc.querySelector(`#answer-${CSS.escape(parsed.id)}`)
  );
  if (direct) return direct;
  const answerLink = doc.querySelector(`a[href*="/answer/${parsed.id}"]`);
  return answerLink?.closest('article, .AnswerCard, [class*="AnswerCard"], [class*="AnswerItem"], .QuestionAnswer-content') || null;
}

function findArticleRoot(doc, url) {
  const scope = findAnswerScope(doc, url) || doc;
  const candidates = [];
  for (const selector of ARTICLE_ROOT_SELECTORS) {
    for (const element of scope.querySelectorAll(selector)) candidates.push(element);
  }
  return candidates.sort((a, b) => candidateScore(b) - candidateScore(a))[0] || null;
}

export async function waitForArticleRoot(doc, url, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const root = findArticleRoot(doc, url);
    if (root && normalizeWhitespace(root.textContent).length > 20) return root;
    await sleep(250);
  }
  return findArticleRoot(doc, url);
}

function findFirstText(doc, selectors, scope = doc) {
  for (const selector of selectors) {
    const element = scope.querySelector(selector);
    const text = normalizeWhitespace(element?.textContent || '');
    if (text) return text;
  }
  return '';
}

function findFirstLink(doc, selectors, scope = doc) {
  for (const selector of selectors) {
    const element = scope.querySelector(selector);
    if (element) {
      const href = normalizeUrl(element.getAttribute('href'), doc.baseURI);
      if (href) return href;
    }
  }
  return '';
}

function extractPublishedAt(doc, root) {
  const time = root.querySelector('time[datetime]') || doc.querySelector('article time[datetime]');
  if (time?.getAttribute('datetime')) return time.getAttribute('datetime');
  const meta = doc.querySelector('meta[itemprop="datePublished"], meta[property="article:published_time"]');
  if (meta?.content) return meta.content;
  return findFirstText(doc, ['.ContentItem-time', '.Post-Time', '[class*="PublishTime"]']);
}

function getImageSource(image, baseUrl) {
  const candidates = [];
  const srcset = image.getAttribute('srcset') || image.getAttribute('data-srcset');
  candidates.push(...parseSrcset(srcset, baseUrl));
  for (const attribute of ['data-original', 'data-actualsrc', 'data-src', 'data-lazy-src', 'src']) {
    const value = image.getAttribute(attribute);
    if (value) candidates.push({ url: normalizeUrl(value, baseUrl), score: attribute === 'data-original' ? 10000 : 100 });
  }
  return candidates
    .map((item) => ({ ...item, url: cleanImageUrl(item.url, baseUrl) }))
    .filter((item) => item.url && !item.url.startsWith('data:image/svg'))
    .sort((a, b) => b.score - a.score)[0]?.url || '';
}

function normalizeImages(root, baseUrl) {
  const images = [];
  const tokenByUrl = new Map();
  for (const image of root.querySelectorAll('img')) {
    const sourceUrl = getImageSource(image, baseUrl);
    if (!sourceUrl) {
      image.remove();
      continue;
    }

    let token = tokenByUrl.get(sourceUrl);
    if (!token) {
      const index = images.length + 1;
      token = `ZHEIMG${String(index).padStart(3, '0')}`;
      tokenByUrl.set(sourceUrl, token);
      images.push({
        token,
        url: sourceUrl,
        alt: normalizeWhitespace(image.getAttribute('alt') || image.getAttribute('title') || `图片 ${index}`),
        width: Number(image.getAttribute('width')) || undefined,
        height: Number(image.getAttribute('height')) || undefined
      });
    }

    image.setAttribute('src', token);
    image.removeAttribute('srcset');
    image.removeAttribute('data-srcset');
    image.removeAttribute('data-original');
    image.removeAttribute('data-actualsrc');
    image.removeAttribute('data-src');
    image.removeAttribute('data-lazy-src');
    image.setAttribute('loading', 'eager');
  }
  return images;
}

function normalizeMath(root) {
  const math = [];
  for (const element of root.querySelectorAll(MATH_SELECTOR)) {
    const tex = normalizeWhitespace(
      element.getAttribute('data-tex') ||
      element.getAttribute('data-formula') ||
      element.getAttribute('aria-label') ||
      element.textContent ||
      ''
    );
    if (!tex) continue;
    const display = /display|block/i.test(element.getAttribute('class') || '') || element.tagName.toLowerCase() === 'math';
    const token = `ZHEMATH${String(math.length + 1).padStart(3, '0')}`;
    math.push({ token, tex, display });
    element.replaceWith(root.ownerDocument.createTextNode(token));
  }
  return math;
}

function normalizeVideos(root, baseUrl) {
  const unsupported = [];
  for (const element of root.querySelectorAll(VIDEO_SELECTOR)) {
    const url = normalizeUrl(element.getAttribute?.('src') || element.querySelector?.('a[href]')?.getAttribute('href'), baseUrl);
    unsupported.push({ type: 'video', url, title: truncateText(element.getAttribute?.('title') || '视频') });
    const placeholder = root.ownerDocument.createElement('p');
    placeholder.textContent = `[视频内容未导出${url ? `：${url}` : ''}]`;
    element.replaceWith(placeholder);
  }
  return unsupported;
}

function normalizeLinks(root, baseUrl) {
  for (const link of root.querySelectorAll('a[href]')) {
    const href = normalizeUrl(link.getAttribute('href'), baseUrl);
    if (href && !href.startsWith('javascript:')) link.setAttribute('href', href);
    else link.removeAttribute('href');
  }
}

function cleanClone(root, baseUrl) {
  const clone = root.cloneNode(true);
  for (const selector of REMOVE_SELECTORS) {
    for (const element of clone.querySelectorAll(selector)) element.remove();
  }
  const unsupported = normalizeVideos(clone, baseUrl);
  const images = normalizeImages(clone, baseUrl);
  const math = normalizeMath(clone);
  normalizeLinks(clone, baseUrl);
  for (const element of clone.querySelectorAll('[contenteditable]')) element.removeAttribute('contenteditable');
  for (const element of clone.querySelectorAll('[style]')) element.removeAttribute('style');
  return { clone, images, math, unsupported };
}

function isLoginPage(doc) {
  const path = doc.location?.pathname || '';
  if (/\/(?:signin|login)/i.test(path)) return true;
  return Boolean(doc.querySelector('.SignFlow, .SignFlowModal, form[action*="signin"], [class*="LoginModal"]'));
}

export async function extractArticleFromDocument(doc, url, options = {}) {
  const parsed = parseZhihuUrl(url);
  if ([CONTENT_TYPE.PIN, CONTENT_TYPE.VIDEO].includes(parsed.type)) {
    const error = new Error(parsed.type === CONTENT_TYPE.VIDEO ? '第一版暂不支持视频导出' : '第一版暂不支持想法导出');
    error.code = ERROR_CODE.UNSUPPORTED;
    throw error;
  }

  const waitMs = options.waitMs ?? 15000;
  const root = await waitForArticleRoot(doc, url, waitMs);
  if (!root) {
    const code = isLoginPage(doc) ? ERROR_CODE.AUTH_REQUIRED : ERROR_CODE.PARSE_FAILED;
    const error = new Error(code === ERROR_CODE.AUTH_REQUIRED ? '登录状态已失效，无法读取正文' : '未找到知乎正文，页面结构可能已变化');
    error.code = code;
    error.retryable = code === ERROR_CODE.AUTH_REQUIRED;
    throw error;
  }

  const pageUrl = doc.querySelector('link[rel="canonical"]')?.href || url;
  const title = findFirstText(doc, [
    '.Post-Title',
    '.QuestionHeader-title',
    'h1[class*="Post"]',
    '.ContentItem-title',
    'h1'
  ]) || normalizeWhitespace(doc.title).replace(/\s*-\s*知乎\s*$/, '');

  const authorName = findFirstText(doc, [
    '.AuthorInfo-name',
    '.AuthorInfo-name a',
    '.UserLink-link',
    '[itemprop="author"] [itemprop="name"]',
    '[itemprop="author"]'
  ]);
  const authorUrl = findFirstLink(doc, [
    '.AuthorInfo-name a',
    '.UserLink-link',
    '[itemprop="author"] a',
    'a[href*="/people/"]'
  ]);

  const { clone, images, math, unsupported } = cleanClone(root, pageUrl);
  const contentHtml = clone.innerHTML.trim();
  if (!contentHtml || normalizeWhitespace(clone.textContent).length < 20) {
    const error = new Error('正文内容为空，页面结构可能已变化');
    error.code = ERROR_CODE.PARSE_FAILED;
    throw error;
  }

  const warnings = [];
  if (unsupported.length) warnings.push(`发现 ${unsupported.length} 个未导出的视频或嵌入式内容`);

  const article = {
    schemaVersion: 1,
    url,
    canonicalUrl: pageUrl,
    contentId: parsed.id || '',
    type: parsed.type,
    title: title || '未命名文章',
    author: { name: authorName || '', url: authorUrl || '' },
    publishedAt: extractPublishedAt(doc, root) || '',
    capturedAt: new Date().toISOString(),
    contentHtml,
    images,
    math,
    unsupported,
    warnings
  };
  article.markdown = articleToMarkdown(article, { includeFrontmatter: false });
  return article;
}

function getCollectionRoot(doc) {
  const selectors = [
    '.CollectionDetailPage',
    '.CollectionDetailPage-list',
    '.CollectionDetail',
    'main',
    '[role="main"]'
  ];
  for (const selector of selectors) {
    const element = doc.querySelector(selector);
    if (element) return element;
  }
  return doc.body;
}

function cardText(element) {
  return normalizeWhitespace(element?.textContent || '');
}

function findCollectionTitle(card, fallback) {
  const selectors = ['.CollectionCard-title', '[class*="CollectionCard-title"]', 'h1', 'h2', 'h3', '[class*="title"]'];
  for (const selector of selectors) {
    const element = card?.querySelector?.(selector);
    const text = normalizeWhitespace(element?.textContent || '');
    if (text && text.length < 160) return text;
  }
  return normalizeWhitespace(fallback || '') || '未命名收藏夹';
}

export function extractCollectionsFromDocument(doc, baseUrl) {
  const root = getCollectionRoot(doc);
  const anchors = [...root.querySelectorAll('a[href*="/collection/"]')];
  const collections = [];
  for (const anchor of anchors) {
    const url = normalizeUrl(anchor.getAttribute('href'), baseUrl);
    const parsed = parseZhihuUrl(url);
    if (parsed.type !== 'collection') continue;
    const card = anchor.closest('[class*="CollectionCard"], .List-item, li, article') || anchor.parentElement || anchor;
    const title = findCollectionTitle(card, anchor.textContent);
    const countMatch = cardText(card).match(/(\d+)\s*(?:篇|条|个内容|内容)/);
    const privacyText = cardText(card);
    collections.push({
      id: parsed.id,
      url: parsed.canonicalUrl,
      title,
      count: countMatch ? Number(countMatch[1]) : null,
      visibility: /私密|仅自己/.test(privacyText) ? 'private' : /公开/.test(privacyText) ? 'public' : 'unknown',
      description: truncateText(cardText(card).slice(title.length), 120)
    });
  }

  const unique = uniqueBy(collections, (item) => item.id);
  if (!unique.length && isLoginPage(doc)) {
    const error = new Error('登录状态已失效，无法读取收藏夹列表');
    error.code = ERROR_CODE.AUTH_REQUIRED;
    throw error;
  }
  return {
    collections: unique,
    warnings: unique.length ? [] : ['未读取到收藏夹，请确认当前账号已登录且页面已加载完成']
  };
}

function isVisibleCollectionTab(element, win) {
  if (!element) return false;
  try {
    const style = win.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  } catch {
    // Some DOM implementations used by tests do not expose computed styles.
  }
  if (element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
  return normalizeWhitespace(element.textContent).length <= 30;
}

function findCollectionListTab(doc, win, pattern) {
  const candidates = [...doc.querySelectorAll('button, [role="tab"], a, [class*="tab"], [class*="Tab"]')]
    .filter((element) => isVisibleCollectionTab(element, win))
    .filter((element) => pattern.test(normalizeWhitespace(element.textContent)))
    .sort((a, b) => {
      const aText = normalizeWhitespace(a.textContent);
      const bText = normalizeWhitespace(b.textContent);
      const aScore = (a.matches?.('button, [role="tab"]') ? 100 : 0) + (aText.length < 20 ? 20 : 0);
      const bScore = (b.matches?.('button, [role="tab"]') ? 100 : 0) + (bText.length < 20 ? 20 : 0);
      return bScore - aScore || aText.length - bText.length;
    });
  return candidates[0] || null;
}

function isCollectionTabActive(element) {
  if (!element) return false;
  if (element.getAttribute('aria-selected') === 'true') return true;
  const className = String(element.className || '');
  return /\b(?:active|selected|current)\b/i.test(className);
}

function mergeCollectionRecords(target, items) {
  for (const item of items || []) {
    const existing = target.get(item.id);
    if (!existing) {
      target.set(item.id, { ...item, listTypes: item.listType ? [item.listType] : [] });
      continue;
    }
    if (item.listType && !existing.listTypes.includes(item.listType)) existing.listTypes.push(item.listType);
    existing.title = existing.title || item.title;
    existing.count = existing.count ?? item.count;
    existing.visibility = existing.visibility === 'unknown' ? item.visibility : existing.visibility;
  }
}

export async function extractCollectionsFromAllTabs(doc, win, options = {}) {
  const requested = [
    { type: 'created', pattern: /我创建的(?:收藏夹)?|创建的收藏夹/ },
    { type: 'followed', pattern: /我关注的(?:收藏夹)?|关注的收藏夹/ }
  ];
  const merged = new Map();
  const warnings = [];
  let foundTab = false;

  for (const target of requested) {
    const control = findCollectionListTab(doc, win, target.pattern);
    if (!control) continue;
    foundTab = true;
    if (isCollectionTabActive(control)) {
      const initial = extractCollectionsFromDocument(doc, doc.baseURI);
      mergeCollectionRecords(merged, (initial.collections || []).map((item) => ({ ...item, listType: target.type })));
      break;
    }
  }

  for (const target of requested) {
    const control = findCollectionListTab(doc, win, target.pattern);
    if (!control) continue;
    foundTab = true;
    if ([...merged.values()].some((item) => item.listTypes?.includes(target.type))) continue;
    if (!isCollectionTabActive(control)) {
      control.scrollIntoView?.({ block: 'center' });
      control.click();
      await sleep(options.tabWaitMs ?? 1000);
    }
    const result = extractCollectionsFromDocument(doc, doc.baseURI);
    mergeCollectionRecords(merged, (result.collections || []).map((item) => ({ ...item, listType: target.type })));
  }

  if (!foundTab) {
    const result = extractCollectionsFromDocument(doc, doc.baseURI);
    const pageText = normalizeWhitespace(doc.body?.textContent || '');
    const inferredType = /我创建的(?:收藏夹)?|创建的收藏夹/.test(pageText)
      ? 'created'
      : /我关注的(?:收藏夹)?|关注的收藏夹/.test(pageText) ? 'followed' : 'unknown';
    mergeCollectionRecords(merged, (result.collections || []).map((item) => ({ ...item, listType: inferredType })));
    warnings.push(...(result.warnings || []));
  }

  const collections = [...merged.values()].map((item) => ({
    ...item,
    listType: item.listTypes.includes('created') && item.listTypes.includes('followed')
      ? 'both'
      : item.listTypes[0] || 'unknown'
  }));

  if (!collections.length) warnings.push('未读取到我创建的或我关注的收藏夹，请确认登录状态和页面结构');
  const createdCount = collections.filter((item) => ['created', 'both'].includes(item.listType)).length;
  const followedCount = collections.filter((item) => ['followed', 'both'].includes(item.listType)).length;
  return {
    collections,
    listTypes: { created: createdCount, followed: followedCount },
    warnings: uniqueBy(warnings, (item) => item)
  };
}

function isSupportedCollectionItem(url) {
  const type = parseZhihuUrl(url).type;
  return [CONTENT_TYPE.ARTICLE, CONTENT_TYPE.ANSWER, CONTENT_TYPE.PIN, CONTENT_TYPE.VIDEO].includes(type);
}

function findItemContainer(anchor) {
  return anchor.closest('article, .List-item, .CollectionDetailPageItem, [class*="CollectionItem"], [class*="List-item"], [class*="CollectionDetailPageItem"]') || anchor.parentElement || anchor;
}

function extractItemTitle(anchor, container) {
  const candidates = [
    anchor,
    container?.querySelector?.('[class*="title"]'),
    container?.querySelector?.('h1, h2, h3, h4'),
    container?.querySelector?.('[class*="ContentItem-title"]')
  ];
  for (const element of candidates) {
    const text = normalizeWhitespace(element?.textContent || '');
    if (text && text.length >= 2 && text.length <= 220 && !/^(查看|阅读|回答|文章)$/.test(text)) return text;
  }
  return '未命名内容';
}

function extractItemAuthor(container) {
  return findFirstText(container.ownerDocument, ['.AuthorInfo-name', '[class*="author"]', '[class*="Author"]'], container);
}

function extractItemPublishedAt(container) {
  const time = container.querySelector?.('time[datetime]');
  if (time?.getAttribute('datetime')) return time.getAttribute('datetime');
  return findFirstText(container.ownerDocument, ['.ContentItem-time', '[class*="time"]'], container);
}

export function extractCollectionMetaFromDocument(doc, baseUrl) {
  const parsed = parseZhihuUrl(baseUrl);
  const root = getCollectionRoot(doc);
  const title = findFirstText(doc, [
    '.CollectionDetailPage-title',
    '.CollectionDetail-title',
    '.CollectionCard-title',
    '[class*="CollectionDetail"] h1',
    'main h1',
    'h1'
  ], root) || `收藏夹-${parsed.id || ''}`;
  const pageText = cardText(root);
  const countMatch = pageText.match(/(\d+)\s*(?:篇|条|个内容|内容)/);
  return {
    id: parsed.id || '',
    url: parsed.canonicalUrl || baseUrl,
    title,
    count: countMatch ? Number(countMatch[1]) : null,
    visibility: /私密|仅自己/.test(pageText) ? 'private' : /公开/.test(pageText) ? 'public' : 'unknown'
  };
}

export function extractCollectionItemsFromDocument(doc, baseUrl) {
  const root = getCollectionRoot(doc);
  const anchors = [...root.querySelectorAll('a[href]')];
  const items = [];
  for (const anchor of anchors) {
    const url = normalizeUrl(anchor.getAttribute('href'), baseUrl);
    if (!isSupportedCollectionItem(url)) continue;
    const parsed = parseZhihuUrl(url);
    const container = findItemContainer(anchor);
    const title = extractItemTitle(anchor, container);
    items.push({
      url: parsed.canonicalUrl || url,
      contentId: parsed.id || '',
      type: parsed.type,
      title,
      author: { name: extractItemAuthor(container), url: '' },
      publishedAt: extractItemPublishedAt(container),
      excerpt: truncateText(cardText(container), 180)
    });
  }

  return uniqueBy(items, (item) => `${item.type}:${item.contentId || item.url}`);
}

function isVisibleControl(element, win) {
  if (!element) return false;
  const style = win.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
}

function findAdvanceControl(doc, win) {
  const candidates = [...doc.querySelectorAll('button, a, [role="button"]')];
  return candidates.find((element) => {
    if (element.closest('#zhihu-exporter-toolbar')) return false;
    const text = normalizeWhitespace(element.textContent);
    return /下一页|加载更多|查看更多|展开更多|更多内容/.test(text) && isVisibleControl(element, win);
  }) || null;
}

export async function loadAllCollectionItems(doc, win, options = {}) {
  const maxSteps = options.maxSteps ?? 80;
  const stableRoundsToStop = options.stableRoundsToStop ?? 4;
  const waitMs = options.waitMs ?? 900;
  const collected = new Map();
  const warnings = [];
  let stableRounds = 0;
  let reachedEnd = false;
  let nextUrl = '';

  for (let step = 0; step < maxSteps; step += 1) {
    const before = collected.size;
    for (const item of extractCollectionItemsFromDocument(doc, doc.baseURI)) {
      collected.set(`${item.type}:${item.contentId || item.url}`, item);
    }

    const control = findAdvanceControl(doc, win);
    const href = control?.getAttribute?.('href') || '';
    const absoluteHref = href ? normalizeUrl(href, doc.baseURI) : '';
    let isSeparatePageLink = false;
    if (absoluteHref && !href.startsWith('javascript:')) {
      try {
        const nextPage = new URL(absoluteHref);
        const currentPage = new URL(doc.baseURI);
        isSeparatePageLink = nextPage.origin === currentPage.origin &&
          (nextPage.pathname !== currentPage.pathname || nextPage.search !== currentPage.search);
      } catch {
        isSeparatePageLink = false;
      }
    }
    if (isSeparatePageLink) {
      nextUrl = absoluteHref;
      break;
    }

    if (control) {
      control.scrollIntoView({ block: 'center' });
      control.click();
      await sleep(waitMs + 250);
    } else {
      const previousY = win.scrollY;
      win.scrollTo(0, Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight));
      await sleep(waitMs);
      if (win.scrollY === previousY && collected.size === before) stableRounds += 1;
    }

    if (collected.size === before) stableRounds += 1;
    else stableRounds = 0;

    if (stableRounds >= stableRoundsToStop) {
      reachedEnd = true;
      break;
    }
  }

  if (!reachedEnd && !nextUrl) warnings.push('已达到最大翻页次数，可能仍有未加载条目');
  if (!collected.size) warnings.push('未读取到可导出的条目，请确认收藏夹非空且页面结构未变化');
  return {
    collection: extractCollectionMetaFromDocument(doc, doc.baseURI),
    items: [...collected.values()],
    reachedEnd,
    nextUrl,
    warnings
  };
}
