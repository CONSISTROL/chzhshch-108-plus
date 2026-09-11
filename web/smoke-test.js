/**
 * 浏览器冒烟测试：用 CDP 驱动 headless Chrome 打开 ebook.html，
 * 校验渲染 / 搜索 / 折叠 / 深色 / 字号 / 进度记忆 / 翻页 / 灯箱 / 移动端，并截图。
 *
 * 用法：node web/smoke-test.js
 * 环境变量：
 *   CHROME_PATH  指定浏览器可执行文件（缺省自动探测 Chrome / Edge）
 *   SHOT_DIR     截图输出目录（缺省 <系统临时目录>/chzhshch-ebook-shots）
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

function findBrowser() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env.PROGRAMFILES + '\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  throw new Error('未找到 Chrome/Edge，请用 CHROME_PATH 指定');
}

const CHROME = findBrowser();
const PORT = Number(process.env.CDP_PORT || 9333);
const FILE_URL = 'file:///' + path.resolve(__dirname, 'ebook.html').replace(/\\/g, '/');
const OUT_DIR = process.env.SHOT_DIR || path.join(os.tmpdir(), 'chzhshch-ebook-shots');
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chzhshch-chrome-'));
fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try { return await getJSON(`http://127.0.0.1:${PORT}/json/version`); } catch (e) { await sleep(250); }
  }
  throw new Error('Chrome devtools 未就绪');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error')); });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { resolve, reject } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) c.events.push(msg);
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 60000);
    });
  }
  async eval(expr, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) {
      throw new Error('页面异常: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT_DIR, name + '.png');
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    return p;
  }
}

const results = [];
let cdpRef = null;
// 清存储 + 真重载：localStorage.clear() 不会重置内存里的 state，必须整页重载
async function freshLoad() {
  await cdpRef.eval(`(function(){ try{localStorage.clear();}catch(e){} history.replaceState(null,'',location.pathname); return 1; })()`);
  await sleep(300);
  await cdpRef.send('Page.navigate', { url: FILE_URL });
  await sleep(3200);
}
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + PROFILE_DIR,
    '--allow-file-access-from-files', '--hide-scrollbars', '--window-size=1440,1000', 'about:blank',
  ], { stdio: 'ignore' });

  let cdp;
  try {
    await waitForDevtools();
    const targets = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
    const page = targets.find((t) => t.type === 'page');
    cdp = await CDP.connect(page.webSocketDebuggerUrl);
    cdpRef = cdp;
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');
    await cdp.send('Console.enable').catch(() => {});
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

    // ---- 加载 ----
    await cdp.send('Page.navigate', { url: FILE_URL });
    await sleep(3000);

    const consoleErrors = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
    check('无 JS 异常', consoleErrors.length === 0, consoleErrors.map((e) => JSON.stringify(e.params.exceptionDetails.text)).join('; ').slice(0, 300));

    // 1. 首页
    const home = await cdp.eval(`(function(){
      var r=document.getElementById('reader');
      return {hero: !!r.querySelector('.hero'), h1: (r.querySelector('h1')||{}).textContent||'', stats: r.querySelectorAll('.stat').length,
              tocItems: document.querySelectorAll('.toc-item').length, groups: document.querySelectorAll('.toc-group').length,
              title: document.title, hasContinue: !!r.querySelector('.quick a.primary'), readmeLen: (r.querySelector('.readme')||{textContent:''}).textContent.length};
    })()`);
    check('首页渲染', home.hero && home.h1.includes('缠中说禅'), JSON.stringify(home));
    check('目录 113 项 / 2 分组', home.tocItems === 113 && home.groups === 2, `items=${home.tocItems} groups=${home.groups}`);
    await cdp.shot('01-home');

    // 2. 打开第 1 课（先整页复位，验证「回复默认收起」）
    await freshLoad();
    await cdp.eval(`(function(){ location.hash='0187-486e105c01000461-001'; return 1; })()`);
    await sleep(1200);
    const art = await cdp.eval(`(function(){
      var r=document.getElementById('reader');
      var sec=document.getElementById('cmtSec');
      return {title:(r.querySelector('.art-title')||{}).textContent||'', ps:r.querySelectorAll('.article p').length,
              cmtOpen: sec?sec.classList.contains('open'):null, cmtCards: r.querySelectorAll('article.cmt').length,
              masterCards: r.querySelectorAll('article.cmt-master').length,
              hasToggle: !!document.getElementById('cmtToggle'),
              pagerNext: (r.querySelector('.pager a.next .tt')||{}).textContent||'',
              docTitle: document.title, progressWidth: document.getElementById('progress').style.width||'0%'};
    })()`);
    check('第 1 课渲染', art.ps > 3 && art.title.includes('废人'), JSON.stringify(art));
    check('回复默认收起', art.cmtOpen === false, 'cmtOpen=' + art.cmtOpen);
    check('回复卡片渲染', art.cmtCards === 4 && art.masterCards === 0, `cards=${art.cmtCards} master=${art.masterCards}`);
    check('翻页下一篇', art.pagerNext.length > 0, art.pagerNext);
    check('目录高亮', await cdp.eval(`document.querySelectorAll('.toc-item.on').length`) === 1);
    await cdp.shot('02-lesson1');

    // 3. 展开回复
    await cdp.eval(`document.getElementById('cmtToggle').click()`);
    await sleep(600);
    const openState = await cdp.eval(`(function(){var s=document.getElementById('cmtSec');return {open:s.classList.contains('open'), visible:getComputedStyle(document.querySelector('.cmt-list')).display};})()`);
    check('回复展开', openState.open && openState.visible !== 'none', JSON.stringify(openState));
    await cdp.shot('03-comments');

    // 4. 有疑似缠师回复的文章（W004，38 条）
    await cdp.eval(`(function(){ location.hash='0483-486e105c0100099p-W004'; return 1; })()`);
    await sleep(1200);
    const w = await cdp.eval(`(function(){
      var r=document.getElementById('reader');
      return {cards:r.querySelectorAll('article.cmt').length, master:r.querySelectorAll('article.cmt-master').length,
              figs:r.querySelectorAll('figure.fig img').length, tag:(r.querySelector('.cmt-tag')||{}).textContent||'',
              dup:r.querySelectorAll('.cmt-dup').length};
    })()`);
    check('补充文回复 38 条 + 缠师标记', w.cards === 38 && w.master > 0 && w.tag === '缠师', JSON.stringify(w));
    await cdp.shot('04-w004');

    // 5. 图片文章 + 灯箱
    await cdp.eval(`(function(){ location.hash='0398-486e105c010007hd-014'; return 1; })()`);
    await sleep(1500);
    await cdp.eval(`(function(){ [...document.querySelectorAll('.article figure.fig img')].forEach(function(i){ i.loading='eager'; i.scrollIntoView(); }); window.scrollTo(0,0); return 1; })()`);
    await sleep(2500);
    const imgInfo = await cdp.eval(`(function(){
      var imgs=[...document.querySelectorAll('.article figure.fig img')];
      return {n:imgs.length, loaded: imgs.filter(i=>i.complete&&i.naturalWidth>0).length,
              nat: imgs.map(i=>i.naturalWidth+'x'+i.naturalHeight).join(','), src0:(imgs[0]||{}).src ? imgs[0].src.slice(0,30):''};
    })()`);
    check('配图渲染并解码（含 base64 还原）', imgInfo.n === 3 && imgInfo.loaded === 3, JSON.stringify(imgInfo));
    await cdp.shot('05-image-article');

    const lb = await cdp.eval(`(function(){
      var img=document.querySelector('.article figure.fig img'); img.click();
      var on=document.getElementById('lightbox').classList.contains('on');
      var src=document.querySelector('#lightbox img').src.length>100;
      document.getElementById('lightbox').classList.remove('on');
      return {on:on, src:src};
    })()`);
    check('灯箱打开', lb.on && lb.src, JSON.stringify(lb));

    // 6. 全文搜索
    const search = await cdp.eval(`(function(){
      var q=document.getElementById('q');
      q.value='第三类买点';
      q.dispatchEvent(new Event('input',{bubbles:true}));
      return new Promise(function(res){
        setTimeout(function(){
          var res_el=document.getElementById('results');
          var hits=res_el.querySelectorAll('.res');
          res({on:res_el.classList.contains('on'), hits:hits.length,
               tocHidden:document.getElementById('toc').classList.contains('off'),
               marks:res_el.querySelectorAll('mark').length,
               first:(hits[0]||{textContent:''}).textContent.slice(0,60),
               head:(res_el.querySelector('.res-head')||{textContent:''}).textContent});
        }, 900);
      });
    })()`);
    check('搜索结果出现', search.on && search.hits > 5 && search.marks > 0, JSON.stringify(search));
    await cdp.shot('06-search');

    // 7. 点击搜索结果 → 跳转 + 高亮
    const jump = await cdp.eval(`(function(){
      var el=document.querySelector('.res');
      var id=el.getAttribute('data-id');
      el.click();
      return new Promise(function(res){
        setTimeout(function(){
          var r=document.getElementById('reader');
          res({hash:location.hash, hasMark: !!r.querySelector('mark.hit'), title:(r.querySelector('.art-title')||{}).textContent||'',
               clickedId:id});
        }, 900);
      });
    })()`);
    check('搜索命中跳转并高亮', jump.hasMark && jump.hash === '#' + jump.clickedId, JSON.stringify(jump));
    await cdp.shot('07-search-hit');

    // 8. 深色模式
    await cdp.eval(`document.getElementById('themeBtn').click()`);
    await sleep(500);
    const dark = await cdp.eval(`({theme:document.documentElement.getAttribute('data-theme'), bg:getComputedStyle(document.body).backgroundColor})`);
    check('深色模式', dark.theme === 'dark', JSON.stringify(dark));
    await cdp.shot('08-dark');

    // 9. 字号
    await cdp.eval(`document.querySelector('.seg button[data-size="4"]').click()`);
    await sleep(400);
    const size = await cdp.eval(`({attr:document.documentElement.getAttribute('data-size'), fs:getComputedStyle(document.querySelector('.article')).fontSize})`);
    check('字号放大', size.attr === '4', JSON.stringify(size));
    await cdp.shot('09-fontsize');
    await cdp.eval(`document.querySelector('.seg button[data-size="2"]').click()`);
    await sleep(300);

    // 10. 进度记忆（整页复位 → 深色 + 展开回复 + 滚动 → 真刷新 → 恢复）
    await freshLoad();
    await cdp.eval(`(function(){ location.hash='0483-486e105c0100099p-W004'; return 1; })()`);
    await sleep(1200);
    await cdp.eval(`document.getElementById('themeBtn').click()`);  // 切到深色，验证主题持久化
    await sleep(400);
    await cdp.eval(`(function(){ var s=document.getElementById('cmtSec'); if(s && !s.classList.contains('open')) document.getElementById('cmtToggle').click(); return 1; })()`);
    await sleep(500);
    await cdp.eval(`window.scrollTo(0, 1800)`);
    await sleep(900);
    const before = await cdp.eval(`({y:Math.round(window.scrollY), saved: JSON.parse(localStorage.getItem('chzhshch108.ebook.v1')||'{}').progress[location.hash.slice(1)]||null, theme:JSON.parse(localStorage.getItem('chzhshch108.ebook.v1')||'{}').theme, cmt:JSON.parse(localStorage.getItem('chzhshch108.ebook.v1')||'{}').cmtOpen})`);
    const storeDump = await cdp.eval(`localStorage.getItem('chzhshch108.ebook.v1')`);
    check('进度/主题/回复状态写入 localStorage', !!before.saved && before.saved.s > 500 && before.theme === 'dark' && before.cmt === true, JSON.stringify(before));
    fs.writeFileSync(path.join(OUT_DIR, 'localstorage.json'), storeDump || '');
    const preReload = await cdp.eval(`({hash:location.hash, stored:localStorage.getItem('chzhshch108.ebook.v1')})`);
    fs.writeFileSync(path.join(OUT_DIR, 'prereload.json'), JSON.stringify(preReload, null, 1));
    // 带 hash 重新导航 = 真刷新（保留 URL，等同用户按 F5）
    const reloadUrl = await cdp.eval(`location.href`);
    await cdp.send('Page.navigate', { url: reloadUrl });
    await sleep(3500);
    const after = await cdp.eval(`({y:Math.round(window.scrollY), hash:location.hash, theme:document.documentElement.getAttribute('data-theme'), cmtOpen: document.getElementById('cmtSec')?document.getElementById('cmtSec').classList.contains('open'):null, articles:document.querySelectorAll('.toc-item').length})`);
    check('重新加载后恢复位置/主题/回复状态', after.y > 800 && after.theme === 'dark' && after.cmtOpen === true && after.hash === '#0483-486e105c0100099p-W004', JSON.stringify(after));
    await cdp.shot('10-restored');

    // 11. 键盘翻页
    await cdp.eval(`location.hash='0187-486e105c01000461-001'`);
    await sleep(900);
    const kb = await cdp.eval(`(function(){
      var before=location.hash;
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
      return new Promise(function(res){ setTimeout(function(){ res({before:before, after:location.hash}); },700); });
    })()`);
    check('→ 键翻页', kb.before && kb.before !== kb.after, JSON.stringify(kb));

    // 12. 筛选 chips + 补充文目录
    const chips = await cdp.eval(`(function(){
      document.querySelector('#chips .chip[data-f="extra"]').click();
      var vis=[...document.querySelectorAll('.toc-group')].filter(g=>g.style.display!=='none').map(g=>g.getAttribute('data-kind'));
      var extra=document.querySelectorAll('.toc-item[data-kind="extra"]').length;
      document.querySelector('#chips .chip[data-f="all"]').click();
      var vis2=[...document.querySelectorAll('.toc-group')].filter(g=>g.style.display!=='none').length;
      return {vis:vis, extra:extra, visAll:vis2};
    })()`);
    check('分类筛选', chips.extra === 5 && chips.visAll === 2, JSON.stringify(chips));

    // 13. 移动端视口
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.eval(`location.hash='0187-486e105c01000461-001'`);
    await sleep(1200);
    const mobile = await cdp.eval(`(function(){
      var sb=document.getElementById('sidebar');
      var r={ };
      try { document.getElementById('scrim').click(); } catch(e){}
      return new Promise(function(res){
        setTimeout(function(){
          r.closedLeft=Math.round(sb.getBoundingClientRect().left);
          r.startsClosed=!sb.classList.contains('open');
          document.getElementById('menuBtn').click();
          setTimeout(function(){
            r.openLeft=Math.round(sb.getBoundingClientRect().left);
            r.drawerOpen=sb.classList.contains('open');
            document.getElementById('scrim').click();
            setTimeout(function(){
              r.afterCloseLeft=Math.round(sb.getBoundingClientRect().left);
              r.closedAgain=!sb.classList.contains('open');
              r.articleWidth=Math.round(document.querySelector('.article').getBoundingClientRect().width);
              var vw=document.documentElement.clientWidth;
              r.vw=vw; r.scrollW=document.documentElement.scrollWidth;
              r.wide=[...document.querySelectorAll('body *')].filter(function(el){var b=el.getBoundingClientRect();return b.width>0 && b.right>vw+1;}).map(function(el){return el.tagName+'.'+(el.className||'').toString().slice(0,20);}).slice(0,5);
              res(r);
            }, 450);
          }, 450);
        }, 450);
      });
    })()`);
    check('移动端抽屉开合正常', mobile.startsClosed && mobile.drawerOpen && mobile.openLeft > -2 && mobile.closedAgain && mobile.afterCloseLeft < -100, JSON.stringify(mobile));
    check('移动端无横向溢出', !mobile.wide.length && mobile.scrollW <= mobile.vw + 1, JSON.stringify(mobile));

    // 13b. 移动端首页：统计卡排布 + 顶栏不溢出
    await cdp.eval(`(function(){ history.replaceState(null,'',location.pathname); location.hash=''; return 1; })()`);
    await sleep(200);
    await cdp.eval(`(function(){ if(location.hash) location.hash=''; return 1; })()`);
    await cdp.send('Page.navigate', { url: FILE_URL });
    await sleep(3000);
    const mHome = await cdp.eval(`(function(){
      var stats=[...document.querySelectorAll('.stat')];
      var rows=[...new Set(stats.map(function(s){return Math.round(s.getBoundingClientRect().top);}))];
      var tb=document.querySelector('.topbar');
      var vw=document.documentElement.clientWidth;
      return {statCount:stats.length, rows:rows.length, cols:Math.round(stats.length/rows.length),
              topbarRight:Math.round(tb.getBoundingClientRect().right), vw:vw,
              scrollW:document.documentElement.scrollWidth,
              brandVisible:getComputedStyle(document.querySelector('.brand')).display!=='none',
              quickOverflow: (function(){ var b=document.querySelector('.quick .btn'); return b? Math.round(b.getBoundingClientRect().right) - vw : 0; })(),
              wide:[...document.querySelectorAll('body *')].filter(function(el){var b=el.getBoundingClientRect();return b.width>0&&b.right>vw+1;}).length};
    })()`);
    check('移动端首页统计卡 2 列排布', mHome.statCount === 6 && mHome.rows === 3 && mHome.cols === 2, JSON.stringify(mHome));
    check('移动端顶栏不溢出', mHome.topbarRight <= mHome.vw + 1 && mHome.scrollW <= mHome.vw + 1 && mHome.wide === 0 && mHome.quickOverflow <= 1, JSON.stringify(mHome));
    await cdp.shot('13-mobile-home');
    // 抽屉开合截图
    await cdp.eval(`document.getElementById('menuBtn').click()`);
    await sleep(500);
    await cdp.shot('11-mobile-drawer');
    await cdp.eval(`document.getElementById('scrim').click()`);
    await sleep(500);
    await cdp.shot('12-mobile-reader');

    // 14. 性能：加载耗时
    const perf = await cdp.eval(`(function(){
      var t=performance.getEntriesByType('navigation')[0];
      return {dom:Math.round(t.domContentLoadedEventEnd), load:Math.round(t.loadEventEnd), nodes:document.getElementsByTagName('*').length};
    })()`);
    check('加载性能（DOM < 4s）', perf.dom < 4000, JSON.stringify(perf));
  } catch (e) {
    check('测试执行', false, e.message);
  } finally {
    try { if (cdp) await cdp.send('Browser.close'); } catch (e) {}
    chrome.kill();
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (e) {}
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n== 冒烟结果：${results.length - failed.length}/${results.length} 通过 ==`);
  console.log(`截图目录：${OUT_DIR}`);
  if (failed.length) { failed.forEach((f) => console.log('  FAIL ' + f.name + ': ' + f.detail)); process.exitCode = 1; }
})();
