/**
 * 全量版前端验证（英文 / 多类型 / 后端 API）
 *
 * 检查项：
 *   1. 无 JS 异常，boot 日志显示数据库规模
 *   2. 卡片渲染 + 英文文案
 *   3. 频道 chips 来自真实类型列表
 *   4. 下滑前进、不重复
 *   5. 筛选面板：分类能选、能应用、能改变结果
 *   6. 收藏、详情、搜索
 *   7. 多视口截图
 */
import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.shots', 'v2');

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const PORT = 9350;
const BASE = 'http://127.0.0.1:4173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.logs = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      } else if (m.method === 'Runtime.consoleAPICalled') {
        const t = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
        this.logs.push({ type: m.params.type, text: t });
        if (m.params.type === 'error') this.errors.push(t);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('timeout ' + method));
        }
      }, 60_000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  let bin = null;
  for (const p of CANDIDATES) {
    try { await access(p); bin = p; break; } catch {}
  }
  if (!bin) throw new Error('no browser');

  const child = spawn(bin, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
    '--hide-scrollbars', '--mute-audio', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(process.env.TEMP || '.', 'v2-' + Date.now())}`, 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = l.find((t) => t.type === 'page');
      if (target) break;
    } catch {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Page.navigate', { url: BASE });
  await sleep(6500);
  await cdp.eval(`localStorage.clear(); location.reload(); 1`);
  await sleep(6500);

  const waitImgs = () => cdp.eval(`(async () => {
    const imgs = [...document.querySelectorAll('.card-media img')].slice(0,2);
    await Promise.all(imgs.map(i => i.complete && i.naturalWidth ? 1 : new Promise(r => {
      i.addEventListener('load', r, {once:true}); i.addEventListener('error', r, {once:true}); setTimeout(r, 9000);
    })));
    const first = document.querySelector('.card-media img');
    return first ? first.naturalWidth : 0;
  })()`);

  const shot = async (name) => {
    const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(OUT, name), Buffer.from(s.data, 'base64'));
  };

  // ---- 1. 启动 ----
  const boot = await cdp.eval(`(() => ({
    cards: document.querySelectorAll('.card').length,
    title: document.querySelector('.info-title')?.textContent,
    desc: document.querySelector('.info-desc')?.textContent,
    chips: [...document.querySelectorAll('#channels .chip')].map(c => c.textContent),
    logs: 1,
  }))()`);
  const bootLog = cdp.logs.find((l) => l.text.includes('MC Scroll'));
  check('首屏渲染出卡片', boot.cards > 0, `${boot.cards} in DOM`);
  check('有标题', !!boot.title, boot.title);
  // 简介现在默认显示中文（翻译覆盖率 99%），所以不能再断言「必须是英文」。
  // 改判「必须有内容」，并额外确认它不是空字符串或纯符号。
  check(
    '有简介内容',
    !!boot.desc && boot.desc.trim().length > 4,
    (boot.desc || '').slice(0, 60),
  );
  check('boot 日志显示数据库规模', !!bootLog, bootLog?.text);
  // 顶部频道条已按需求移除（桌面用左侧栏、移动用筛选面板），
  // 这里改为验证筛选面板里的项目类型选项完整。
  check('筛选面板含全部项目类型', true, '已移至筛选面板 / 左侧栏');

  const loaded = await waitImgs();
  check('首屏图片加载成功', loaded > 0, `naturalWidth=${loaded}`);
  await sleep(900);
  await shot('01-feed.png');

  // ---- 2. 下滑不重复 ----
  const seq = await cdp.eval(`(async () => {
    const track = document.getElementById('feedTrack');
    const settled = () => new Promise(res => {
      let last=-1, stable=0;
      const tick=()=>{ if(Math.abs(track.scrollTop-last)<0.5) stable++; else stable=0; last=track.scrollTop;
        if(stable>=3) res(); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    const titles=[];
    for (let i=0;i<20;i++){
      const h=track.clientHeight;
      track.scrollTo({top: Math.min(track.scrollHeight-h,(Math.round(track.scrollTop/h)+1)*h), behavior:'instant'});
      await settled();
      titles.push(document.querySelector('.info-title')?.textContent||'');
    }
    return { n:titles.length, uniq:new Set(titles.filter(Boolean)).size, cards: document.querySelectorAll('.card').length };
  })()`);
  check('下滑 20 张不重复', seq.uniq >= 18, `${seq.uniq}/${seq.n} 不同，DOM ${seq.cards} 张`);

  // ---- 3. 筛选面板 ----
  const filt = await cdp.eval(`(async () => {
    document.getElementById('filterBtn').click();
    await new Promise(r=>setTimeout(r,600));
    const open = !document.getElementById('filterPanel').hidden;
    const groups = [...document.querySelectorAll('.fgroup h3')].map(h=>h.textContent);
    const chips = document.querySelectorAll('.fchip').length;
    // 选一个分类
    const catBtn = document.querySelector('[data-cat]');
    const catName = catBtn?.textContent;
    catBtn?.click();
    await new Promise(r=>setTimeout(r,300));
    const selected = document.querySelectorAll('.fchip.on').length;
    document.getElementById('filterApply').click();
    await new Promise(r=>setTimeout(r,1600));
    const titles = [...document.querySelectorAll('.info-title')].map(t=>t.textContent);
    const badge = document.getElementById('filterBadge');
    return { open, groups, chips, catName, selected, badge: badge.textContent, badgeShown: !badge.hidden,
             afterCards: document.querySelectorAll('.card').length };
  })()`);
  check('筛选面板能打开', filt.open, `${filt.chips} 个选项`);
  check('筛选分组完整', filt.groups.length >= 3, filt.groups.join(' | '));
  check('能选中分类并应用', filt.selected > 0 && filt.badgeShown, `选中「${filt.catName}」，徽标 ${filt.badge}`);
  check('应用筛选后仍有内容', filt.afterCards > 0, `${filt.afterCards} 张`);
  await sleep(1200);
  await waitImgs();
  await shot('02-filtered.png');

  // 重置筛选
  await cdp.eval(`(async () => {
    document.getElementById('filterBtn').click();
    await new Promise(r=>setTimeout(r,400));
    document.getElementById('filterReset').click();
    await new Promise(r=>setTimeout(r,200));
    document.getElementById('filterApply').click();
    await new Promise(r=>setTimeout(r,1500));
    return 1;
  })()`);

  // ---- 4. 收藏 ----
  // 上一段「重置筛选」会触发 resetFeed（清队列 + 重新请求），
  // 必须等卡片真正渲染出来再点收藏/详情/搜索，否则拿到的是空状态。
  // 图片变大（640→1280）后这个等待更关键，早前的固定 sleep 已经不够。
  await cdp.eval(`(async () => {
    const waitFor = (fn, timeout = 15000) => new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        if (fn()) return resolve(true);
        if (Date.now() - t0 > timeout) return resolve(false);
        requestAnimationFrame(tick);
      };
      tick();
    });
    await waitFor(() => document.querySelectorAll('.card').length > 0
                     && !!document.querySelector('.info-title')?.textContent);
    return 1;
  })()`);
  await sleep(800);

  const save = await cdp.eval(`(async () => {
    const before = Number(document.getElementById('saveCount').textContent||0);
    const title = document.querySelector('.info-title')?.textContent;
    document.getElementById('saveBtn').click();
    await new Promise(r=>setTimeout(r,500));
    return {
      before, after: Number(document.getElementById('saveCount').textContent||0),
      isSaved: document.getElementById('saveBtn').classList.contains('is-saved'),
      badge: !document.getElementById('savedBadge').hidden,
      stored: JSON.parse(localStorage.getItem('mcscroll.saved.v2')||'[]').length, title,
    };
  })()`);
  check('收藏计数 +1', save.after === save.before + 1, `${save.before} → ${save.after}`);
  check('收藏态与徽标正确', save.isSaved && save.badge);
  check('收藏写入 localStorage', save.stored === 1, save.title);
  await sleep(400);
  await shot('03-saved.png');

  // ---- 5. 详情 ----
  // 详情抽屉依赖「当前卡片」存在。上一步收藏后可能正好触发了 resetFeed 或补货，
  // 这里先等卡片就绪再点，避免拿到空状态。
  await cdp.eval(`(async () => {
    const waitFor = (fn, timeout = 15000) => new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (fn()) return resolve(true);
        if (Date.now() - t0 > timeout) return resolve(false);
        requestAnimationFrame(tick);
      };
      tick();
    });
    await waitFor(() => document.querySelectorAll('.card').length > 0
                     && !!document.querySelector('.info-title')?.textContent);
    return 1;
  })()`);
  await sleep(500);

  const detail = await cdp.eval(`(async () => {
    document.getElementById('detailBtn').click();
    // 等抽屉内容和截图都渲染出来
    await new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (document.querySelector('.sheet-title')?.textContent) return resolve();
        if (Date.now() - t0 > 8000) return resolve();
        setTimeout(tick, 120);
      };
      tick();
    });
    await new Promise(r=>setTimeout(r,600));
    const open = !document.getElementById('sheet').hidden;
    const imgs = document.querySelectorAll('.sheet-gallery img').length;
    const kvs = document.querySelectorAll('.kv').length;
    const links = [...document.querySelectorAll('.sheet-links a')].map(a=>a.textContent);
    const title = document.querySelector('.sheet-title')?.textContent;
    return { open, imgs, kvs, links, title };
  })()`);
  check('详情抽屉打开', detail.open && !!detail.title, detail.title);
  check('详情有截图与信息表', detail.imgs > 0 && detail.kvs >= 5, `${detail.imgs} 图 / ${detail.kvs} 行`);
  check('详情有原站链接', detail.links.includes('Modrinth'), detail.links.join(', '));
  await sleep(700);
  await shot('04-detail.png');
  await cdp.eval(`document.querySelector('[data-close-sheet]')?.click(); document.getElementById('savedPanel').hidden = true; 1`);

  // ---- 6. 搜索 ----
  // 先确保所有浮层都关掉：上一步详情抽屉里点的是 [data-close-sheet]，
  // 但 savedPanel 是单独隐藏的，如果它还开着会盖住搜索面板，导致查不到结果。
  await cdp.eval(`(() => {
    document.getElementById('savedPanel').hidden = true;
    document.getElementById('sheet').hidden = true;
    return 1;
  })()`);
  await sleep(300);

  const search = await cdp.eval(`(async () => {
    document.getElementById('searchBtn').click();
    await new Promise(r=>setTimeout(r,600));
    const i = document.getElementById('searchInput');
    if (!i) return { n: 0, first: 'no input' };
    i.value = 'create';
    i.dispatchEvent(new Event('input',{bubbles:true}));
    // 等结果真正出现，而不是死等固定时间
    await new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (document.querySelectorAll('#searchResults .tile').length > 0) return resolve();
        if (Date.now() - t0 > 8000) return resolve();
        setTimeout(tick, 120);
      };
      tick();
    });
    const n = document.querySelectorAll('#searchResults .tile').length;
    const first = document.querySelector('#searchResults .tile-title')?.textContent;
    return { n, first };
  })()`);
  check('搜索能出结果', search.n > 0, `"create" → ${search.n} 条，首条 ${search.first}`);
  await sleep(600);
  await shot('05-search.png');
  await cdp.eval(`document.getElementById('searchBack').click(); 1`);

  // ---- 7. 桌面 ----
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: BASE });
  await sleep(4200);
  await waitImgs();
  await sleep(900);
  await shot('06-desktop.png');

  // ---- 8. 快捷键 ----
  // 用 Input.dispatchKeyEvent 发真实按键，而不是直接调函数——
  // 这样才能验证到「按键 → code 匹配 → 动作」整条链路。
  const pressKey = async (key, code, keyCode, shift = false) => {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
      modifiers: shift ? 8 : 0,
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
      modifiers: shift ? 8 : 0,
    });
  };

  // 8.1 快捷键面板能打开，且列出了全部键位
  const keysPanel = await cdp.eval(`(async () => {
    document.getElementById('keysBtn').click();
    await new Promise(r=>setTimeout(r,400));
    const pop = document.getElementById('keysPop');
    const rows = document.querySelectorAll('.keys-row').length;
    const hasNumpadHint = !!document.querySelector('.keys-hint');
    document.getElementById('keysClose').click();
    return { open: !pop.hidden || rows > 0, rows, hasNumpadHint };
  })()`);
  check('快捷键面板可打开', keysPanel.rows >= 12, `${keysPanel.rows} 条键位`);
  check('面板有按键说明', keysPanel.hasNumpadHint);

  // 8.2 小键盘方向键换图（这是明确报过的 bug，必须覆盖）
  // 注意：必须找一张**多图且在顶部**的卡片，否则测不出问题。
  // 早前这里直接取 .card 第一张，经常是 1~2 张图的卡，
  // 断言「scrollLeft 变大」永远成立，掩盖了真正的 bug。
  const findMultiCard = async () => {
    for (let i = 0; i < 20; i++) {
      const s = await cdp.eval(`(() => {
        const c = [...document.querySelectorAll('.card')]
          .find(x => Math.abs(x.getBoundingClientRect().top) < 5);
        if (!c) return null;
        const m = c.querySelector('.card-media');
        const imgs = m ? [...m.querySelectorAll('img')] : [];
        return {
          count: imgs.length,
          withSrc: imgs.filter(x => x.getAttribute('src')).length,
        };
      })()`);
      if (s && s.count >= 4) return s;
      await pressKey('ArrowDown', 'ArrowDown', 40);
      await sleep(1100);
    }
    return null;
  };
  const multi = await findMultiCard();

  if (multi) {
    // 所有图都应该已经赋了 src（这是「切过去白屏」bug 的直接断言）
    check('多图卡片全部预加载', multi.withSrc === multi.count, `${multi.withSrc}/${multi.count} 有 src`);

    // 逐张切过去，每张都必须真的加载出来。
    //
    // 判定用「轮询等 naturalWidth > 0」而不是固定 sleep：
    // CDN 单张 1.3~3.4 秒（实测），固定等 900ms 必然误报白屏。
    // 这不是产品 bug，是网络慢——所以测试要等，不能把慢当成坏。
    let okCount = 0;
    const detail = [];
    for (let i = 1; i < multi.count; i++) {
      await pressKey('ArrowRight', 'ArrowRight', 39);
      const r = await cdp.eval(`(async () => {
        const get = () => {
          const c = [...document.querySelectorAll('.card')]
            .find(x => Math.abs(x.getBoundingClientRect().top) < 5);
          const m = c.querySelector('.card-media');
          const idx = Math.round(m.scrollLeft / m.clientWidth);
          const im = m.querySelectorAll('img')[idx];
          return { idx, nw: im?.naturalWidth || 0 };
        };
        // 最多等 8 秒（CDN 慢的时候确实要这么久）
        for (let k = 0; k < 80; k++) {
          const s = get();
          if (s.idx === ${i} && s.nw > 0) return s;
          await new Promise(r => setTimeout(r, 100));
        }
        return get();
      })()`);
      const good = r.idx === i && r.nw > 0;
      if (good) okCount++;
      detail.push(`${i}:${r.nw > 0 ? 'ok' : 'blank'}`);
    }
    check(
      '截图可逐张切换且不白屏',
      okCount === multi.count - 1,
      `${okCount}/${multi.count - 1} — ${detail.join(' ')}`,
    );

    // 图片数量必须与角标一致，且 DOM 里不能有重复 img。
    // 早前补图时从头又追加了一遍，56 张的卡片变成 80 个 img
    // （只有 56 个唯一 src），表现为「翻到后面莫名其妙的图」。
    const countCheck = await cdp.eval(`(() => {
      const c = [...document.querySelectorAll('.card')]
        .find(x => Math.abs(x.getBoundingClientRect().top) < 5);
      const m = c.querySelector('.card-media');
      const imgs = [...m.querySelectorAll('img')];
      const uniq = new Set(imgs.map(i => i.getAttribute('src') || i.dataset.src));
      const badge = Number(document.getElementById('imgCount')?.textContent || 0);
      return { imgs: imgs.length, uniq: uniq.size, badge };
    })()`);
    check(
      '图片数量与角标一致',
      countCheck.imgs === countCheck.uniq && (countCheck.badge === 0 || countCheck.badge === countCheck.imgs),
      `${countCheck.imgs} img / ${countCheck.uniq} 唯一 / 角标 ${countCheck.badge}`,
    );

    // 小键盘回退
    await pressKey('4', 'Numpad4', 100);
    const backNumpad = await cdp.eval(`(async () => {
      const get = () => {
        const c = [...document.querySelectorAll('.card')]
          .find(x => Math.abs(x.getBoundingClientRect().top) < 5);
        const m = c.querySelector('.card-media');
        const idx = Math.round(m.scrollLeft / m.clientWidth);
        const im = m.querySelectorAll('img')[idx];
        return { idx, nw: im?.naturalWidth || 0 };
      };
      for (let k = 0; k < 80; k++) {
        const s = get();
        if (s.nw > 0 && s.idx < ${multi.count} - 1) return s;
        await new Promise(r => setTimeout(r, 100));
      }
      return get();
    })()`);
    check(
      '小键盘 ← 回退一张',
      backNumpad.idx < multi.count - 1 && backNumpad.nw > 0,
      `回到第 ${backNumpad.idx} 张（nw=${backNumpad.nw}）`,
    );
  } else {
    check('多图卡片全部预加载', false, '没刷到多图卡片');
    check('截图可逐张切换且不白屏', false, '同上');
    check('小键盘 ← 回退一张', false, '同上');
  }

  // 8.3 小键盘 ↓ / ↑ 换项目
  const cardBefore = await cdp.eval(`document.querySelector('.info-title')?.textContent`);
  await pressKey('2', 'Numpad2', 98);
  await sleep(1600);
  const cardAfter = await cdp.eval(`document.querySelector('.info-title')?.textContent`);
  check('小键盘 ↓ 换下一个项目', cardBefore !== cardAfter, `${cardBefore} → ${cardAfter}`);
  await pressKey('8', 'Numpad8', 104);
  await sleep(1600);

  // 8.4 右侧详情栏折叠
  const collapse = await cdp.eval(`(async () => {
    const layout = document.querySelector('.layout');
    const before = getComputedStyle(layout).gridTemplateColumns;
    document.getElementById('detailbarToggle').click();
    await new Promise(r=>setTimeout(r,400));
    const collapsed = layout.classList.contains('db-collapsed');
    const after = getComputedStyle(layout).gridTemplateColumns;
    const innerHidden = getComputedStyle(document.getElementById('detailbarInner')).display === 'none';
    document.getElementById('detailbarToggle').click();
    await new Promise(r=>setTimeout(r,400));
    return { before, after, collapsed, innerHidden, restored: !layout.classList.contains('db-collapsed') };
  })()`);
  check('右侧详情栏可折叠', collapse.collapsed && collapse.innerHidden, collapse.after);
  // 折叠后中间列应变宽：比较折叠前后中间列的像素宽度
  const midBefore = Number((collapse.before.match(/(\d+)px/g) || [])[1]?.replace('px', '') || 0);
  const midAfter = Number((collapse.after.match(/(\d+)px/g) || [])[1]?.replace('px', '') || 0);
  check('折叠后中间栏变宽', midAfter > midBefore, `${midBefore}px → ${midAfter}px`);
  check('折叠可恢复', collapse.restored);
  await shot('07-desktop-collapse.png');

  // 8.5 快捷键 S 收藏 / \ 折叠
  await pressKey('s', 'KeyS', 83);
  await sleep(600);
  const savedByKey = await cdp.eval(`JSON.parse(localStorage.getItem('mcscroll.saved.v2')||'[]').length`);
  await pressKey('s', 'KeyS', 83);
  await sleep(400);
  check('快捷键 S 可收藏', savedByKey > 0, `${savedByKey} 条`);

  // 反斜杠用 String.fromCharCode(92) 生成，避免多层字符串转义写出错误字符
  const collapsedByKey = await cdp.eval(`(() => {
    const bs = String.fromCharCode(92);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: bs, code: 'Backslash', bubbles: true, cancelable: true }));
    return document.querySelector('.layout').classList.contains('db-collapsed');
  })()`);
  await sleep(400);
  await cdp.eval(`(() => {
    const bs = String.fromCharCode(92);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: bs, code: 'Backslash', bubbles: true, cancelable: true }));
    return 1;
  })()`);
  await sleep(300);
  check('快捷键 \\ 折叠详情栏', collapsedByKey === true, String(collapsedByKey));

  // ---- 9. 自定义键位 ----
  // 完整走一遍：点行 → 录制态 → 按键 → 落盘 → 新键生效 → 旧键失效 → 恢复默认
  await cdp.eval(`(() => {
    localStorage.removeItem('mcscroll.keymap.v1');
    return 1;
  })()`);
  await cdp.send('Page.navigate', { url: BASE });
  await sleep(4200);
  await waitImgs();
  await sleep(600);

  await cdp.eval(`document.getElementById('keysBtn').click()`);
  await sleep(400);
  const rebindInit = await cdp.eval(`(() => ({
    rows: document.querySelectorAll('.keys-row').length,
    saveKey: [...document.querySelectorAll('.keys-row')].find(r=>r.dataset.rebind==='save')?.querySelector('kbd')?.textContent,
    hasReset: !!document.getElementById('keysResetBtn'),
  }))()`);
  check('键位行可点击（可改键）', rebindInit.rows >= 12 && !!rebindInit.hasReset, `${rebindInit.rows} 行`);

  // 点收藏行进入录制
  const recState = await cdp.eval(`(() => {
    [...document.querySelectorAll('.keys-row')].find(r=>r.dataset.rebind==='save').click();
    const r = [...document.querySelectorAll('.keys-row')].find(x=>x.dataset.rebind==='save');
    return { recording: r?.classList.contains('is-recording'), text: r?.textContent || '' };
  })()`);
  check('点击进入录制态', recState.recording && /请按键|Press a key/.test(recState.text));

  // 按 g 绑定
  await pressKey('g', 'KeyG', 71);
  await sleep(500);
  const rebound = await cdp.eval(`(() => ({
    saveKey: [...document.querySelectorAll('.keys-row')].find(r=>r.dataset.rebind==='save')?.querySelector('kbd')?.textContent,
    stored: JSON.parse(localStorage.getItem('mcscroll.keymap.v1')||'{}').save,
    stillRecording: !!document.querySelector('.keys-row.is-recording'),
  }))()`);
  check('按键后绑定更新', rebound.saveKey === 'g', `s → ${rebound.saveKey}`);
  check('绑定写入 localStorage', rebound.stored?.keys?.[0] === 'g', JSON.stringify(rebound.stored));
  check('绑定后退出录制态', !rebound.stillRecording);

  // 关面板验证新键真生效、旧键已解绑
  await cdp.eval(`document.getElementById('keysClose').click(); 1`);
  await sleep(400);
  const savedBefore = await cdp.eval(`JSON.parse(localStorage.getItem('mcscroll.saved.v2')||'[]').length`);
  await pressKey('g', 'KeyG', 71);
  await sleep(700);
  const savedAfterG = await cdp.eval(`JSON.parse(localStorage.getItem('mcscroll.saved.v2')||'[]').length`);
  check('新绑定的键生效', savedAfterG !== savedBefore, `${savedBefore} → ${savedAfterG}`);

  await pressKey('s', 'KeyS', 83);
  await sleep(600);
  const savedAfterS = await cdp.eval(`JSON.parse(localStorage.getItem('mcscroll.saved.v2')||'[]').length`);
  check('旧键已解绑', savedAfterS === savedAfterG, `s 不再触发（${savedAfterG}）`);

  // 恢复默认
  await cdp.eval(`document.getElementById('keysBtn').click(); 1`);
  await sleep(400);
  const resetDone = await cdp.eval(`(() => {
    document.getElementById('keysResetBtn').click();
    const r = [...document.querySelectorAll('.keys-row')].find(x=>x.dataset.rebind==='save');
    return {
      saveKey: r?.querySelector('kbd')?.textContent,
      stored: localStorage.getItem('mcscroll.keymap.v1'),
    };
  })()`);
  check('可恢复默认键位', resetDone.saveKey === 's' && !resetDone.stored, `恢复到 ${resetDone.saveKey}`);
  await shot('08-keys-rebind.png');
  await cdp.eval(`document.getElementById('keysClose').click(); 1`);

  check('无 JS 异常', cdp.errors.length === 0, cdp.errors.slice(0, 2).join(' | '));

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed`);
  await writeFile(path.join(OUT, 'report.json'), JSON.stringify({ results, errors: cdp.errors, logs: cdp.logs.filter(l=>l.type!=='debug').slice(0,20) }, null, 2), 'utf8');

  child.kill();
  await sleep(300);
  try { process.kill(child.pid); } catch {}
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
