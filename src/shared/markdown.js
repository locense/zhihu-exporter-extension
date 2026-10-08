import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { formatIsoDate } from './utils.js';

function yamlQuote(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

export function buildFrontmatter(article, date = new Date()) {
  const lines = [
    '---',
    `title: ${yamlQuote(article.title || '未命名文章')}`,
    `author: ${yamlQuote(article.author?.name || '')}`,
    `source: ${yamlQuote(article.canonicalUrl || article.url || '')}`,
    `content_type: ${yamlQuote(article.type || '')}`
  ];
  if (article.publishedAt) lines.push(`published_at: ${yamlQuote(article.publishedAt)}`);
  lines.push(`exported_at: ${yamlQuote(formatIsoDate(date))}`);
  lines.push('---', '');
  return lines.join('\n');
}

function createTurndownService() {
  const service = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined'
  });
  service.use(gfm);

  service.addRule('zhihuFencedCodeBlock', {
    filter: (node) => node.nodeName === 'PRE',
    replacement: (_content, node) => {
      const code = node.querySelector?.('code') || node;
      const className = `${code.getAttribute?.('class') || ''} ${node.getAttribute?.('class') || ''}`;
      const language = node.getAttribute?.('data-lang') || className.match(/(?:language|lang)-([\w.+-]+)/)?.[1] || '';
      const text = String(code.textContent || '').replace(/\n$/, '').replace(/```/g, '``\\`');
      return `\n\n\`\`\`${language}\n${text}\n\`\`\`\n\n`;
    }
  });

  service.addRule('zhihuImage', {
    filter: 'img',
    replacement: (_content, node) => {
      const alt = String(node.getAttribute?.('alt') || '').replace(/[\[\]]/g, '');
      const src = node.getAttribute?.('src') || '';
      if (!src) return '';
      return `![${alt}](${src})`;
    }
  });

  service.addRule('zhihuTableWrapper', {
    filter: ['figure'],
    replacement: (content) => (content.trim() ? `\n\n${content.trim()}\n\n` : '')
  });

  service.keep(['details', 'summary']);
  return service;
}

export function replaceMathTokens(markdown, math = []) {
  let output = String(markdown || '');
  for (const item of math || []) {
    const rendered = item.display ? `\n\n$$\n${item.tex}\n$$\n\n` : `$${item.tex}$`;
    output = output.replaceAll(item.token, rendered);
  }
  return output;
}

export function replaceImageTokens(markdown, mapping = new Map()) {
  let output = String(markdown || '');
  for (const [token, target] of mapping instanceof Map ? mapping.entries() : Object.entries(mapping || {})) {
    output = output.replaceAll(token, target);
  }
  return output;
}

export function cleanupMarkdown(markdown) {
  return String(markdown || '')
    .replace(/\n[ \t]+\n/g, '\n\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

export function articleToMarkdown(article, options = {}) {
  const service = createTurndownService();
  let body = service.turndown(article?.contentHtml || article?.markdown || '');
  body = replaceMathTokens(body, article?.math || []);
  body = cleanupMarkdown(body);
  const frontmatter = options.includeFrontmatter ? buildFrontmatter(article, options.date) : '';
  return `${frontmatter}${body}`.trim();
}

export function markdownToPlainText(markdown) {
  let text = String(markdown || '')
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
  return text;
}
