/**
 * MC Scroll — front-end
 *
 * 架构变化（相对第一版）：
 *   数据不再打包成静态 JSON，改为走后端 API（SQLite，全量 17.8 万项目）。
 *   本文件只负责「渲染 + 交互 + 无限流」，不再持有全量数据。
 *
 * 关键设计：
 *   - 卡片按绝对索引定位（top = idx * 100dvh），滚动高度由 spacer 撑起。
 *     绝不能用 scrollTop/高度 当队列下标——那只是窗口内相对序号，会卡死。
 *   - 只保留当前卡 ±2 的 DOM，其余回收。几百张卡同挂大图会拖死移动端。
 *   - 图片三级加载：350px 缩略图（~60KB）先出 → 停留 700ms 后换原图。
 *   - 文案通过 js/i18n.js 切换中英，分类/加载器来自后端 taxonomy，不写死枚举。
 */

import * as i18n from './i18n.js';

const { t, fmtNum, setLang, getLang } = i18n;

/**
 * API 基址。
 *
 * 刻意和页面 origin 不同名：图片走 /api/img（同源），
 * 而数据请求走 http://localhost:PORT（跨源）。
 *
 * 为什么：HTTP/1.1 下同一域名最多 6 个并发连接。
 * 刷流时几十个图片请求会把 api/img 的连接占满，
 * 此时换筛选要发的 /api/feed 就得排队，实测能卡几十秒不返回。
 * 拆成两个主机名后各自独立计数，数据请求再也不会被图片挤掉。
 */
const API_ORIGIN = (() => {
  if (typeof location === 'undefined') return '';
  // 已经在 localhost 访问时就用 127.0.0.1，反之亦然
  const alt = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
  return `${location.protocol}//${alt}:${location.port}`;
})();

const API = '';

const LS = {
  saved: 'mcscroll.saved.v2',
  filters: 'mcscroll.filters.v2',
  device: 'mcscroll.device.v1',
  detailCollapsed: 'mcscroll.detailCollapsed.v1',
  keymap: 'mcscroll.keymap.v1',
};

const $ = (id) => document.getElementById(id);

/* ---------------- 本地状态 ---------------- */

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function deviceId() {
  let id = loadJson(LS.device, null);
  if (!id) {
    id = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    saveJson(LS.device, id);
  }
  return id;
}

const state = {
  queue: [],
  cursor: 0,
  nextCursor: null,
  loading: false,
  exhausted: false,
  saved: loadJson(LS.saved, []),
  filters: loadJson(LS.filters, { types: [], categories: [], loaders: [], versions: [], requireImages: true }),
  taxonomy: null,
  viewStart: Date.now(),
  upgradeTimer: null,
  token: 0,
  // 请求代次：切筛选/切频道时 +1，用来丢弃过时的在途响应
  epoch: 0,
  rebuilding: false,
  // 正在等待用户按键的动作 label（快捷键面板的录制态）
  rebind: null,
};

const savedKeys = () => new Set(state.saved.map((s) => s.slug));

/* ---------------- 工具 ---------------- */

function titleCase(s) {
  return String(s || '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

/** 项目类型显示名（跟随语言） */
const typeLabel = (type) => i18n.typeLabel(type);

/**
 * 当前视口下卡片图片需要多宽（用于「停留后升级」到高清版）。
 */
function measureWidth() {
  const feed = document.getElementById('feed');
  const w = feed?.clientWidth || window.innerWidth || 430;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const exact = w * dpr;
  if (exact <= 700) return 640;
  if (exact <= 1400) return 1280;
  return 1600;
}

/**
 * 把图片对象里的代理地址改成指定宽度。
 * 只对 /api/img?w=N&u=... 形式的 URL 生效，直连 CDN 的地址原样返回。
 */
function pickVariant(img, width) {
  const src = img.thumb || img.url || '';
  if (!src) return '';
  if (!src.startsWith('/api/img')) return src;
  return src.replace(/([?&])w=\d+/, `$1w=${width}`);
}

/** 分类显示名（跟随语言，未翻译的回退英文） */
const catLabel = (name) => i18n.categoryLabel(name, { titleCase });

/**
 * 按当前语言取项目简介。
 *
 * 后端同时返回 summary（英文原文）和 summaryZh（中文译文）。
 *
 * 三种情况：
 *   1. 有译文        → 中文界面用译文
 *   2. 没译文但原文已是中文（作者自己写的，含中日混排）→ 直接用原文
 *   3. 纯英文且没译文 → 只能用英文（约 0.3%，可接受）
 *
 * 第 2 条很关键：约 410 个项目作者本来就写了中文，
 * 如果死板地「中文界面必须有 summary_zh」，这些会退化成空白。
 */
const hasCjk = (s) => /[\u4e00-\u9fa5]/.test(s || '');

function descOf(card) {
  if (!card) return '';
  if (getLang() === 'zh') {
    if (card.summaryZh) return card.summaryZh;
    // 原文本身是中文就直接用，不要因为「没译文」而显示英文
    if (hasCjk(card.summary)) return card.summary;
    return card.summary || '';
  }
  return card.summary || '';
}

/** 按当前语言取项目正文 */
function bodyOf(card) {
  if (!card) return '';
  if (getLang() === 'zh') {
    if (card.descriptionZh) return card.descriptionZh;
    if (hasCjk(card.description)) return card.description;
    return card.description || '';
  }
  return card.description || '';
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

function haptic(ms = 12) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
}

/* ---------------- API ---------------- */

function queryString(filters, extra = {}) {
  const p = new URLSearchParams();
  const types = filters.types.length ? filters.types : [];
  if (types.length) p.set('types', types.join(','));
  if (filters.categories.length) p.set('categories', filters.categories.join(','));
  if (filters.loaders.length) p.set('loaders', filters.loaders.join(','));
  if (filters.versions.length) p.set('versions', filters.versions.join(','));
  p.set('requireImages', filters.requireImages ? '1' : '0');
  for (const [k, v] of Object.entries(extra)) if (v != null) p.set(k, v);
  return p.toString();
}

async function fetchFeed(limit = 30, { timeoutMs = 0 } = {}) {
  const qs = queryString(state.filters, {
    limit,
    cursor: state.nextCursor || undefined,
  });
  const opts = timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : undefined;
  try {
    const res = await fetch(`${API_ORIGIN}/api/feed?${qs}`, opts);
    if (!res.ok) throw new Error(`feed ${res.status}`);
    return await res.json();
  } catch (e) {
    // 跨源主机名在某些环境下不可达（例如只绑定了 127.0.0.1），退回同源
    if (timeoutMs) throw e;
    const res = await fetch(`${API}/api/feed?${qs}`);
    if (!res.ok) throw new Error(`feed ${res.status}`);
    return res.json();
  }
}

/**
 * 翻页游标的管理。
 *
 * 关键点（踩过坑）：后端每个 cursor 里带着一个 seed 和一个 offset。
 * 如果每次请求都不带 cursor，后端就会生成新 seed，从同一批高权重候选里重新采样，
 * 结果跨批次大量重复（实测 4 批 120 条里重复 34 条，28%）。
 *
 * 正确做法：首次请求拿一个 seed，后续翻页一直沿用同一个 cursor 链，
 * 保证 offset 单调递增、内容不重叠。只有「换筛选条件」或「主动刷新」时才换 seed。
 */
async function refill() {
  if (state.loading || state.exhausted) {
    return state.queue.length;
  }
  state.loading = true;
  // 记录本次请求属于哪个「代」。切换筛选时 epoch 会 +1，
  // 老请求回来的数据就不能再写进新队列（否则会把新条件的内容覆盖掉）。
  const epoch = state.epoch;
  try {
    let guard = 0;
    while (guard++ < 3) {
      const data = await fetchFeed(30);
      // 期间用户切了筛选条件：这份数据已经过时，直接丢弃
      if (epoch !== state.epoch) return state.queue.length;

      if (!data.items.length) {
        state.exhausted = true;
        break;
      }
      const existing = new Set(state.queue.map((c) => c.slug));
      const fresh = data.items.filter((c) => !existing.has(c.slug));
      state.queue.push(...fresh);
      state.nextCursor = data.nextCursor;
      if (!data.nextCursor) state.exhausted = true;

      const remaining = state.queue.length - state.cursor;
      if (remaining >= 8 || state.exhausted) break;
    }

    if (epoch !== state.epoch) return state.queue.length;

    if (!state.queue.length) {
      toast(t('toastNoResults'));
    } else {
      renderWindow();
    }
    return state.queue.length;
  } catch (e) {
    console.error('[refill]', e);
    if (epoch === state.epoch) toast(t('toastLoadFailed'));
    return state.queue.length;
  } finally {
    // 无论代次如何都要释放锁。
    // 早前写成「只有当前代次才复位」，结果切筛选后老请求回来不复位，
    // loading 永远卡在 true，后面所有 refill 全被挡掉（实测页面直接空白）。
    state.loading = false;
  }
}

async function loadTaxonomy() {
  try {
    const res = await fetch(`${API}/api/taxonomy`);
    state.taxonomy = await res.json();
  } catch (e) {
    console.warn('taxonomy 加载失败', e);
  }
}

/* ---------------- 卡片渲染 ---------------- */

function buildCard(card) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.key = card.slug;
  el.dataset.type = card.type;

  const backdrop = document.createElement('div');
  backdrop.className = 'card-backdrop';
  // 用项目自带主色做图片区底色，比纯黑自然；没有主色就保持默认深灰
  if (card.color != null) {
    const hex = '#' + (card.color >>> 0).toString(16).padStart(6, '0').slice(-6);
    el.style.setProperty('--card-tint', hex);
  }
  el.appendChild(backdrop);

  const veil = document.createElement('div');
  veil.className = 'card-veil';
  el.appendChild(veil);

  const media = document.createElement('div');
  media.className = 'card-media';

  // 不要在这里截断张数。
  // 早前写的 slice(0, 8) 是「只能切换前六张」的第二个成因：
  // 后端明明给了 24 张，前端渲染时又砍到 8 张。
  // 现在由 appendImagesToMedia 全量渲染，补图也走同一个函数。
  const images = card.images || [];
  if (!images.length) {
    // 没截图的卡片：显示图标 + 名称，避免整屏空白
    const ph = document.createElement('div');
    ph.className = 'card-placeholder';
    ph.innerHTML = `
      ${card.icon ? `<img src="${card.icon}" alt="" class="ph-icon" />` : ''}
      <span class="ph-text">${escapeHtml(card.title)}</span>
      <span class="ph-sub">No screenshots uploaded</span>`;
    media.appendChild(ph);
  } else {
    appendImagesToMedia(media, card, 0);
  }
  el.appendChild(media);
  bindGalleryScroll(media);

  const sheen = document.createElement('div');
  sheen.className = 'card-sheen';
  el.appendChild(sheen);

  return el;
}

/**
 * 往卡片里追加截图（首次渲染和后续补图都走这里）。
 * @param {HTMLElement} media .card-media 容器
 * @param {object} card 卡片数据
 * @param {number} from 从第几张开始（0 = 全部重建）
 */
function appendImagesToMedia(media, card, from = null) {
  const images = card.images || [];
  const start = from == null ? 0 : from;
  for (let i = start; i < images.length; i++) {
    const img = images[i];
    const im = document.createElement('img');
    // 两级加载：
    //   1. 首屏用 img.thumb —— 后端给的是 CDN 直连缩略图，几十 KB，快；
    //   2. 卡片停留 1.2 秒后升级到 img.full —— 走本地代理取原图并缩放，
    //      慢但清晰（原图动辄 1920×1080）。
    //
    // 为什么不能首屏就用高清：实测代理取原图平均 15 秒，
    // 45 张里 31 张超时，首屏直接空白。必须先给能看的再给好看的。
    im.dataset.src = img.thumb || img.url;
    im.dataset.full = img.full || img.url;
    im.alt = `${card.title} screenshot ${i + 1}`;
    // 不要在图片上用 loading="lazy"。
    //
    // 坑：卡片内图片是横向 grid 排布在 overflow-x 容器里，
    // 原生 lazy 会认为「横向屏外 = 不可见」，一直不发起请求。
    // 等用户按 → 滚过去才开始下载，而 CDN 单张要 1.3~3.4 秒，
    // 结果就是切一张、黑一下——这也是「截图切换不了」的直接成因之一。
    //
    // 加载时机交给 cardImgObserver（卡片级）和 loadCardImages 控制，
    // src 一旦赋上就立刻发起请求。
    im.decoding = 'async';
    // 图还没下载完时给个骨架色。
    // CDN 单张 1~3.4 秒（实测），切过去还没下完就是纯黑，
    // 用户会以为「切换失败」。给个带脉冲的底色，明确是在加载。
    im.classList.add('is-loading');
    im.addEventListener('load', () => {
      im.classList.remove('is-loading');
      if (!im.naturalWidth || !im.naturalHeight) return;
      im.classList.toggle('is-portrait', im.naturalWidth / im.naturalHeight < 1);
    });
    // 加载失败（CDN 偶发 500，实测约 1%）不能留一块空白：
    // 换成「无图」占位，至少说明这张图确实取不到。
    im.addEventListener('error', () => {
      im.classList.remove('is-loading');
      im.classList.add('is-broken');
    });
    // 后补的图不在首次观察范围内，直接赋 src（用户已经翻到这里了）
    if (from != null) {
      im.src = im.dataset.src;
      im.removeAttribute('data-src');
    }
    media.appendChild(im);
  }
}

/**
 * 卡片懒加载观察器 —— 观察**卡片**，不是单张图。
 *
 * 踩过的坑（这是「截图切换不了」的真正根因）：
 *   .card-media 是 overflow-x: auto 的横向容器，同一张卡片里
 *   第 2 张及以后的图被**祖先裁切**到视口外。IntersectionObserver
 *   计算相交时会算上祖先 overflow 的裁剪，所以这些图永远不会
 *   isIntersecting=true，src 永远是空的。
 *
 *   表现：按 → 滚动位置确实变了（scrollLeft 820），但切过去是白屏，
 *   因为那张图从来没被赋过 src。加 rootMargin 也没用——不是距离问题，是裁剪。
 *
 * 解法：观察卡片本身。卡片一进入视野，就把它的所有图一次性赋 src。
 * 每张卡片最多 6~8 张缩略图（每张 20~60KB），一次载入完全可接受。
 */
const cardImgObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const card = e.target;
      for (const img of card.querySelectorAll('img[data-src]')) {
        img.src = img.dataset.src;
        img.removeAttribute('data-src');
      }
      cardImgObserver.unobserve(card);
    }
  },
  // 垂直提前两屏，让滑到下一张卡时图已经在
  { root: $('feedTrack'), rootMargin: '120% 0px' },
);

/**
 * 兜底：立刻给某张卡片的全部图片赋 src。
 *
 * 用于「当前卡片」——用户随时可能按 → 切图，
 * 不能等 IntersectionObserver 慢慢回调。
 */
function loadCardImages(cardEl) {
  if (!cardEl) return;
  for (const img of cardEl.querySelectorAll('img[data-src]')) {
    img.src = img.dataset.src;
    img.removeAttribute('data-src');
  }
}

/**
 * 渐进加载 + 预取。
 *
 * 刷流慢的两个根因（都已实测）：
 *   1. 部分首图是 1~2MB 原图 → 已由后端 /api/img 代理缩到 ~10KB 解决
 *   2. 滑到下一张才开始下载 → 每次都要等
 * 这里做两件事：
 *   - 当前卡片停留 700ms 后升级到高清（划得快就不浪费带宽）
 *   - 提前预取「下一张 + 下下张」的首图缩略图，滑过去时已经在缓存里
 */
const preloaded = new Set();

function prefetchAhead() {
  // 只预取「下一张」。
  // 早前预取 3 张，滚动 20 次会发出 60+ 个图片请求，
  // 把浏览器每域 6 个连接占满，导致换筛选时的 /api/feed 请求排队几秒都发不出去（实测）。
  for (const d of [1]) {
    const card = state.queue[state.cursor + d];
    const src = card?.images?.[0]?.thumb;
    if (!src || preloaded.has(src)) continue;
    preloaded.add(src);
    const im = new Image();
    im.decoding = 'async';
    im.src = src;
  }
  // 集合无限增长会占内存，限制到最近 120 个
  if (preloaded.size > 120) {
    const keep = [...preloaded].slice(-80);
    preloaded.clear();
    for (const k of keep) preloaded.add(k);
  }
}

/** 当前卡停留足够久后，把主图换成高清版 */
async function upgradeCurrentCard() {
  const el = document.querySelector(`.card[data-index="${state.cursor}"]`);
  if (!el) return;
  const token = ++state.token;
  const target = [...el.querySelectorAll('img[data-full]')][0];
  if (!target) return;
  const full = target.dataset.full;
  if (!full) return;

  await new Promise((resolve) => {
    const pre = new Image();
    pre.decoding = 'async';
    const finish = () => resolve();
    pre.addEventListener(
      'load',
      () => {
        if (token === state.token && target.isConnected && target.dataset.full === full) {
          target.src = full;
          delete target.dataset.full;
        }
        finish();
      },
      { once: true },
    );
    pre.addEventListener('error', finish, { once: true });
    setTimeout(finish, 12_000);
    pre.src = full;
  });
}

/* ---------------- 渲染窗口 ---------------- */

function renderWindow() {
  const track = $('feedTrack');
  const spacer = track.querySelector('.feed-spacer');
  const total = state.queue.length;
  const from = Math.max(0, state.cursor - 2);
  const to = Math.min(total - 1, state.cursor + 2);

  spacer.style.height = `${Math.max(total, 1) * 100}dvh`;

  const wanted = new Set();
  for (let i = from; i <= to; i++) wanted.add(state.queue[i].slug);

  for (const el of track.querySelectorAll('.card')) {
    if (!wanted.has(el.dataset.key)) el.remove();
  }

  for (let i = from; i <= to; i++) {
    const card = state.queue[i];
    let el = track.querySelector(`.card[data-key="${CSS.escape(card.slug)}"]`);
    if (!el) {
      el = buildCard(card);
      track.appendChild(el);
    }
    el.dataset.index = String(i);
    el.style.setProperty('--idx', String(i));
  }

  for (const el of track.querySelectorAll('.card')) {
    cardImgObserver.observe(el);
  }

  // 当前卡片立即载入全部图片：用户随时可能按 → 切图，
  // 不能等 IntersectionObserver 回调（否则切过去是白屏）
  loadCardImages(track.querySelector(`.card[data-index="${state.cursor}"]`));
}

/* ---------------- 信息面板 ---------------- */

function currentCard() {
  return state.queue[state.cursor] || null;
}

function renderInfo(card) {
  if (!card) return;
  const info = $('info');
  info.style.animation = 'none';
  void info.offsetWidth;
  info.style.animation = '';

  const badges = $('infoBadges');
  badges.innerHTML = '';

  // 徽章去重：categories 里可能同时混入 datapack 这类「其实是 loader」的名字，
  // 而 extraChannels 也会加一次，不去重就会出现两个「Datapack」徽章（实测踩到）。
  const shown = new Set();
  const addOnce = (text, cls = '') => {
    const key = String(text).toLowerCase();
    if (!text || shown.has(key)) return;
    shown.add(key);
    const b = document.createElement('span');
    b.className = `badge ${cls}`;
    b.textContent = text;
    badges.appendChild(b);
  };

  addOnce(typeLabel(card.type), `type-${card.type}`);

  // 一个项目可能同时属于多个频道（mod + datapack），额外标注出来
  for (const ch of (card.channels || []).filter((c) => c !== card.type)) {
    addOnce(typeLabel(ch), `type-${ch}`);
  }

  if (card.downloads > 20_000_000) addOnce(t('popular'), 'hot');

  // 分类：跳过与频道同名的（datapack/plugin 这些本质是 loader）
  const channelNames = new Set([card.type, ...(card.channels || [])]);
  for (const c of (card.categories || []).slice(0, 3)) {
    if (channelNames.has(c)) continue;
    addOnce(catLabel(c));
  }

  for (const l of (card.loaders || []).slice(0, 1)) {
    if (channelNames.has(l)) continue;
    addOnce(titleCase(l));
  }

  $('infoTitle').textContent = card.title;
  $('infoDesc').textContent = descOf(card);

  // 显示「总数」而不是「已加载数」。
  // feed 只带前 24 张，但用户应该看到真实总数（实测最多 65 张）。
  const n = card.imageTotal || (card.images || []).length;
  $('imgCount').textContent = n > 1 ? String(n) : '';

  const dots = $('galleryDots');
  const thumbs = $('progressThumbs');
  dots.innerHTML = '';
  thumbs.innerHTML = '';
  if (n > 1) {
    // 圆点最多画 12 个：超过之后点太小、看不清，也没必要
    for (let i = 0; i < Math.min(n, 12); i++) {
      dots.appendChild(document.createElement('i'));
      thumbs.appendChild(document.createElement('i'));
    }
    dots.firstChild?.classList.add('on');
    thumbs.firstChild?.classList.add('on');
  }

  // 这个项目还有没取回来的截图（feed 只给前 24 张）→ 后台补齐
  if (card.imageTotal > (card.images || []).length) {
    ensureAllImages(card);
  }

  syncSavedUI();
}

/** 正在补图的项目 slug，避免滑动时重复发请求 */
const fillingImages = new Set();

/**
 * 把某个项目剩余的截图补回来。
 *
 * 为什么要分页：实测 15.9% 的项目超过 6 张、最多 65 张，
 * 一次全塞进 feed 会让 20 张卡的响应体翻好几倍、首屏明显变慢。
 * 所以 feed 只带前 24 张（覆盖 P99），剩下的等用户真的翻到再看。
 */
async function ensureAllImages(card) {
  if (!card || fillingImages.has(card.slug)) return;
  if ((card.images || []).length >= card.imageTotal) return;
  fillingImages.add(card.slug);
  try {
    const r = await fetch(`${API}/api/images/${encodeURIComponent(card.slug)}?from=0&limit=100`);
    if (!r.ok) return;
    const data = await r.json();
    if (!data.images?.length) return;

    // 记录已经渲染了多少张。补图时必须从这个下标开始追加，
    // 不能从头再追加一遍——那样 DOM 里会出现重复 img
    // （实测：56 张的卡片被追加成 80 个 img，只有 56 个唯一 src）。
    const el = document.querySelector(`.card[data-key="${CSS.escape(card.slug)}"]`);
    const media = el?.querySelector('.card-media');
    const rendered = media ? media.querySelectorAll('img').length : 0;

    card.images = data.images;
    card.imageTotal = data.total || data.images.length;

    // 只追加「还没渲染过」的部分
    if (media && card.images.length > rendered) {
      appendImagesToMedia(media, card, rendered);
    }

    if (state.queue[state.cursor] === card) {
      $('imgCount').textContent = card.imageTotal > 1 ? String(card.imageTotal) : '';
    }
  } catch {
    /* 补图失败就维持现状，用户仍能看前 24 张 */
  } finally {
    fillingImages.delete(card.slug);
  }
}

function updateGalleryIndicator(index) {
  const dots = $('galleryDots').children;
  const thumbs = $('progressThumbs').children;
  for (let i = 0; i < dots.length; i++) dots[i].classList.toggle('on', i === index);
  for (let i = 0; i < thumbs.length; i++) thumbs[i].classList.toggle('on', i === index);
}

function bindGalleryScroll(mediaEl) {
  let raf = null;
  // scroll 不冒泡，必须挂在 media 自己身上（挂在 feedTrack 上永远收不到）
  mediaEl.addEventListener(
    'scroll',
    () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const w = mediaEl.clientWidth || 1;
        updateGalleryIndicator(Math.round(mediaEl.scrollLeft / w));
      });
    },
    { passive: true },
  );
}

/* ---------------- 刷流 ---------------- */

function setupScroll() {
  const track = $('feedTrack');
  let raf = null;
  track.addEventListener(
    'scroll',
    () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const idx = Math.round(track.scrollTop / (track.clientHeight || 1));
        if (idx === state.cursor) return;
        onCardChange(idx);
      });
    },
    { passive: true },
  );
}

function onCardChange(idx) {
  // 重建期间（换筛选条件）忽略所有 scroll 事件
  if (state.rebuilding) return;
  // 队列为空或索引越界时直接忽略。
  // 换筛选条件时会先清空队列，此刻残留的 scroll 事件会带着旧索引进来，
  // 一旦继续往下走就会用空队列做 renderWindow，把新卡片全删掉（实测白屏根因）。
  if (!state.queue.length || idx < 0 || idx >= state.queue.length) return;
  if (state.upgradeTimer) {
    clearTimeout(state.upgradeTimer);
    state.upgradeTimer = null;
  }
  state.token++;
  state.cursor = idx;
  state.viewStart = Date.now();

  const card = currentCard();
  if (card) {
    renderInfo(card);
    renderDetailbar(card);
    const el = document.querySelector(`.card[data-index="${idx}"]`);
    if (el) {
      const media = el.querySelector('.card-media');
      if (media) media.scrollLeft = 0;
    }
    state.upgradeTimer = setTimeout(() => {
      if (state.cursor === idx) {
        upgradeCurrentCard();
        prefetchAhead();
      }
    }, 500);
    // 立刻预取后面的图，不等停留计时
    prefetchAhead();
  }

  renderWindow();

  // 快到底了提前补货
  if (state.queue.length - state.cursor < 5) refill();
}

/* ---------------- 收藏 ---------------- */

function syncSavedUI() {
  const saved = savedKeys();
  const card = currentCard();
  const btn = $('saveBtn');
  if (card) {
    const on = saved.has(card.slug);
    btn.classList.toggle('is-saved', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  const badge = $('savedBadge');
  badge.textContent = String(state.saved.length);
  badge.hidden = state.saved.length === 0;
  $('saveCount').textContent = String(state.saved.length);
  const sideCount = $('sideSavedCount');
  if (sideCount) sideCount.textContent = String(state.saved.length);
  const path = $('savedIconPath');
  path.setAttribute('fill', state.saved.length ? '#fbbf24' : 'none');
  path.setAttribute('stroke', state.saved.length ? '#fbbf24' : 'currentColor');
}

function toggleSave() {
  const card = currentCard();
  if (!card) return;
  const i = state.saved.findIndex((s) => s.slug === card.slug);
  const btn = $('saveBtn');

  if (i >= 0) {
    state.saved.splice(i, 1);
    btn.classList.remove('is-saved');
    toast(t('toastRemoved'));
  } else {
    state.saved.unshift({
      slug: card.slug,
      title: card.title,
      summary: descOf(card),
      image: card.images?.[0]?.thumb || card.images?.[0]?.url || card.icon || '',
      type: card.type,
      at: Date.now(),
    });
    btn.classList.add('is-saved');
    haptic(18);
    toast(t('toastSaved'));
    // 同步到服务端（为了将来跨设备；失败也不影响本地收藏）
    fetch(`${API}/api/favorites?device=${deviceId()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: card.id }),
    }).catch(() => {});
  }

  saveJson(LS.saved, state.saved);
  syncSavedUI();
  renderSaved();
}

function renderSaved() {
  const list = $('savedList');
  $('savedTotal').textContent = state.saved.length ? `· ${state.saved.length}` : '';
  if (!state.saved.length) {
    list.innerHTML = `<div class="empty">${escapeHtml(t('emptySaved'))}</div>`;
    return;
  }
  list.innerHTML = '';
  for (const item of state.saved) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.innerHTML = `
      <img class="tile-img" src="${item.image}" alt="" loading="lazy" />
      <div class="tile-body">
        <p class="tile-title">${escapeHtml(item.title)}</p>
        <p class="tile-desc">${escapeHtml(item.summary || '')}</p>
      </div>
      <button class="tile-remove" data-remove="${escapeHtml(item.slug)}" aria-label="Remove">×</button>`;
    tile.addEventListener('click', async (e) => {
      if (e.target.closest('[data-remove]')) return;
      openDetailBySlug(item.slug);
    });
    list.appendChild(tile);
  }
  list.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const slug = btn.dataset.remove;
      state.saved = state.saved.filter((s) => s.slug !== slug);
      saveJson(LS.saved, state.saved);
      renderSaved();
      syncSavedUI();
    });
  });
}

/* ---------------- 详情 ---------------- */

/** 详情一律从服务端按 slug 重新取，保证有完整截图与正文 */
const detailCache = new Map();
async function openDetailBySlug(slug) {
  try {
    if (!detailCache.has(slug)) {
      const res = await fetch(`${API}/api/project/${encodeURIComponent(slug)}`);
      if (!res.ok) throw new Error(res.status);
      detailCache.set(slug, await res.json());
    }
    openDetail(detailCache.get(slug));
  } catch (e) {
    console.error('detail failed', e);
    toast(t('toastDetailFailed'));
  }
}

function openDetail(card) {
  const imgs = card.images || [];
  const gallery = imgs
    .slice(0, 9)
    .map(
      (img, i) =>
        // 详情抽屉里是 3 列网格，每格约 130px 宽；按 2x 屏算要 260px，
        // 但考虑到用户会点开灯箱看大图，这里给 640 就够（点开时再换 1600）。
        `<img src="${pickVariant(img, 640)}" data-full="${pickVariant(img, 1600)}" alt="${escapeHtml(card.title)} #${i + 1}" loading="lazy" />`,
    )
    .join('');

  const links = [
    card.links?.page && `<a href="${card.links.page}" target="_blank" rel="noopener">Modrinth</a>`,
    card.links?.source && `<a href="${card.links.source}" target="_blank" rel="noopener">Source</a>`,
    card.links?.issues && `<a href="${card.links.issues}" target="_blank" rel="noopener">Issues</a>`,
    card.links?.wiki && `<a href="${card.links.wiki}" target="_blank" rel="noopener">Wiki</a>`,
    card.links?.discord && `<a href="${card.links.discord}" target="_blank" rel="noopener">Discord</a>`,
  ]
    .filter(Boolean)
    .join('');

  $('sheetBody').innerHTML = `
    <h2 class="sheet-title" id="sheetTitle">${escapeHtml(card.title)}</h2>
    <div class="sheet-sub">${escapeHtml(typeLabel(card.type))} · ${escapeHtml(card.slug)}</div>
    <p class="sheet-text">${escapeHtml(descOf(card))}</p>
    <div class="sheet-gallery">${gallery || `<span class="muted">${escapeHtml(t('noScreenshots'))}</span>`}</div>

    <div class="sheet-section">
      <h3>${escapeHtml(t('details'))}</h3>
      <div class="kv"><span>${escapeHtml(t('downloads'))}</span><span>${fmtNum(card.downloads)}</span></div>
      <div class="kv"><span>${escapeHtml(t('followers'))}</span><span>${fmtNum(card.follows)}</span></div>
      <div class="kv"><span>${escapeHtml(t('categories'))}</span><span>${escapeHtml((card.categories || []).map(catLabel).join(', ') || '—')}</span></div>
      <div class="kv"><span>${escapeHtml(t('loaders'))}</span><span>${escapeHtml((card.loaders || []).map((l) => i18n.categoryLabel(l, { titleCase })).join(', ') || '—')}</span></div>
      <div class="kv"><span>${escapeHtml(t('gameVersion'))}</span><span>${escapeHtml(
        t('gameVersionsCount', card.versions?.length || 0, (card.versions || []).slice(0, 3).join(', ')),
      )}</span></div>
      <div class="kv"><span>${escapeHtml(t('license'))}</span><span>${escapeHtml(card.license || '—')}</span></div>
      <div class="kv"><span>${escapeHtml(t('updated'))}</span><span>${card.updatedAt ? new Date(card.updatedAt).toLocaleDateString('en-CA') : '—'}</span></div>
    </div>

    ${
      card.versions?.length > 3
        ? `<div class="sheet-section">
             <h3>${escapeHtml(t('allGameVersions', card.versions.length))}</h3>
             <div class="version-list">${card.versions.map((v) => `<span class="ver-chip">${escapeHtml(v)}</span>`).join('')}</div>
           </div>`
        : ''
    }

    ${
      bodyOf(card)
        ? `<div class="sheet-section"><h3>${escapeHtml(t('about'))}</h3><p class="sheet-text">${escapeHtml(bodyOf(card))}</p></div>`
        : ''
    }

    <div class="sheet-section">
      <h3>${escapeHtml(t('links'))}</h3>
      <div class="sheet-links">${links || `<span class="muted">${escapeHtml(t('none'))}</span>`}</div>
    </div>`;

  $('sheetBody').querySelectorAll('.sheet-gallery img').forEach((img) => {
    img.addEventListener('click', () => {
      const urls = imgs.map((i) => i.url);
      openLightbox(urls, urls.indexOf(img.dataset.full));
    });
  });

  $('sheet').hidden = false;
}

function closeSheet() {
  $('sheet').hidden = true;
}

/* ---------------- 灯箱 ---------------- */

const lb = { urls: [], index: 0 };

function openLightbox(urls, index = 0) {
  if (!urls.length) return;
  lb.urls = urls;
  lb.index = Math.max(0, Math.min(index, urls.length - 1));
  $('lightbox').hidden = false;
  paintLightbox();
}
function paintLightbox() {
  $('lbImg').src = lb.urls[lb.index];
  $('lbCaption').textContent = `${lb.index + 1} / ${lb.urls.length}`;
  $('lbPrev').style.display = lb.urls.length > 1 ? '' : 'none';
  $('lbNext').style.display = lb.urls.length > 1 ? '' : 'none';
}
function closeLightbox() {
  $('lightbox').hidden = true;
  $('lbImg').src = '';
}
function stepLightbox(d) {
  if (!lb.urls.length) return;
  lb.index = (lb.index + d + lb.urls.length) % lb.urls.length;
  paintLightbox();
}

/* ---------------- 筛选面板 ---------------- */

const TYPE_ORDER = ['mod', 'modpack', 'datapack', 'resourcepack', 'shader', 'plugin', 'minecraft_java_server'];

// 服务端插件加载器：属于 Plugin 频道，不该混进 Mod 的加载器列表
const SERVER_ONLY_LOADERS = [
  'paper', 'spigot', 'bukkit', 'purpur', 'folia',
  'velocity', 'waterfall', 'bungeecord', 'sponge', 'geyser',
];

// 常用加载器排序：客户端玩家最常选的排前面
const POPULAR_LOADERS = ['fabric', 'neoforge', 'forge', 'quilt', 'datapack', 'iris', 'optifine'];

/**
 * 把正式版按大版本分组。
 *
 * 例：1.21.11 / 1.21.10 / ... / 1.21 → 一组「1.21」
 *     26.3 / 26.2 / 26.1.2 / 26.1 → 一组「26.x」（新命名规则）
 *     1.20.6 / 1.20.5 ... → 一组「1.20」
 *
 * 为什么不直接平铺 103 个 chip：一屏塞不下，找 1.19.2 要滚很久。
 * 分组后每个大版本一行，既能全部选到，又一眼能定位。
 */
function groupVersions(versions) {
  const map = new Map();
  for (const v of versions) {
    const ver = v.version;
    // 提取主版本：1.21.11 → 1.21；26.3 → 26；24w14a 之类不会有（已过滤正式版）
    const m = ver.match(/^(\d+)\.(\d+)/);
    let label;
    if (!m) label = 'Other';
    else if (Number(m[1]) >= 20) {
      // 新版命名（26.1）= 年.版本，用一个主号分组
      label = m[1];
    } else {
      // 经典命名 1.21.x → 主版本 1.21
      label = `${m[1]}.${m[2]}`;
    }
    if (!map.has(label)) map.set(label, []);
    map.get(label).push(v);
  }
  // 保持传入顺序（已按发布时间倒序），组内也保持
  return [...map.entries()].map(([label, items]) => ({ label, items }));
}

function renderFilterPanel() {
  const body = $('filterBody');
  if (!state.taxonomy) {
    body.innerHTML = `<div class="empty">Loading filters…</div>`;
    return;
  }
  const { categories, loaders, gameVersions } = state.taxonomy;
  const f = state.filters;

  // 分类按项目类型分组，只用当前选中类型（没选则 mod）
  const activeTypes = f.types.length ? f.types : ['mod'];
  const catsByType = {};
  for (const c of categories) {
    if (!activeTypes.includes(c.projectType)) continue;
    if (c.header === 'resolutions') continue; // 分辨率单独展示太吵，先略过
    (catsByType[c.projectType] ||= []).push(c);
  }

  // 游戏版本：全部 103 个正式版都要能选，不能截断。
  // 早前这里写死 slice(0,14)，用户只能选到最新的 14 个版本，
  // 1.21.2 / 1.21.1 / 1.21 这些都点不到（实测被指出）。
  // 现在按大版本分组展示，既完整又不会是一大坨。
  const allReleases = gameVersions.filter((v) => v.versionType === 'release');
  const groups = groupVersions(allReleases);

  const chips = (list, selected, attr) =>
    list
      .map(
        (item) =>
          `<button class="fchip ${selected.includes(item.value) ? 'on' : ''}" data-${attr}="${escapeHtml(item.value)}">${escapeHtml(item.label)}</button>`,
      )
      .join('');

  body.innerHTML = `
    <section class="fgroup">
      <h3>${escapeHtml(t('types'))}</h3>
      <div class="fchips">
        ${chips(
          TYPE_ORDER.map((t) => ({ value: t, label: typeLabel(t) })),
          f.types,
          'type',
        )}
      </div>
    </section>

    ${Object.entries(catsByType)
      .map(
        ([type, cats]) => `
      <section class="fgroup">
        <h3>${escapeHtml(t('categoriesOf', typeLabel(type)))}</h3>
        <div class="fchips">
          ${chips(
            cats.map((c) => ({ value: c.name, label: catLabel(c.name) })),
            f.categories,
            'cat',
          )}
        </div>
      </section>`,
      )
      .join('')}

    <section class="fgroup">
      <h3>${escapeHtml(t('loaders'))}</h3>
      <div class="fchips">
        ${chips(
          loaders
            .filter((l) => l.types.some((t) => activeTypes.includes(t)))
            // 服务端插件加载器（paper/spigot/bukkit…）和 datapack 也是 mod 类型的 loader，
            // 但它们属于别的频道，放在 Mod 的加载器里会让人困惑（实测被指出）。
            .filter((l) => !SERVER_ONLY_LOADERS.includes(l.name))
            .sort((a, b) => {
              // 客户端常用加载器排前面，冷门的（babric/nilloader）放后面
              const rank = (n) => {
                const i = POPULAR_LOADERS.indexOf(n);
                return i === -1 ? 99 : i;
              };
              return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);
            })
            .map((l) => ({ value: l.name, label: l.displayName })),
          f.loaders,
          'loader',
        )}
      </div>
    </section>

    <section class="fgroup">
      <h3>${escapeHtml(t('gameVersion'))} <span class="muted-sm">${escapeHtml(t('releasesMulti', allReleases.length))}</span></h3>
      ${groups
        .map(
          (g) => `
        <div class="ver-group">
          <div class="ver-group-label">${escapeHtml(g.label)}</div>
          <div class="fchips">
            ${chips(
              g.items.map((v) => ({ value: v.version, label: v.version })),
              f.versions,
              'ver',
            )}
          </div>
        </div>`,
        )
        .join('')}
    </section>

    <section class="fgroup">
      <h3>${escapeHtml(t('contentQuality'))}</h3>
      <div class="fchips">
        <button class="fchip ${f.requireImages ? 'on' : ''}" data-toggle-images="1">${escapeHtml(t('onlyWithImages'))}</button>
      </div>
    </section>`;

  body.querySelectorAll('[data-type]').forEach((b) =>
    b.addEventListener('click', () => toggleIn(f.types, b.dataset.type, renderFilterPanel)),
  );
  body.querySelectorAll('[data-cat]').forEach((b) =>
    b.addEventListener('click', () => toggleIn(f.categories, b.dataset.cat, renderFilterPanel)),
  );
  body.querySelectorAll('[data-loader]').forEach((b) =>
    b.addEventListener('click', () => toggleIn(f.loaders, b.dataset.loader, renderFilterPanel)),
  );
  body.querySelectorAll('[data-ver]').forEach((b) =>
    b.addEventListener('click', () => toggleIn(f.versions, b.dataset.ver, renderFilterPanel)),
  );
  body.querySelectorAll('[data-toggle-images]').forEach((b) =>
    b.addEventListener('click', () => {
      f.requireImages = !f.requireImages;
      renderFilterPanel();
    }),
  );

  const count = f.types.length + f.categories.length + f.loaders.length + f.versions.length;
  const badge = $('filterBadge');
  badge.textContent = String(count);
  badge.hidden = count === 0;
}

function toggleIn(arr, value, rerender) {
  const i = arr.indexOf(value);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(value);
  rerender();
}

function applyFilters() {
  saveJson(LS.filters, state.filters);
  $('filterPanel').hidden = true;
  resetFeed();
}

/**
 * 换筛选条件后重建内容流。
 *
 * 这里刻意**不再依赖 refill()**，而是自己完成「请求 → 填队列 → 渲染」。
 *
 * 为什么：refill 受 state.loading 这把锁保护，而滚动会把锁占住。
 * 切换筛选时若沿用 refill，就会撞上「锁被占 → 直接 return → 队列空 → 白屏」
 * 这条链路（实测反复出现，且不报任何错）。
 * 独立实现最直接：先把锁和状态全部重置，再自己 await 一次网络请求。
 */
async function resetFeed() {
  const track = $('feedTrack');

  // 上一次重建还没结束就被再次触发：只递增代次让老的那次自行放弃，
  // 不并发跑两个重建（会互相清 DOM，最后一张不剩）。
  if (state.rebuilding) {
    state.epoch++;
    return;
  }

  state.rebuilding = true;
  // 临时关掉 scroll-snap：snap 会把 scrollTo(0) 的结果立刻吸回最近的卡片位置，
  // 导致「归零失败 → 渲染窗口按旧位置算 → 卡片全被回收」的白屏链路（实测根因）。
  track.style.scrollSnapType = 'none';
  track.style.scrollBehavior = 'auto';

  state.epoch++;
  const myEpoch = state.epoch;
  state.loading = false;
  state.queue = [];
  state.cursor = 0;
  state.nextCursor = null;
  state.exhausted = false;
  state.viewStart = Date.now();

  track.scrollTo({ top: 0, behavior: 'instant' });
  // 清卡片前先把图 src 置空，让浏览器立刻取消这些在途的图片请求。
  // 否则：滚动 20 张会挂起几十个图片请求，占满浏览器每域 6 个连接，
  // 接下来换筛选要发的 /api/feed 就会排队几十秒都发不出去（实测卡死根因）。
  for (const im of track.querySelectorAll('img')) {
    im.removeAttribute('src');
    im.removeAttribute('srcset');
  }
  track.querySelectorAll('.card').forEach((el) => el.remove());

  document.getElementById('feed')?.classList.add('is-reloading');

  try {
    // 用独立 fetch 并带超时：即使连接池仍被占，也不会无限等下去
    const data = await fetchFeed(30, { timeoutMs: 12000 });
    if (myEpoch !== state.epoch) return;

    state.queue = data.items || [];
    state.nextCursor = data.nextCursor;
    state.exhausted = !data.nextCursor;

    if (!state.queue.length) {
      renderDetailbar(null);
      toast(t('toastNoResults'));
      return;
    }

    track.scrollTo({ top: 0, behavior: 'instant' });
    renderWindow();
    const first = state.queue[0];
    renderInfo(first);
    renderDetailbar(first);
    setTimeout(() => upgradeCurrentCard(), 900);
  } catch (e) {
    console.error('[resetFeed]', e);
    if (myEpoch === state.epoch) toast(t('toastLoadFailed'));
  } finally {
    document.getElementById('feed')?.classList.remove('is-reloading');
    if (myEpoch === state.epoch) {
      // 等两帧再恢复 snap 并解除标志：
      // 第一帧让 scrollTo(0) 触发的 scroll 事件在 rebuilding=true 时被丢弃，
      // 第二帧确保 snap 恢复后不会再被旧位置吸附。
      requestAnimationFrame(() => {
        track.style.scrollSnapType = '';
        track.style.scrollBehavior = '';
        requestAnimationFrame(() => {
          state.rebuilding = false;
        });
      });
    } else {
      state.rebuilding = false;
    }
  }
}

/* ---------------- 搜索 ---------------- */

let searchTimer;
async function doSearch(q) {
  const list = $('searchResults');
  const query = q.trim();
  if (!query) {
    list.innerHTML = `<div class="empty">${escapeHtml(t('toastSearchHint'))}</div>`;
    return;
  }
  list.innerHTML = `<div class="empty">${escapeHtml(t('toastSearching'))}</div>`;
  try {
    const res = await fetch(`${API}/api/search?q=${encodeURIComponent(query)}&limit=40`);
    const data = await res.json();
    if (!data.items?.length) {
      list.innerHTML = `<div class="empty">${escapeHtml(t('toastNoResultsFor', query))}</div>`;
      return;
    }
    list.innerHTML = '';
    for (const card of data.items) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      const img = card.images?.[0]?.thumb || card.icon || '';
      tile.innerHTML = `
        <img class="tile-img" src="${img}" alt="" loading="lazy" />
        <div class="tile-body">
          <p class="tile-title">${escapeHtml(card.title)}</p>
          <p class="tile-desc">${escapeHtml(descOf(card))}</p>
        </div>`;
      tile.addEventListener('click', async () => {
        openDetailBySlug(card.slug);
      });
      list.appendChild(tile);
    }
  } catch (e) {
    list.innerHTML = `<div class="empty">${escapeHtml(t('toastSearchFailed'))}</div>`;
  }
}

/* ---------------- 频道 chips ---------------- */

/**
 * 顶部频道条已移除（桌面用左侧栏、移动用筛选面板）。
 * 这里保留空实现，让所有调用点不用改——找不到元素就什么都不做。
 */
function renderChannelChips() {
  const wrap = $('channels');
  if (!wrap) return;
  const types = ['all', ...TYPE_ORDER];
  wrap.innerHTML = '';
  for (const t of types) {
    const b = document.createElement('button');
    b.className =
      'chip' +
      (state.filters.types.length === 0 && t === 'all' ? ' is-active' : '') +
      (state.filters.types.length === 1 && state.filters.types[0] === t ? ' is-active' : '');
    b.dataset.feed = t;
    b.role = 'tab';
    b.textContent = t === 'all' ? t('allProjects') : typeLabel(t);
    wrap.appendChild(b);
  }
}

/* ---------------- 桌面端：左侧分类栏 ---------------- */

/**
 * 左侧栏结构照抄 Modrinth 的浏览逻辑：
 *   项目类型 → 该类型的分类 → 加载器
 *
 * 点击类型 = 切频道，点击分类/加载器 = 叠加筛选。
 * 数据全部来自后端 taxonomy，不写死任何枚举。
 */
function renderSidebar() {
  const nav = $('sidebarNav');
  if (!nav || !state.taxonomy) return;

  const { categories, loaders } = state.taxonomy;
  const f = state.filters;
  const activeType = f.types.length === 1 ? f.types[0] : null;

  // 只看当前类型的分类（没选类型时用 mod，避免一上来就铺满 145 个）
  const typeForCats = activeType || 'mod';
  const cats = categories
    .filter((c) => c.projectType === typeForCats && c.header === 'categories')
    .sort((a, b) => a.name.localeCompare(b.name));

  const loadersForType = loaders
    .filter((l) => l.types.some((t) => t === typeForCats))
    .filter((l) => !SERVER_ONLY_LOADERS.includes(l.name) || typeForCats === 'plugin')
    .sort((a, b) => {
      const rank = (n) => {
        const i = POPULAR_LOADERS.indexOf(n);
        return i === -1 ? 99 : i;
      };
      return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);
    });

  const typeItems = [
    { value: 'all', label: t('allProjects') },
    ...TYPE_ORDER.map((ty) => ({ value: ty, label: typeLabel(ty) })),
  ];

  // 版本：桌面侧栏直接列出常用版本，按大版本分组。
  // 全部 103 个都在筛选面板里；侧栏只放最近 6 个大版本，
  // 否则左栏会长到需要滚很久才能看到 Loaders（实测体验很差）。
  const releases = (state.taxonomy.gameVersions || []).filter((v) => v.versionType === 'release');
  const verGroups = groupVersions(releases).slice(0, 6);

  nav.innerHTML = `
    <div class="side-group">
      <h3 class="side-group-title">${escapeHtml(t('browse'))}</h3>
      ${typeItems
        .map(
          (it) => `
        <button class="side-item ${(it.value === 'all' && !f.types.length) || f.types[0] === it.value ? 'is-active' : ''}"
                data-side-type="${it.value}">
          <span class="dot"></span>
          <span class="label">${escapeHtml(it.label)}</span>
        </button>`,
        )
        .join('')}
    </div>

    <div class="side-group">
      <h3 class="side-group-title">${escapeHtml(t('gameVersion'))}</h3>
      ${verGroups
        .map(
          (g) => `
        <div class="side-ver-label">${escapeHtml(g.label)}</div>
        <div class="side-ver-chips">
          ${g.items
            .map(
              (v) => `
            <button class="side-ver ${f.versions.includes(v.version) ? 'is-active' : ''}"
                    data-side-ver="${escapeHtml(v.version)}">${escapeHtml(v.version)}</button>`,
            )
            .join('')}
        </div>`,
        )
        .join('')}
      <button class="side-more" id="sideMoreVersions">${escapeHtml(t('allVersions', releases.length))}</button>
    </div>

    <div class="side-group">
      <h3 class="side-group-title">${escapeHtml(t('categoriesOf', typeLabel(typeForCats)))}</h3>
      ${cats
        .map(
          (c) => `
        <button class="side-item ${f.categories.includes(c.name) ? 'is-active' : ''}" data-side-cat="${escapeHtml(c.name)}">
          <span class="dot"></span>
          <span class="label">${escapeHtml(catLabel(c.name))}</span>
        </button>`,
        )
        .join('')}
    </div>

    <div class="side-group">
      <h3 class="side-group-title">${escapeHtml(t('loaders'))}</h3>
      ${loadersForType
        .map(
          (l) => `
        <button class="side-item ${f.loaders.includes(l.name) ? 'is-active' : ''}" data-side-loader="${escapeHtml(l.name)}">
          <span class="dot"></span>
          <span class="label">${escapeHtml(l.displayName)}</span>
        </button>`,
        )
        .join('')}
    </div>
  `;

  nav.querySelectorAll('[data-side-type]').forEach((b) =>
    b.addEventListener('click', () => {
      const t = b.dataset.sideType;
      state.filters.types = t === 'all' ? [] : [t];
      state.filters.categories = [];
      saveJson(LS.filters, state.filters);
      renderChannelChips();
      renderSidebar();
      resetFeed();
    }),
  );

  nav.querySelectorAll('[data-side-cat]').forEach((b) =>
    b.addEventListener('click', () => {
      const i = state.filters.categories.indexOf(b.dataset.sideCat);
      if (i >= 0) state.filters.categories.splice(i, 1);
      else state.filters.categories.push(b.dataset.sideCat);
      saveJson(LS.filters, state.filters);
      renderSidebar();
      renderFilterBadge();
      resetFeed();
    }),
  );

  nav.querySelectorAll('[data-side-loader]').forEach((b) =>
    b.addEventListener('click', () => {
      const i = state.filters.loaders.indexOf(b.dataset.sideLoader);
      if (i >= 0) state.filters.loaders.splice(i, 1);
      else state.filters.loaders.push(b.dataset.sideLoader);
      saveJson(LS.filters, state.filters);
      renderSidebar();
      renderFilterBadge();
      resetFeed();
    }),
  );

  // 侧栏版本：可多选
  nav.querySelectorAll('[data-side-ver]').forEach((b) =>
    b.addEventListener('click', () => {
      const v = b.dataset.sideVer;
      const i = state.filters.versions.indexOf(v);
      if (i >= 0) state.filters.versions.splice(i, 1);
      else state.filters.versions.push(v);
      saveJson(LS.filters, state.filters);
      renderSidebar();
      renderFilterBadge();
      resetFeed();
    }),
  );

  // 「全部版本」入口：打开筛选面板看完整 103 个
  nav.querySelector('#sideMoreVersions')?.addEventListener('click', () => {
    renderFilterPanel();
    $('filterPanel').hidden = false;
  });
}

function renderFilterBadge() {
  const f = state.filters;
  const count = f.types.length + f.categories.length + f.loaders.length + f.versions.length;
  const badge = $('filterBadge');
  if (badge) {
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }
}

/* ---------------- 桌面端：右侧详情栏 ---------------- */

/**
 * 右侧栏显示当前卡片的完整信息。
 *
 * 和手机端的底部信息卡不同：这里有空间，所以放全部截图、全部分类、
 * 全部游戏版本，不必截断。
 */
async function renderDetailbar(card) {
  const host = $('detailbarInner');
  if (!host) return;

  if (!card) {
    host.innerHTML = `<div class="db-empty">${escapeHtml(t('emptyScroll'))}</div>`;
    return;
  }

  // feed 返回的卡片没有 description，详情要单独拉（带缓存）
  let full = card;
  if (!card.description) {
    const cached = detailCache.get(card.slug);
    if (cached) {
      full = cached;
    } else {
      try {
        const res = await fetch(`${API}/api/project/${encodeURIComponent(card.slug)}`);
        if (res.ok) {
          full = await res.json();
          detailCache.set(card.slug, full);
        }
      } catch {}
    }
    // 用户可能已经划走，避免覆盖成旧内容
    if (currentCard()?.slug !== card.slug) return;
  }

  const badges = [];
  const shownBadges = new Set();
  const addBadgeHtml = (text, cls = '') => {
    const key = String(text).toLowerCase();
    if (!text || shownBadges.has(key)) return;
    shownBadges.add(key);
    badges.push(`<span class="badge ${cls}">${escapeHtml(text)}</span>`);
  };

  addBadgeHtml(typeLabel(card.type), `type-${card.type}`);
  for (const ch of (card.channels || []).filter((c) => c !== card.type)) {
    addBadgeHtml(typeLabel(ch), `type-${ch}`);
  }
  // 分类去重：datapack/plugin 等既是频道又是分类名，不能重复显示
  const channelNames = new Set([card.type, ...(card.channels || [])]);
  for (const c of (card.categories || []).slice(0, 5)) {
    if (channelNames.has(c)) continue;
    addBadgeHtml(catLabel(c));
  }

  const imgs = (full.images || []).slice(0, 9);
  const versionList = full.versions || card.versions || [];

  host.innerHTML = `
    <h2 class="db-title">${escapeHtml(card.title)}</h2>
    <p class="db-sub">${escapeHtml(card.slug)}</p>
    <div class="db-badges">${badges.join('')}</div>
    <p class="db-desc">${escapeHtml(descOf(card))}</p>

    ${
      imgs.length
        ? `<div class="db-gallery">${imgs
            .map(
              (im, i) =>
                // 右侧栏 3 列网格，每格约 120px 宽；2x 屏需要约 240px，
                // 给 640 有充足余量，肉眼不会再看到糊边。
                `<img src="${pickVariant(im, 640)}" data-idx="${i}" alt="${escapeHtml(card.title)} #${i + 1}" loading="lazy" />`,
            )
            .join('')}</div>`
        : ''
    }

    <div class="db-actions">
      <button class="primary-btn" id="dbOpen">${escapeHtml(t('viewOnModrinth'))}</button>
      <button class="ghost-btn" id="dbSave">${savedKeys().has(card.slug) ? escapeHtml(t('saved')) : escapeHtml(t('save'))}</button>
    </div>

    <div class="db-section">
      <h3>${escapeHtml(t('stats'))}</h3>
      <div class="db-kv"><span>${escapeHtml(t('downloads'))}</span><span>${fmtNum(card.downloads || 0)}</span></div>
      <div class="db-kv"><span>${escapeHtml(t('followers'))}</span><span>${fmtNum(card.follows || 0)}</span></div>
      <div class="db-kv"><span>${escapeHtml(t('loaders'))}</span><span>${escapeHtml((card.loaders || []).map((l) => i18n.categoryLabel(l, { titleCase })).join(', ') || '—')}</span></div>
      <div class="db-kv"><span>${escapeHtml(t('license'))}</span><span>${escapeHtml(card.license || '—')}</span></div>
      <div class="db-kv"><span>${escapeHtml(t('updated'))}</span><span>${card.updatedAt ? new Date(card.updatedAt).toLocaleDateString('en-CA') : '—'}</span></div>
    </div>

    ${
      versionList.length
        ? `<div class="db-section">
             <h3>${escapeHtml(t('gameVersionsHeading', versionList.length))}</h3>
             <div class="db-versions">${versionList.map((v) => `<span class="ver-chip">${escapeHtml(v)}</span>`).join('')}</div>
           </div>`
        : ''
    }

    ${
      bodyOf(full)
        ? `<div class="db-section"><h3>${escapeHtml(t('about'))}</h3><p class="db-desc">${escapeHtml(bodyOf(full).slice(0, 700))}</p></div>`
        : ''
    }
  `;

  host.querySelector('#dbOpen')?.addEventListener('click', () => {
    if (card.links?.page) window.open(card.links.page, '_blank', 'noopener');
  });
  host.querySelector('#dbSave')?.addEventListener('click', () => {
    toggleSave();
    renderDetailbar(card);
  });
  host.querySelectorAll('.db-gallery img').forEach((im) => {
    im.addEventListener('click', () => {
      openLightbox(imgs.map((x) => pickVariant(x, 1600)), Number(im.dataset.idx));
    });
  });
}

/* ---------------- 语言切换 ---------------- */

const LS_LANG = 'mcscroll.lang.v1';

/** 把 HTML 里带 data-i18n 的静态文案替换成当前语言 */
function applyStaticI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    const v = t(key);
    if (typeof v === 'string') el.textContent = v;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  });
  document.documentElement.lang = getLang() === 'zh' ? 'zh-CN' : 'en';
}

/** 切换语言：更新所有动态区域，不需要刷新页面 */
function applyLang(code) {
  setLang(code);
  saveJson(LS_LANG, code);

  const meta = i18n.LANGS.find((l) => l.code === getLang());
  const lbl = $('langLabel');
  const sh = $('langShort');
  if (lbl) lbl.textContent = meta?.label || 'English';
  if (sh) sh.textContent = meta?.short || 'EN';
  const langBtn = $('langBtn');
  if (langBtn) {
    langBtn.title = t('language');
    langBtn.setAttribute('aria-label', t('language'));
  }
  const sl = $('sideSavedLabel');
  if (sl) sl.textContent = t('saved');

  applyStaticI18n();

  // 动态区域全部重绘
  renderSidebar();
  renderChannelChips();
  renderFilterPanel();
  renderFilterBadge();
  renderSaved();
  renderKeysPanel(); // 快捷键面板的文案也要跟着语言变
  const cur = currentCard();
  if (cur) {
    renderInfo(cur);
    renderDetailbar(cur);
  }
  // 折叠按钮的 tooltip 也要更新
  const dt = $('detailbarToggle');
  if (dt) {
    const collapsed = document.querySelector('.layout')?.classList.contains('db-collapsed');
    dt.title = collapsed ? t('expandDetail') : t('collapseDetail');
  }
}

function initLang() {
  let code = loadJson(LS_LANG, null);
  if (!code) {
    // 首次访问按浏览器语言猜：以中文为主的用户直接给中文
    const nav = (navigator.language || 'en').toLowerCase();
    code = nav.startsWith('zh') ? 'zh' : 'en';
  }
  applyLang(code);

  $('langBtn')?.addEventListener('click', () => {
    // 只有两种语言，直接来回切。
    // 注意：这里**不能**调 resetFeed()。
    // 早前切语言会重新拉一页内容，用户正在看的项目直接消失
    // （实测 Speed Moon 切个语言变成了 WeirdChat），这是明显的体验缺陷。
    // 语言只影响文案，队列里的项目保持不变，重绘即可。
    applyLang(getLang() === 'zh' ? 'en' : 'zh');
  });
}

/* ---------------- 事件 ---------------- */

function setupEvents() {
  $('saveBtn').addEventListener('click', toggleSave);

  $('openBtn').addEventListener('click', () => {
    const c = currentCard();
    if (c?.links?.page) window.open(c.links.page, '_blank', 'noopener');
  });
  $('linkBtn').addEventListener('click', () => {
    const c = currentCard();
    if (c?.links?.page) window.open(c.links.page, '_blank', 'noopener');
  });
  $('copyBtn').addEventListener('click', async () => {
    const c = currentCard();
    if (!c?.links?.page) return;
    try {
      await navigator.clipboard.writeText(c.links.page);
      toast(t('toastLinkCopied'));
    } catch {
      toast(t('toastCopyFailed'));
    }
  });
  $('detailBtn').addEventListener('click', async () => {
    const c = currentCard();
    if (!c) return;
    // feed 接口为了省流量不返回 images/description，详情必须单独拉一次，
    // 否则抽屉里会没有截图（实测踩过：Sodium 有 6 张图却显示 0 张）。
    await openDetailBySlug(c.slug);
  });
  $('galleryBtn').addEventListener('click', () => {
    const c = currentCard();
    if (!c) return;
    openLightbox((c.images || []).map((i) => pickVariant(i, 1600)), 0);
  });

  // 顶部频道条已移除。保留这段兼容逻辑（找不到元素就跳过），
  // 万一以后又把 chips 加回来也能直接用。
  $('channels')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-feed]');
    if (!btn) return;
    const t = btn.dataset.feed;
    state.filters.types = t === 'all' ? [] : [t];
    state.filters.categories = [];
    saveJson(LS.filters, state.filters);
    renderChannelChips();
    renderSidebar();
    resetFeed();
  });

  $('filterBtn').addEventListener('click', () => {
    renderFilterPanel();
    $('filterPanel').hidden = false;
  });
  $('filterBack').addEventListener('click', () => ($('filterPanel').hidden = true));
  $('filterReset').addEventListener('click', () => {
    state.filters = { types: [], categories: [], loaders: [], versions: [], requireImages: true };
    renderFilterPanel();
    renderChannelChips();
  });
  $('filterApply').addEventListener('click', applyFilters);

  // 桌面端左侧栏的 logo 也可点开收藏
  $('brandBtn')?.addEventListener('click', () => {
    renderSaved();
    $('savedPanel').hidden = false;
  });
  $('savedBtn').addEventListener('click', () => {
    renderSaved();
    $('savedPanel').hidden = false;
  });
  $('sideSavedBtn')?.addEventListener('click', () => {
    renderSaved();
    $('savedPanel').hidden = false;
  });
  $('brandBtnMobile')?.addEventListener('click', () => {
    renderSaved();
    $('savedPanel').hidden = false;
  });
  $('savedBack').addEventListener('click', () => ($('savedPanel').hidden = true));
  $('savedClear').addEventListener('click', () => {
    if (!state.saved.length) return;
    if (!confirm(t('confirmClear'))) return;
    state.saved = [];
    saveJson(LS.saved, state.saved);
    renderSaved();
    syncSavedUI();
    toast(t('toastCleared'));
  });

  $('searchBtn').addEventListener('click', () => {
    $('searchPanel').hidden = false;
    doSearch('');
    setTimeout(() => $('searchInput').focus(), 120);
  });
  $('searchBack').addEventListener('click', () => {
    $('searchPanel').hidden = true;
    $('searchInput').value = '';
  });
  $('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => doSearch(v), 200);
  });

  $('sheet').addEventListener('click', (e) => {
    if (e.target.closest('[data-close-sheet]')) closeSheet();
  });
  $('lbClose').addEventListener('click', closeLightbox);
  $('lbPrev').addEventListener('click', () => stepLightbox(-1));
  $('lbNext').addEventListener('click', () => stepLightbox(1));
  $('lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') closeLightbox();
  });

  /* ---- 快捷键面板 ---- */
  renderKeysPanel();
  $('keysBtn').addEventListener('click', () => {
    const open = !$('keysPop').hidden;
    if (open) closeKeys();
    else openKeys();
  });
  $('keysClose').addEventListener('click', closeKeys);
  // 点面板外面顺手关掉：面板是浮层，不关会一直挡着右侧内容
  document.addEventListener('pointerdown', (e) => {
    if ($('keysPop').hidden) return;
    if (e.target.closest('#keysPop, #keysBtn')) return;
    closeKeys();
  });

  /* ---- 右侧详情栏折叠 ---- */
  $('detailbarToggle').addEventListener('click', toggleDetailbar);

  window.addEventListener('keydown', onKeyDown);
}

/* ---------------- 键盘操作 ---------------- */

/**
 * 全部键位定义。
 *
 * 这里的 code 字段同时支持三种写法：
 *   - e.key  普通字符 / 方向键（'j'、'ArrowDown'）
 *   - e.code 物理位置（'Numpad2'），小键盘必须靠它
 *
 * 小键盘的坑：NumLock 打开时按小键盘方向键，e.key 是 '2''4''6''8' 而不是
 * 'ArrowDown'，所以只判断 e.key 时，小键盘方向键换图完全没反应。
 * 必须补 e.code === 'Numpad2' 这类判断。
 */
/**
 * 默认键位表。
 *
 * 这是「出厂设置」，用户改过的存在 localStorage，启动时覆盖上去。
 * 面板内容由它生成，改一处两边同步。
 *
 * 关于 shift 字段：
 *   有些键靠 shift 区分（'/' 和 '?'）——不写 shift 会互相误触。
 *   所以带 shift 语义的绑定必须显式声明 shift: true/false，
 *   不声明（undefined）表示「不管 shift 都算命中」。
 *
 * 关于 code 字段：
 *   小键盘必须靠 e.code 判断。NumLock 开启时按小键盘方向键，
 *   e.key 是 '2' '8' '4' '6' 而不是 'ArrowDown'，只看 e.key 完全没反应。
 */
const DEFAULT_KEYMAP = [
  { group: 'feed', label: 'nextCard', keys: ['ArrowDown', 'j'], code: ['Numpad2'] },
  { group: 'feed', label: 'prevCard', keys: ['ArrowUp', 'k'], code: ['Numpad8'] },
  { group: 'image', label: 'nextImage', keys: ['ArrowRight', 'l'], code: ['Numpad6'] },
  { group: 'image', label: 'prevImage', keys: ['ArrowLeft', 'h'], code: ['Numpad4'] },
  { group: 'detail', label: 'detailDown', keys: ['d'], code: ['Numpad3'] },
  { group: 'detail', label: 'detailUp', keys: ['u'], code: ['Numpad9'] },
  { group: 'detail', label: 'toggleDetail', keys: ['\\'], code: [] },
  { group: 'action', label: 'save', keys: ['s'], code: [] },
  { group: 'action', label: 'openPage', keys: ['o'], code: [] },
  { group: 'action', label: 'openDetail', keys: ['Enter'], code: ['NumpadEnter'] },
  { group: 'action', label: 'openFilters', keys: ['f'], code: [] },
  { group: 'action', label: 'openSearch', keys: ['/'], code: [], shift: false },
  { group: 'action', label: 'openSaved', keys: ['b'], code: [] },
  { group: 'action', label: 'showShortcuts', keys: ['?'], code: [], shift: true },
  { group: 'action', label: 'closeLayer', keys: ['Esc'], code: [] },
];

/** 深拷贝默认表，避免用户改动污染常量的数组 */
function cloneDefaultKeymap() {
  return DEFAULT_KEYMAP.map((d) => ({
    ...d,
    keys: [...d.keys],
    code: [...(d.code || [])],
  }));
}

/**
 * 当前生效的键位表。
 * 启动时用 localStorage 里用户改过的覆盖默认值。
 */
let KEYMAP = cloneDefaultKeymap();

/** 读出用户自定义键位并合并到默认表 */
function loadKeymap() {
  const saved = loadJson(LS.keymap, null);
  KEYMAP = cloneDefaultKeymap();
  if (!saved || typeof saved !== 'object') return;
  for (const def of KEYMAP) {
    const o = saved[def.label];
    if (!o) continue;
    if (Array.isArray(o.keys)) def.keys = [...o.keys];
    if (Array.isArray(o.code)) def.code = [...o.code];
    if (o.shift === true || o.shift === false) def.shift = o.shift;
    else delete def.shift;
  }
}

/** 把当前键位表存进 localStorage */
function saveKeymap() {
  const out = {};
  for (const d of KEYMAP) {
    out[d.label] = { keys: d.keys, code: d.code };
    if (d.shift !== undefined) out[d.label].shift = d.shift;
  }
  saveJson(LS.keymap, out);
}

/** 恢复出厂键位 */
function resetKeymap() {
  KEYMAP = cloneDefaultKeymap();
  try {
    localStorage.removeItem(LS.keymap);
  } catch {}
  state.rebind = null;
  renderKeysPanel();
  toast(t('keysReset'));
}

/** 判断这次按键是否命中某个键位定义 */
function matchKey(def, e) {
  // 声明了 shift 的绑定要严格匹配 shift 状态，否则 '/' 和 '?' 会互相误触
  if (def.shift !== undefined && !!e.shiftKey !== !!def.shift) return false;
  if (e.code && def.code && def.code.includes(e.code)) return true;
  const k = e.key;
  if (!k) return false;
  if (def.keys.includes(k)) return true;
  // 大写字母也要能匹配 's' 这种小写绑定
  if (k.length === 1 && def.keys.includes(k.toLowerCase())) return true;
  return false;
}

/** 按当前 cursor 找到卡片里的图片横滑容器 */
function currentMedia() {
  return document.querySelector(`.card[data-index="${state.cursor}"] .card-media`);
}

/**
 * 切换图片。
 *
 * 为什么用 scrollTo 而不是 scrollLeft += w：
 * .card-media 是 scroll-snap-type: x mandatory + scroll-snap-stop: always，
 * 直接改 scrollLeft 偶尔会被吸附回原位（尤其是快速连按）。
 * 用整数倍索引一次跳到位最稳。
 */
function stepImage(dir) {
  const m = currentMedia();
  if (!m) return false;
  const w = m.clientWidth || 1;
  const total = m.children.length;
  const cur = Math.round(m.scrollLeft / w);
  const next = Math.min(Math.max(cur + dir, 0), Math.max(total - 1, 0));
  m.scrollTo({ left: next * w, behavior: 'instant' });
  updateGalleryIndicator(next);
  return true;
}

/** 上下滑一整屏（换内容） */
function stepCard(dir) {
  const track = $('feedTrack');
  const h = track.clientHeight || 1;
  const cur = Math.round(track.scrollTop / h);
  const next = Math.max(0, cur + dir);
  track.scrollTo({ top: next * h, behavior: 'instant' });
  return true;
}

/** 右侧详情栏上下滚动 */
function scrollDetail(dir) {
  const el = $('detailbarInner');
  if (!el) return false;
  if (document.querySelector('.layout').classList.contains('db-collapsed')) {
    // 折叠状态下滚不到，提示用户先展开
    toast(t('detailCollapsed'));
    return false;
  }
  const viewport = $('detailbar');
  // detailbar-inner 本身不滚，滚的是外层 aside
  const target = viewport.scrollHeight > viewport.clientHeight ? viewport : el;
  const step = Math.round((viewport.clientHeight || 400) * 0.82);
  target.scrollBy({ top: dir * step, behavior: 'smooth' });
  return true;
}

/** 折叠 / 展开右侧详情栏 */
function toggleDetailbar() {
  const layout = document.querySelector('.layout');
  const collapsed = layout.classList.toggle('db-collapsed');
  $('detailbarToggle').setAttribute('aria-expanded', String(!collapsed));
  $('detailbarToggle').title = collapsed ? t('expandDetail') : t('collapseDetail');
  saveJson(LS.detailCollapsed, collapsed);
  // 中间列变宽/变窄后，卡片宽度改变，图片需要重新按新宽度选
  requestAnimationFrame(() => {
    const cur = currentCard();
    if (cur) upgradeCurrentCard();
  });
}

function openKeys() {
  $('keysPop').hidden = false;
  $('keysBtn').setAttribute('aria-expanded', 'true');
}
function closeKeys() {
  $('keysPop').hidden = true;
  $('keysBtn').setAttribute('aria-expanded', 'false');
  // 关面板时退出录制态，否则下次按任意键都会被当成绑定
  if (state.rebind) {
    state.rebind = null;
    renderKeysPanel();
  }
}

/** 渲染快捷键面板内容（跟随语言） */
function renderKeysPanel() {
  const body = $('keysBody');
  if (!body) return;
  const groups = {
    feed: t('keysFeed'),
    image: t('keysImage'),
    detail: t('keysDetail'),
    action: t('keysAction'),
  };
  let html = '';
  for (const [g, title] of Object.entries(groups)) {
    const rows = KEYMAP.filter((d) => d.group === g);
    if (!rows.length) continue;
    html += `<div class="keys-group"><div class="keys-group-title">${escapeHtml(title)}</div>`;
    for (const d of rows) {
      const isRecording = state.rebind === d.label;
      // 每个键位都可点击 → 进入录制态 → 按新键即绑定。
      // 冲突的绑定会在这里显示成警告色（见 conflictOf）
      const conflict = conflictOf(d.label);
      const combos = d.keys.map((k) => keyLabel(k));
      html += `<div class="keys-row ${isRecording ? 'is-recording' : ''}" data-rebind="${escapeHtml(d.label)}">
        <span class="keys-label">${escapeHtml(t(d.label))}${
          conflict ? ` <span class="keys-warn">${escapeHtml(t('keysConflict'))}</span>` : ''
        }</span>
        <span class="keys-combo">${
          isRecording
            ? `<span class="keys-rec">${escapeHtml(t('keysPress'))}</span>`
            : combos.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('')
        }</span>
      </div>`;
    }
    html += '</div>';
  }
  html += `<div class="keys-foot">
    <button class="text-btn" id="keysResetBtn">${escapeHtml(t('keysResetAll'))}</button>
    <span class="keys-hint">${escapeHtml(t('keysNumpadHint'))}</span>
  </div>`;
  body.innerHTML = html;

  // 点击某一行进入录制
  body.querySelectorAll('[data-rebind]').forEach((row) => {
    row.addEventListener('click', () => {
      const label = row.dataset.rebind;
      state.rebind = state.rebind === label ? null : label;
      renderKeysPanel();
    });
  });
  body.querySelector('#keysResetBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    resetKeymap();
  });
}

/**
 * 找出与当前绑定冲突的其他动作。
 *
 * 冲突指「同一个键绑给了两个动作」——那种情况下先命中的那个赢，
 * 另一个永远触发不了，用户很难自己发现，必须显式提示。
 */
function conflictOf(label) {
  const me = KEYMAP.find((d) => d.label === label);
  if (!me) return false;
  for (const other of KEYMAP) {
    if (other.label === label) continue;
    // shift 语义不同不算冲突（'/' 和 '?'）
    if ((me.shift === undefined) !== (other.shift === undefined)) continue;
    if (!!me.shift !== !!other.shift) continue;
    for (const k of me.keys) {
      if (other.keys.includes(k)) return true;
    }
    for (const c of me.code || []) {
      if ((other.code || []).includes(c)) return true;
    }
  }
  return false;
}

/**
 * 把一次按键事件转成绑定值。
 *
 * 返回 { keys, code, shift }：keys 存 e.key（字符语义），
 * code 存 e.code（物理位置，小键盘靠它）。
 *
 * 特殊处理：
 *   - 纯修饰键（Shift/Ctrl/Alt/Meta）不能单独绑定，返回 null
 *   - 小键盘按键同时记住 code，否则 NumLock 开关时行为会变
 */
function eventToBinding(e) {
  const k = e.key;
  if (!k) return null;
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead'].includes(k)) return null;
  // 小键盘（NumpadX）记 code，正常情况下 E.key 也是可用字符
  const isNumpad = typeof e.code === 'string' && e.code.startsWith('Numpad');
  const bind = {
    keys: [k.length === 1 ? k.toLowerCase() : k],
    code: isNumpad ? [e.code] : [],
  };
  // shift 只在有实际字符区分时记录（'?' 这种）
  if (e.shiftKey && k.length === 1) bind.shift = true;
  else if (!e.shiftKey && (k === '/' || k === '?')) bind.shift = false;
  return bind;
}

/** 应用一次录制结果 */
function applyRebind(label, binding) {
  const def = KEYMAP.find((d) => d.label === label);
  if (!def) return;
  // 从其他动作里摘掉同一个键，避免立刻产生冲突
  for (const other of KEYMAP) {
    if (other.label === label) continue;
    other.keys = other.keys.filter((k) => !binding.keys.includes(k));
    other.code = (other.code || []).filter((c) => !(binding.code || []).includes(c));
  }
  def.keys = binding.keys;
  def.code = binding.code || [];
  if (binding.shift !== undefined) def.shift = binding.shift;
  else delete def.shift;

  saveKeymap();
  state.rebind = null;
  renderKeysPanel();
  toast(t('keysSaved', keyLabel(binding.keys[0])));
}

function keyLabel(k) {
  const map = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Enter: 'Enter',
    Esc: 'Esc',
    Escape: 'Esc',
    ' ': 'Space',
    '\\': '\\',
  };
  return map[k] || k;
}

function onKeyDown(e) {
  // 录制新键位时，抢先吞掉这次按键。
  // 必须放在最前面：否则按 's' 想绑收藏，结果先触发了真正的收藏动作。
  if (state.rebind) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      state.rebind = null;
      renderKeysPanel();
      return;
    }
    const binding = eventToBinding(e);
    if (!binding) return; // 纯修饰键，继续等
    return applyRebind(state.rebind, binding);
  }

  // 输入框里不抢键。
  // 注意用可选链：事件目标是 window/document 时没有 .matches()，
  // 直接调会抛 TypeError，整个按键处理器就静默失效了（实测踩到）。
  if (e.target?.matches?.('input, textarea, [contenteditable="true"]')) return;

  // 灯箱打开时只处理翻页和关闭，避免误触换卡
  if (!$('lightbox').hidden) {
    if (matchKey({ keys: ['Escape'] }, e)) return closeLightbox();
    if (matchKey({ keys: ['ArrowRight'], code: ['Numpad6'] }, e)) {
      e.preventDefault();
      return stepLightbox(1);
    }
    if (matchKey({ keys: ['ArrowLeft'], code: ['Numpad4'] }, e)) {
      e.preventDefault();
      return stepLightbox(-1);
    }
    return;
  }

  // 有浮层打开时，Esc 优先关浮层
  if (matchKey({ keys: ['Escape'] }, e)) {
    for (const id of ['keysPop', 'sheet', 'filterPanel', 'savedPanel', 'searchPanel']) {
      const el = $(id);
      if (el && !el.hidden) {
        if (id === 'keysPop') closeKeys();
        else if (id === 'sheet') closeSheet();
        else el.hidden = true;
        e.preventDefault();
        return;
      }
    }
    return;
  }

  for (const def of KEYMAP) {
    if (!matchKey(def, e)) continue;
    // '?' 需要判断 shift，单独处理避免和 '/' 冲突
    if (def.label === 'showShortcuts') {
      if (e.key !== '?' && !(e.shiftKey && e.key === '/')) continue;
    }
    if (def.label === 'openSearch' && e.shiftKey) continue;

    e.preventDefault();
    switch (def.label) {
      case 'nextCard': return stepCard(1);
      case 'prevCard': return stepCard(-1);
      case 'nextImage': return stepImage(1);
      case 'prevImage': return stepImage(-1);
      case 'detailDown': return scrollDetail(1);
      case 'detailUp': return scrollDetail(-1);
      case 'toggleDetail': return toggleDetailbar();
      case 'save': return toggleSave();
      case 'openPage': {
        const c = currentCard();
        if (c?.links?.page) window.open(c.links.page, '_blank', 'noopener');
        return;
      }
      case 'openDetail': {
        const c = currentCard();
        // 和右上角「详情」按钮走同一条路径：详情要单独拉一次才有截图
        if (c) openDetailBySlug(c.slug);
        return;
      }
      case 'openFilters': {
        $('filterPanel').hidden = false;
        renderFilterPanel();
        return;
      }
      case 'openSearch': {
        $('searchPanel').hidden = false;
        doSearch('');
        return setTimeout(() => $('searchInput').focus(), 120);
      }
      case 'openSaved': {
        $('savedPanel').hidden = false;
        renderSaved();
        return;
      }
      case 'showShortcuts': return $('keysPop').hidden ? openKeys() : closeKeys();
      default: return;
    }
  }
}

/* ---------------- 启动 ---------------- */

async function boot() {
  try {
    const health = await fetch(`${API}/api/health`).then((r) => r.json());
    if (!health.projects) {
      $('fatal').hidden = false;
      $('fatalMsg').textContent = t('fatalEmpty');
      return;
    }
    console.log(
      `[MC Scroll] DB: ${health.projects} projects, ${health.images} images, ${health.categories} categories`,
    );
  } catch {
    $('fatal').hidden = false;
    $('fatalMsg').textContent = t('fatalNoApi');
    return;
  }

  // 先定语言，后面的渲染才知道该用哪套文案
  initLang();

  // 读用户自定义键位（必须在任何按键处理之前）
  loadKeymap();

  // 恢复上次的详情栏折叠状态（桌面端才有意义，但读一下无害）
  if (loadJson(LS.detailCollapsed, false)) {
    document.querySelector('.layout').classList.add('db-collapsed');
    $('detailbarToggle').setAttribute('aria-expanded', 'false');
    $('detailbarToggle').title = t('expandDetail');
  } else {
    $('detailbarToggle').title = t('collapseDetail');
  }

  renderChannelChips();
  await loadTaxonomy();
  renderSidebar();
  setupScroll();
  setupEvents();
  renderSaved();
  syncSavedUI();

  await refill();
  const first = state.queue[0];
  if (first) {
    renderInfo(first);
    renderDetailbar(first);
    setTimeout(() => upgradeCurrentCard(), 900);
  }

  setTimeout(() => $('bootSkeleton').classList.add('hide'), 200);
  setTimeout(() => $('bootSkeleton').remove(), 700);
}

boot();
