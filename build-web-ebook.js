#!/usr/bin/env node
/**
 * 缠中说禅教你炒股票 108 课加强版 —— Web 电子书构建脚本
 *
 * 读取 108/*.md（含 108/pic 配图），生成单文件离线电子书 web/ebook.html：
 *   - 全部 113 篇文章（108 课课文 + 解盘 + 补充文）
 *   - 课后回复折叠块（默认收起）
 *   - 全文搜索索引、分类目录、深色模式、字号调节、阅读进度记忆
 *   - 配图以 base64 data URI 内嵌，双击即可阅读、可单独转发
 *
 * 用法：node build-web-ebook.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, '108');
const PIC_DIR = path.join(SRC_DIR, 'pic');
const OUT_DIR = path.join(ROOT, 'web');
const OUT_FILE = path.join(OUT_DIR, 'ebook.html');
const TEMPLATE_FILE = path.join(ROOT, 'web', 'template.html');
const README_FILE = path.join(ROOT, 'README.md');

/* ------------------------------------------------------------------ *
 * 1. 基础工具
 * ------------------------------------------------------------------ */

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const escAttr = (s) => esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function stripTags(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr|figcaption)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function normalizeText(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ *
 * 2. 配图：读磁盘 → base64 data URI（带缓存）
 * ------------------------------------------------------------------ */

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

const imageCache = new Map();
const imageStats = { count: 0, bytes: 0, missing: [] };

function dataUri(rel) {
  const key = rel.replace(/^\.\//, '').replace(/^pic\//, '');
  if (imageCache.has(key)) return imageCache.get(key);
  const abs = path.join(PIC_DIR, key);
  let uri = '';
  if (fs.existsSync(abs)) {
    const buf = fs.readFileSync(abs);
    const mime = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    uri = `data:${mime};base64,${buf.toString('base64')}`;
    imageStats.count += 1;
    imageStats.bytes += buf.length;
  } else {
    imageStats.missing.push(key);
  }
  imageCache.set(key, uri);
  return uri;
}

/* ------------------------------------------------------------------ *
 * 3. 极简 Markdown 渲染器（针对本语料：课文 + 论坛回复）
 * ------------------------------------------------------------------ */

function sanitize(text) {
  return String(text)
    .replace(/<br\s*\/?>/gi, '')
    .replace(/<\/?(?!\/?(?:b|strong|i|em|u|sub|sup|br|span)\b)[a-zA-Z][^>]*>/g, (m) => esc(m));
}

function inline(text) {
  const codes = [];
  let s = String(text).replace(/`([^`]+)`/g, (m, c) => {
    codes.push(c);
    return `\u0000C${codes.length - 1}\u0000`;
  });

  s = esc(s);

  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (m, alt, src, title) => {
    const uri = dataUri(src);
    if (!uri) return `<span class="img-missing">[缺失配图：${esc(src)}]</span>`;
    const cap = alt && !/^image-\d+/.test(alt) ? `<figcaption>${esc(alt)}</figcaption>` : '';
    return `<figure class="fig"><img loading="lazy" src="${uri}" alt="${escAttr(alt || '配图')}"${title ? ` title="${title}"` : ''}>${cap}</figure>`;
  });

  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (m, txt, href) => {
    return `<a href="${escAttr(href)}" target="_blank" rel="noopener noreferrer">${txt}<span class="ext">↗</span></a>`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, href) => {
    return `<a href="${escAttr(href)}">${txt}</a>`;
  });

  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s（(])\*([^*\n]+)\*(?=[\s，。、；：！？）)]|$)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  s = s.replace(/\u0000C(\d+)\u0000/g, (m, i) => `<code>${esc(codes[Number(i)])}</code>`);
  return s;
}

function isTableSeparator(line) {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-');
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function blocks(text, opts = {}) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];

  const flush = () => {
    if (para.length) {
      out.push(`<p>${para.map((l) => inline(l.trim())).join('<br>')}</p>`);
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 空行
    if (!trimmed) { flush(); continue; }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed) && !/^-\s/.test(trimmed)) {
      flush();
      out.push('<hr>');
      continue;
    }

    // 标题
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      const lv = Math.min(h[1].length + 1, 6); // # → h2（h1 留给书名）
      out.push(`<h${lv}>${inline(h[2].replace(/\s+#+\s*$/, ''))}</h${lv}>`);
      continue;
    }

    // 表格
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]) && lines[i + 1].includes('|')) {
      flush();
      const head = splitRow(trimmed);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim().includes('|')) {
        rows.push(splitRow(lines[i].trim()));
        i++;
      }
      i--;
      out.push(
        '<div class="table-wrap"><table><thead><tr>' +
          head.map((c) => `<th>${inline(c)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table></div>'
      );
      continue;
    }

    // 引用
    if (/^>\s?/.test(trimmed)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      i--;
      out.push(`<blockquote>${blocks(buf.join('\n'), opts)}</blockquote>`);
      continue;
    }

    // 有序 / 无序列表
    const ul = trimmed.match(/^[-*+]\s+(.*)$/);
    const ol = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flush();
      const ordered = Boolean(ol);
      const items = [];
      while (i < lines.length) {
        const t = lines[i].trim();
        const m = ordered ? t.match(/^\d+[.)]\s+(.*)$/) : t.match(/^[-*+]\s+(.*)$/);
        if (!m) break;
        items.push(`<li>${inline(m[1])}</li>`);
        i++;
      }
      i--;
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }

    para.push(line);
  }
  flush();
  return out.filter(Boolean).join('\n');
}

/* ------------------------------------------------------------------ *
 * 4. 解析单篇文档
 * ------------------------------------------------------------------ */

const MARKER_RE = /^\*\*本文评论获取自[^\n]*$/m;
const QUOTE_HEADER_RE = /^UID:\[(\d+)\]\s*昵称：(.+?)\s*日期：\(([^)]*)\)\s*$/;
const META_RE = /日期：\(([^)]*)\)\s*分类：\[([^\]]*)\]/;

function splitComments(raw) {
  const parts = raw.split(/^`{3,}\s*$/m);
  let body = '';
  let commentText = '';
  let inComment = false;
  for (const part of parts) {
    if (inComment) commentText += '\n```\n' + part;
    else body += part;
    inComment = !inComment;
  }
  return { body, commentText };
}

function renderComments(text) {
  const chunks = [];
  const blocksRaw = String(text).split(/^`{3,}\s*$/m);
  for (const raw of blocksRaw) {
    const t = raw.trim();
    if (!t) continue;
    if (/^UID:\[/.test(t) || t.startsWith('*')) chunks.push(t);
  }

  const cards = [];
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    let nick = '';
    let date = '';
    let quoteId = '';
    let contentLines = lines;
    if (lines.length && /^UID:\[/.test(lines[0].trim())) {
      const m = lines[0].trim().match(QUOTE_HEADER_RE);
      if (m) {
        quoteId = m[1];
        nick = m[2].trim();
        date = m[3].trim();
        contentLines = lines.slice(1);
      } else {
        contentLines = lines.slice(1);
      }
    }
    const content = contentLines.join('\n').trim();
    if (!nick && !content) continue;
    const isMaster = quoteId === '1215172700' || /缠中说禅/.test(nick);
    const nickClean = nick.replace(/\[匿名\]\s*/, '') || '匿名';
    cards.push(
      `<article class="cmt${isMaster ? ' cmt-master' : ''}">` +
        `<header class="cmt-head"><span class="cmt-nick">${esc(nickClean)}</span>` +
        (isMaster ? '<span class="cmt-tag">缠师</span>' : '') +
        `<time class="cmt-date">${esc(date)}</time></header>` +
        `<div class="cmt-body">${content ? blocks(content) : ''}</div>` +
        '</article>'
    );
  }
  return { html: cards.join('\n'), count: cards.length };
}

function parseFile(fileName) {
  const raw = fs.readFileSync(path.join(SRC_DIR, fileName), 'utf8');
  const nameMatch = fileName.match(/^(\d+)-([0-9a-z]+)-(.+)\.md$/);
  const blogId = nameMatch ? nameMatch[1] : '';
  const tail = nameMatch ? nameMatch[3] : fileName.replace(/\.md$/, '');

  let kind = 'extra';        // lesson | extra（解盘等补充文章）
  let lesson = 0;            // 课文序号 1..108
  if (/^\d{3}$/.test(tail)) {
    const n = Number(tail);
    if (n >= 1 && n <= 108) { kind = 'lesson'; lesson = n; }
  }

  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  let title = fileName.replace(/\.md$/, '');
  let date = '';
  let category = '';
  let cursor = 0;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    const m = t.match(/^#\s+(.*)$/);
    if (m) {
      // # 0187 - 教你炒股票1：...   → 去掉博客编号前缀
      title = m[1].replace(/^\d+\s*[-–—]\s*/, '').trim();
      cursor = i + 1;
    } else {
      cursor = i;
    }
    break;
  }

  for (let i = cursor; i < Math.min(lines.length, cursor + 6); i++) {
    const t = lines[i].trim();
    if (!t) continue;
    const m = t.match(META_RE);
    if (m) {
      date = m[1].trim();
      category = m[2].replace(/^\[|\]$/g, '').trim();
      cursor = i + 1;
    }
    break;
  }

  const rest = lines.slice(cursor).join('\n');
  const markerMatch = rest.match(MARKER_RE);
  const declaredComments = markerMatch ? Number((markerMatch[0].match(/\[(\d+)\]/) || [0, 0])[1]) : 0;
  const withoutMarker = rest.replace(MARKER_RE, '\n');

  const { body: bodyRaw, commentText } = splitComments(withoutMarker);

  // 正文尾部与首条回复重复的“附录”段落去重
  const bodyText = bodyRaw.replace(/\n{3,}/g, '\n\n').trim();
  const { html: cmtHtml, count: cmtCount } = renderComments(commentText);

  const bodyHtml = blocks(bodyText);
  const bodyPlain = normalizeText(stripTags(bodyHtml));
  // 去重：若某条回复其实是正文的完整复制，去掉该卡片的正文部分
  let dedupedCmtHtml = cmtHtml;
  if (cmtHtml) {
    const paras = bodyText.split(/\n{2,}/).map((p) => normalizeText(p.replace(/\*\*/g, ''))).filter((p) => p.length >= 60);
    const mine = paras.slice(-3);
    let tmp = cmtHtml;
    const chunks = tmp.split(/(?=<article class="cmt)/);
    const kept = chunks.map((c) => {
      const inner = normalizeText(stripTags(c.replace(/<[^>]*>/g, '\u0001')));
      const isDup = mine.some((p) => inner.length > 200 && (inner.includes(p) || p.includes(inner)));
      return isDup ? c.replace(/<div class="cmt-body">[\s\S]*<\/div>/, '<div class="cmt-body cmt-dup"><span class="cmt-note">（本条与上文正文重复，已折叠）</span></div>') : c;
    });
    dedupedCmtHtml = kept.join('');
  }

  const text = bodyPlain;
  const cmtPlain = normalizeText(stripTags(dedupedCmtHtml));

  // 排序键：课文按序号；补充文按其博客编号插入相应位置
  const blogNum = Number(blogId) || 0;
  const order = kind === 'lesson' ? lesson * 10 : 100000 + blogNum;

  return {
    id: fileName.replace(/\.md$/, ''),
    kind,
    lesson,
    label: kind === 'lesson' ? String(lesson).padStart(3, '0') : tail.replace(/[()]/g, ''),
    title,
    date,
    category,
    blogId,
    comments: cmtCount,
    declaredComments,
    body: bodyHtml,
    cmt: dedupedCmtHtml,
    text,
    cmtPlain,
    order,
  };
}

/* ------------------------------------------------------------------ *
 * 5. 主流程
 * ------------------------------------------------------------------ */

function main() {
  const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.md')).sort();
  // 按文件名里的博客编号（第二段）排序
  files.sort((a, b) => {
    const na = Number(a.split('-')[0]);
    const nb = Number(b.split('-')[0]);
    return na - nb;
  });

  const articles = files.map(parseFile).sort((a, b) => a.order - b.order || a.blogId.localeCompare(b.blogId));

  const readme = fs.existsSync(README_FILE) ? fs.readFileSync(README_FILE, 'utf8') : '';
  const readmeHtml = blocks(readme.replace(/\r\n?/g, '\n'));

  const data = {
    generatedAt: new Date().toISOString().slice(0, 10),
    bookTitle: '缠中说禅教你炒股票',
    bookSub: '108 课加强版 · 全集',
    articles: articles.map((a) => ({
      i: a.id,
      k: a.kind,
      l: a.label,
      t: a.title,
      d: a.date,
      c: a.category,
      n: a.comments,
      b: a.body,
      m: a.cmt,
      x: a.text,
      y: a.cmtPlain,
    })),
    readme: readmeHtml,
  };

  if (!fs.existsSync(TEMPLATE_FILE)) {
    console.error(`缺少模板文件：${TEMPLATE_FILE}`);
    process.exit(1);
  }
  const template = fs.readFileSync(TEMPLATE_FILE, 'utf8');

  const commentsTotal = articles.reduce((s, a) => s + a.comments, 0);
  const declaredTotal = articles.reduce((s, a) => s + a.declaredComments, 0);
  const charsTotal = articles.reduce((s, a) => s + a.text.length, 0);

  // 先替换元信息占位符，最后注入 JSON（避免对数据做全局替换）
  let html = template
    .replace(/__BOOK_TITLE__/g, esc(data.bookTitle))
    .replace(/__BOOK_SUB__/g, esc(data.bookSub))
    .replace(/__STAT_ARTICLES__/g, String(articles.length))
    .replace(/__STAT_COMMENTS__/g, String(commentsTotal))
    .replace(/__STAT_CHARS__/g, (charsTotal / 10000).toFixed(1) + ' 万')
    .replace(/__STAT_IMAGES__/g, String(imageStats.count))
    .replace(/__BUILD_DATE__/g, data.generatedAt);

  const payload = JSON.stringify(data).replace(/</g, '\\u003c');
  if (!html.includes('/*__BOOK_DATA__*/')) throw new Error('模板缺少 /*__BOOK_DATA__*/ 占位符');
  // 模板里占位符已被 <script> 包裹，这里只注入赋值语句
  html = html.replace('/*__BOOK_DATA__*/', () => 'window.__BOOK__ = ' + payload + ';');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, html, 'utf8');

  const size = fs.statSync(OUT_FILE).size;
  console.log('✅ 电子书已生成');
  console.log(`   输出：${path.relative(ROOT, OUT_FILE)}`);
  console.log(`   文章：${articles.length} 篇（课文 ${articles.filter((a) => a.kind === 'lesson').length}，补充 ${articles.filter((a) => a.kind !== 'lesson').length}）`);
  console.log(`   回复：${commentsTotal} 条（原文标注合计 ${declaredTotal} 条）`);
  console.log(`   配图：${imageStats.count} 张（${(imageStats.bytes / 1048576).toFixed(1)} MB 原图）`);
  console.log(`   正文：约 ${(charsTotal / 10000).toFixed(1)} 万字`);
  console.log(`   体积：${(size / 1048576).toFixed(2)} MB`);
  if (imageStats.missing.length) console.warn(`   ⚠️ 缺失配图：${imageStats.missing.join(', ')}`);
}

main();
