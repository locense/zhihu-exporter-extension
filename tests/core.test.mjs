import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanImageUrl, parseZhihuUrl, sanitizeFilename } from '../src/shared/utils.js';
import { parseHTML } from 'linkedom';
import { extractCollectionMetaFromDocument, extractCollectionsFromAllTabs, extractCollectionsFromDocument } from '../src/content/parser.js';
import { articleToMarkdown, markdownToPlainText } from '../src/shared/markdown.js';
import { buildMergedCollectionIndex, createZip, prepareArticleFiles } from '../src/background/exporters.js';
import { OUTPUT_FORMAT } from '../src/shared/constants.js';
import { toPublicCollection } from '../src/shared/collection-summary.js';

test('识别文章和回答链接', () => {
  assert.equal(parseZhihuUrl('https://zhuanlan.zhihu.com/p/123').type, 'article');
  assert.equal(parseZhihuUrl('https://www.zhihu.com/question/10/answer/20').type, 'answer');
  assert.equal(parseZhihuUrl('https://www.zhihu.com/collection/99').type, 'collection');
});

test('文件名安全化', () => {
  assert.equal(sanitizeFilename('a/b:c*?.md'), 'a_b_c_.md');
  assert.equal(sanitizeFilename('CON'), '_CON');
  assert.equal(sanitizeFilename('   '), '未命名');
});

test('清理知乎缩略图参数', () => {
  const cleaned = cleanImageUrl('https://picx.zhimg.com/v2-demo_1440w.jpg?width=800&source=abc');
  assert.equal(cleaned, 'https://picx.zhimg.com/v2-demo.jpg?source=abc');
});

test('Markdown 保留图片与公式占位符', () => {
  const article = {
    title: '测试文章',
    author: { name: '作者' },
    canonicalUrl: 'https://zhuanlan.zhihu.com/p/1',
    type: 'article',
    contentHtml: '<h2>标题</h2><p>正文</p><img src="ZHEIMG0001" alt="图"><p>ZHEMATH0001</p>',
    images: [{ token: 'ZHEIMG0001', url: 'https://pic1.zhimg.com/demo.jpg', alt: '图' }],
    math: [{ token: 'ZHEMATH0001', tex: 'x^2', display: false }]
  };
  const markdown = articleToMarkdown(article, { includeFrontmatter: false });
  assert.match(markdown, /ZHEIMG0001/);
  assert.match(markdown, /\$x\^2\$/);
  assert.match(markdown, /## 标题/);
});

test('纯文本移除 Markdown 标记', () => {
  const text = markdownToPlainText('# 标题\n\n**粗体** [链接](https://example.com)');
  assert.equal(text, '标题\n\n粗体 链接 (https://example.com)');
});

test('Markdown 文件打包元数据正确', async () => {
  const article = {
    title: '测试文章',
    author: { name: '作者' },
    canonicalUrl: 'https://zhuanlan.zhihu.com/p/1',
    type: 'article',
    markdown: '正文',
    images: [],
    warnings: []
  };
  const bundle = await prepareArticleFiles(article, OUTPUT_FORMAT.MARKDOWN, { directory: '测试文章' });
  assert.equal(bundle.files.length, 1);
  assert.equal(bundle.files[0].path, '测试文章/测试文章.md');
  assert.match(await bundle.files[0].blob.text(), /^---/);
  assert.match(bundle.markdown, /正文/);
});

test('普通 Markdown 导出使用远程图片地址而不是内部占位符', async () => {
  const article = {
    title: '图片文章',
    author: { name: '作者' },
    canonicalUrl: 'https://zhuanlan.zhihu.com/p/2',
    type: 'article',
    markdown: '![图](ZHEIMG0001)',
    images: [{ token: 'ZHEIMG0001', url: 'https://picx.zhimg.com/demo.jpg', alt: '图' }],
    warnings: []
  };
  const bundle = await prepareArticleFiles(article, OUTPUT_FORMAT.MARKDOWN, { directory: '图片文章' });
  assert.match(bundle.markdown, /picx\.zhimg\.com\/demo\.jpg/);
  assert.doesNotMatch(bundle.markdown, /ZHEIMG0001/);
});

test('ZIP 图片路径使用文章前缀且 Markdown 使用相对路径', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { 'content-type': 'image/png' }
  });
  try {
    const article = {
      title: '图片文章',
      author: { name: '作者' },
      canonicalUrl: 'https://zhuanlan.zhihu.com/p/3',
      type: 'article',
      contentId: '3',
      markdown: '![图](ZHEIMG0001)',
      images: [{ token: 'ZHEIMG0001', url: 'https://picx.zhimg.com/demo.png', alt: '图' }],
      warnings: []
    };
    const bundle = await prepareArticleFiles(article, OUTPUT_FORMAT.ZIP, { directory: '收藏夹', assetPrefix: '3' });
    assert.ok(bundle.files.some((file) => file.path === '收藏夹/assets/3-image-001.png'));
    assert.match(bundle.markdown, /assets\/3-image-001\.png/);
    assert.doesNotMatch(bundle.markdown, /ZHEIMG0001/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test('ZIP 生成可产出非空二进制', async () => {
  const blob = await createZip([{ path: '目录/文件.md', content: '# 标题' }], { compression: 6 });
  assert.ok(blob.size > 0);
  assert.equal(blob.type, 'application/zip');
});
test('TXT 导出保留标题、作者、原文和正文', async () => {
  const article = {
    title: '测试文章',
    author: { name: '作者' },
    canonicalUrl: 'https://zhuanlan.zhihu.com/p/1',
    type: 'article',
    markdown: '正文',
    images: [],
    warnings: []
  };
  const bundle = await prepareArticleFiles(article, OUTPUT_FORMAT.TEXT, { directory: '测试文章' });
  const content = await bundle.files[0].blob.text();
  assert.match(content, /标题：测试文章/);
  assert.match(content, /作者：作者/);
  assert.match(content, /原文：https:\/\/zhuanlan\.zhihu\.com\/p\/1/);
  assert.match(content, /正文/);
});
test('收藏夹读取会分别读取我创建和我关注两个标签', async () => {
  const { document, window } = parseHTML(`<!doctype html><html><body><main>
    <button role="tab" aria-selected="true">我关注的收藏夹</button>
    <button role="tab" id="created-tab">我创建的收藏夹</button>
    <div id="list">
      <div class="CollectionCard"><a href="https://www.zhihu.com/collection/1"><h2 class="CollectionCard-title">关注收藏夹</h2><span>3 条内容</span></a></div>
    </div>
  </main></body></html>`);
  window.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  const createdTab = document.getElementById('created-tab');
  createdTab.addEventListener('click', () => {
    document.getElementById('list').innerHTML = '<div class="CollectionCard"><a href="https://www.zhihu.com/collection/2"><h2 class="CollectionCard-title">创建收藏夹</h2><span>4 条内容</span></a></div>';
    createdTab.setAttribute('aria-selected', 'true');
  });
  const result = await extractCollectionsFromAllTabs(document, window, { tabWaitMs: 5 });
  assert.equal(result.collections.length, 2);
  assert.equal(result.collections.find((item) => item.id === '1').listType, 'followed');
  assert.equal(result.collections.find((item) => item.id === '2').listType, 'created');
  assert.equal(result.listTypes.created, 1);
  assert.equal(result.listTypes.followed, 1);
});
test('收藏夹详情优先使用页面标题而不是数字 ID', () => {
  const { document } = parseHTML('<!doctype html><html><head><meta property="og:title" content="我的收藏夹名称"></head><body><main><h1>第一问答标题</h1><a href="https://www.zhihu.com/people/author">回答作者</a></main></body></html>');
  const meta = extractCollectionMetaFromDocument(document, 'https://www.zhihu.com/collection/846628126');
  assert.equal(meta.title, '我的收藏夹名称');
});

test('收藏夹列表优先使用收藏夹链接名称而不是内部问答标题', () => {
  const { document } = parseHTML('<!doctype html><html><body><main><div class="CollectionCard"><a href="https://www.zhihu.com/collection/846628126"><span>我的真实收藏夹</span><h1>内部第一问答标题</h1></a><span>5 条内容</span></div></main></body></html>');
  const result = extractCollectionsFromDocument(document, 'https://www.zhihu.com/collections');
  assert.equal(result.collections[0].title, '我的真实收藏夹');
});

test('合并收藏夹索引包含多个收藏夹和汇总目录', () => {
  const collections = [
    { id: '1', title: '常用收藏', url: 'https://www.zhihu.com/collection/1', listType: 'created' },
    { id: '2', title: '关注收藏', url: 'https://www.zhihu.com/collection/2', listType: 'followed' }
  ];
  const tasks = [
    { title: '文章A', collectionId: '1', collectionName: '常用收藏', filePath: '常用收藏/文章A.md', status: 'success' },
    { title: '文章B', collectionId: '2', collectionName: '关注收藏', filePath: '关注收藏/文章B.md', status: 'success' }
  ];
  const index = buildMergedCollectionIndex(collections, tasks);
  assert.match(index, /# 知乎收藏合并导出/);
  assert.match(index, /## 常用收藏/);
  assert.match(index, /## 关注收藏/);
  assert.ok(index.includes(encodeURI('常用收藏/文章A.md')));
});
test('后台转换收藏夹摘要时保留来源类型', () => {
  const summary = toPublicCollection({ id: '123', title: '我的收藏夹', url: 'https://www.zhihu.com/collection/123', listType: 'created' });
  assert.equal(summary.title, '我的收藏夹');
  assert.equal(summary.listType, 'created');
});