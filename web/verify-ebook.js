// 自检：从生成的 ebook.html 里取回数据，校验结构与渲染完整性
// 用法：node web/verify-ebook.js
const fs = require('fs');
const path = require('path');

const EBOOK = path.join(__dirname, 'ebook.html');
const html = fs.readFileSync(EBOOK, 'utf8');
const m = html.match(/window\.__BOOK__\s*=\s*([\s\S]*?);\n<\/script>/);
if (!m) throw new Error('未找到 __BOOK__ 数据');
const DATA = JSON.parse(m[1]);
const A = DATA.articles;

const problems = [];
const stats = { articles: 0, lessons: 0, extras: 0, comments: 0, figures: 0, emptyBody: [], cmtMismatch: [], rawMd: [], missingImg: 0, todoTokens: 0 };

// 残留占位符
for (const tok of ['__BOOK_TITLE__', '__BOOK_SUB__', '__STAT_', '__BUILD_DATE__']) {
  if (html.includes(tok)) problems.push('残留占位符: ' + tok);
}

const lessonNums = new Set();
for (const a of A) {
  stats.articles++;
  if (a.k === 'lesson') { stats.lessons++; lessonNums.add(a.l); } else stats.extras++;
  stats.comments += a.n;
  stats.figures += (a.b.match(/<figure class="fig">/g) || []).length;

  if (!a.t || a.t.length < 2) problems.push('标题为空: ' + a.i);
  if (!a.b || a.b.replace(/<[^>]*>/g, '').trim().length < 30) stats.emptyBody.push(a.i);
  if (a.n > 0 && !a.m) stats.cmtMismatch.push(a.i + ' 声明' + a.n + '条但无内容');
  if (a.m) {
    const cards = (a.m.match(/<article class="cmt/g) || []).length;
    if (cards !== a.n) stats.cmtMismatch.push(`${a.i}: 卡片 ${cards} ≠ 声明 ${a.n}`);
  }
  // 未渲染的 markdown 残留
  if (/^\s*#{1,6}\s|\*\*[^*]+\*\*/m.test(a.b.replace(/<[^>]*>/g, '')) === false && /\*\*/.test(a.b)) {
    stats.rawMd.push(a.i + ' 正文含未渲染 **');
  }
  if (/^```/m.test(a.b)) stats.rawMd.push(a.i + ' 正文含围栏');
  stats.missingImg += (a.b.match(/img-missing/g) || []).length;
}

// 课文 1..108 是否齐全
const missingLessons = [];
for (let i = 1; i <= 108; i++) if (!lessonNums.has(String(i).padStart(3, '0'))) missingLessons.push(i);

// 目录顺序 & 元数据
const orderIdx = A.map((a) => Number(a.l) || 0);
const lessonSorted = A.filter((a) => a.k === 'lesson').map((a) => Number(a.l));
const sortedOk = lessonSorted.every((v, i) => i === 0 || lessonSorted[i - 1] < v);

// base64 图片
const imgs = html.match(/data:image\/[a-z+]+;base64,/g) || [];

console.log('== 结构自检 ==');
console.log('文章', stats.articles, '（课文', stats.lessons, '补充', stats.extras, '）');
console.log('回复卡片合计', stats.comments, '| 配图 figure', stats.figures, '| base64 图片', imgs.length);
console.log('课文序号连续且有序:', sortedOk, '| 缺课:', missingLessons.length ? missingLessons.join(',') : '无');
console.log('回复数不一致:', stats.cmtMismatch.length ? stats.cmtMismatch : '无');
console.log('正文过短:', stats.emptyBody.length ? stats.emptyBody : '无');
console.log('markdown 残留:', stats.rawMd.length ? stats.rawMd : '无');
console.log('缺图占位:', stats.missingImg);
console.log('HTML 体积', (Buffer.byteLength(html) / 1048576).toFixed(2), 'MB');
console.log('脚本标签数', (html.match(/<script/g) || []).length, '| 未闭合 script 迹象:', /<\/script>[\s\S]*<\/script>[\s\S]*<\/body>/.test(html) ? 'ok' : '检查');
console.log('问题:', problems.length ? problems : '无');

if (problems.length || stats.cmtMismatch.length || stats.emptyBody.length || missingLessons.length || !sortedOk) {
  process.exitCode = 1;
}
