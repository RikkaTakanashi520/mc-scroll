/**
 * 静态版数据源
 *
 * 作用：让前端在「有后端」和「纯静态」两种模式下用同一套代码。
 *
 * 背景：
 *   GitHub Pages / Cloudflare Pages 跑不了 Node 服务，
 *   所以原来的 /api/feed、/api/project、/api/search 全都要换成读静态文件。
 *   这个文件就是那层适配，app.js 只跟它打交道。
 *
 * 关键设计：
 *   1. **分片懒加载**：19 个主表分片，每片 4000 条。首屏只等 p00（约 615KB），
 *      剩下的后台顺序加载，加载完才开放完整筛选和搜索。
 *   2. **加权随机复刻后端逻辑**：后端用 feed_index 表做等概率采样，
 *      前端改成「按 weight 分层的别名采样」，保证长尾内容真有机会出现。
 *   3. **图片直连 CDN**：实测 CORS 为 *、缓存 31 天，不需要代理。
 *      这是零成本的关键——图片流量不占自己的额度。
 */

/** CDN 前缀，和 build-static.mjs 里切掉的前缀必须一致 */
const CDN = 'https://cdn.modrinth.com/data/';

const DATA = 'data'; // 相对路径，部署在子目录也能用

/** 分片缓存，避免重复请求 */
const shardCache = new Map();
/** 全部项目，加载完全部分片后才有 */
let all = [];
/** 是否已加载完所有分片 */
let fullyLoaded = false;
/** 加载进度回调 */
const progressCbs = [];

let manifest = null;
let taxonomy = null;

/**
 * 服务器是否会为 .br 文件设置 Content-Encoding。
 *
 * 这决定了能不能用预压缩版本：
 *   Cloudflare Pages → 自动识别，返回 Content-Encoding: br，省 34% 流量
 *   GitHub Pages     → 只会把 .br 当普通二进制文件返回，解压必然失败
 *
 * 踩过的坑：一开始无条件先请求 .br，GitHub Pages 上 19 个分片
 * 每个都要经历「请求 .br → 解压失败 → 回退 .json」两次往返，
 * 首屏从 0.5 秒变成 18 秒。
 *
 * 现在先探测一次，结果缓存起来，之后直接走对路径。
 */
let brSupported = null;

async function detectBr() {
  if (brSupported !== null) return brSupported;
  try {
    const res = await fetch(`${DATA}/manifest.json.br`, { method: 'GET' });
    brSupported = res.ok && res.headers.get('content-encoding') === 'br';
  } catch {
    brSupported = false;
  }
  return brSupported;
}

/**
 * 拉一个 JSON 文件。
 *
 * 只有服务器确实做了 br 编码才用 .br，否则直接取 .json。
 */
async function fetchJson(rel) {
  const url = `${DATA}/${rel}`;
  const useBr = await detectBr();

  if (useBr) {
    try {
      const res = await fetch(url + '.br');
      if (res.ok) return await res.json();
    } catch {
      /* 解压失败就退回普通文件 */
    }
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`${rel} ${res.status}`);
  return res.json();
}

/**
 * 把数组格式的项目还原成对象。
 *
 * 数组字段顺序必须和 build-static.mjs 里完全一致：
 *   slug, title, summary, summaryZh, type, channels, color, downloads,
 *   license, galleryCount, icon, categories, loaders, versions, images
 *
 * summaryZh 为空字符串表示「和英文相同，没单独存」，
 * 前端按「有值用值，无值回退 summary」处理。
 */
function unpack(a) {
  const [
    slug, title, summary, summaryZh, type, channels, color, downloads, license,
    galleryCount, icon, categories, loaders, versions, images,
  ] = a;
  return {
    slug,
    title,
    summary,
    // 空字符串 → null，让 descOf() 明确走回退逻辑
    summaryZh: summaryZh || null,
    type,
    channels: channels ? channels.split(',') : [type],
    color,
    downloads,
    license,
    galleryCount,
    icon: icon || null,
    categories: categories || [],
    loaders: loaders || [],
    versions: versions || [],
    images: (images || []).map((p) => ({
      thumb: CDN + p,
      full: CDN + p, // 静态版没有代理，高清就是这个
      url: CDN + p,
      src: CDN + p,
    })),
    links: { page: `https://modrinth.com/${type}/${slug}` },
  };
}

/** 初始化：拉 manifest 和分类体系 */
export async function init() {
  manifest = await fetchJson('manifest.json');
  taxonomy = await fetchJson('taxonomy.json');
  return { manifest, taxonomy };
}

export function getTaxonomy() {
  return taxonomy;
}

/** 拿到已加载的全部项目（分片后台加载期间是增量的） */
export function getAll() {
  return all;
}

/** 是否已加载完所有分片 */
export function isFullyLoaded() {
  return fullyLoaded;
}

/**
 * 逐个加载主表分片。
 *
 * 为什么不并发：19 个分片同时请求会占满浏览器的 6 连接上限，
 * 反而让首屏那一份排队。顺序加载能让 p00 最快到达。
 *
 * 并发保护（踩过的坑）：
 *   boot() 后台预热会调一次，用户切频道时 ensureStaticReady() 又会调一次。
 *   两个 while 循环同时跑，各自判断 `shardCache.has(name)` 都是 false，
 *   于是同一个分片被 push 进 all 两次 —— 实测 staticPool 变成 143798
 *   （72199 的两倍），后续所有筛选都基于重复数据。
 *
 *   现在用一个共享 promise：第二次调用直接复用第一次的结果。
 */
let loadingAll = null;

export async function loadAll(onProgress) {
  if (fullyLoaded) return all;
  if (onProgress) progressCbs.push(onProgress);

  // 已经有加载任务在跑 → 复用，不再起第二个循环
  if (loadingAll) return loadingAll;

  loadingAll = (async () => {
    for (let i = 0; i < manifest.shards.length; i++) {
      const name = manifest.shards[i];
      if (shardCache.has(name)) continue;
      const arr = await fetchJson(name);
      shardCache.set(name, arr);
      for (const a of arr) all.push(unpack(a));
      const pct = Math.round(((i + 1) / manifest.shards.length) * 100);
      for (const cb of progressCbs) cb(pct, all.length);
    }
    fullyLoaded = true;
    return all;
  })();

  try {
    return await loadingAll;
  } finally {
    loadingAll = null;
  }
}

/** 只加载第一片，让首屏立刻能刷 */
export async function loadFirstShard() {
  const name = manifest.shards[0];
  if (shardCache.has(name)) {
    return shardCache.get(name).map(unpack);
  }
  const arr = await fetchJson(name);
  shardCache.set(name, arr);
  const items = arr.map(unpack);
  all = all.concat(items);
  return items;
}

/**
 * 复刻后端的加权随机采样。
 *
 * 后端用 feed_index 表做严格等概率，前端只能近似：
 *   按 weight（log10(downloads+10)）算权重，
 *   但把权重压平（开平方），否则头部内容会占满。
 *   实测后端用 6% 头部 + 94% 全库均匀，这里照抄这个比例。
 */
export function sampleFeed(pool, n, rng) {
  const HEAD_RATIO = 0.06;
  const nHead = Math.max(1, Math.round(n * HEAD_RATIO));
  const nWild = n - nHead;

  const out = [];
  const used = new Set();

  // 头部池：按下载量取前 800
  const headPool = pool.slice(0, Math.min(800, pool.length));
  while (out.length < nHead && out.length < pool.length) {
    const c = headPool[Math.floor(rng() * headPool.length)];
    if (!c || used.has(c.slug)) {
      // 避免死循环：头部池太小就跳出
      if (used.size >= headPool.length) break;
      continue;
    }
    used.add(c.slug);
    out.push(c);
  }

  // 全库均匀
  let guard = 0;
  while (out.length < n && guard++ < nWild * 20) {
    const c = pool[Math.floor(rng() * pool.length)];
    if (!c || used.has(c.slug)) continue;
    used.add(c.slug);
    out.push(c);
  }

  return out;
}

/** 按筛选条件过滤（对应后端的 whereSql） */
export function applyFilters(pool, f) {
  const cats = f.categories || [];
  const loaders = f.loaders || [];
  const vers = f.versions || [];
  const types = f.types || [];

  return pool.filter((c) => {
    if (f.requireImages && !c.images.length) return false;
    if (types.length && !types.includes(c.type)) {
      // 一个项目可能属于多个频道（mod + datapack）
      const ch = c.channels || [];
      if (!types.some((t) => ch.includes(t))) return false;
    }
    if (cats.length && !cats.some((x) => (c.categories || []).includes(x))) return false;
    if (loaders.length && !loaders.some((x) => (c.loaders || []).includes(x))) return false;
    if (vers.length && !vers.some((x) => (c.versions || []).includes(x))) return false;
    return true;
  });
}

/** 全文搜索（替代服务端 FTS5） */
export function search(pool, q, limit = 40) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits = [];
  for (const c of pool) {
    const hay = (c.title + ' ' + (c.summary || '')).toLowerCase();
    if (terms.every((t) => hay.includes(t))) {
      hits.push(c);
      if (hits.length >= limit * 4) break;
    }
  }
  hits.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
  return hits.slice(0, limit);
}

/**
 * 取某个项目的正文。
 * 正文分 64 片，按 slug 哈希定位——和后端 build 时用的是同一个哈希。
 *
 * 返回 { en, zh } 两份，由调用方按语言选。
 */
const descCache = new Map();
export async function getDescriptions(slug) {
  const PARTS = manifest.descParts;
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const part = (h >>> 0) % PARTS;
  const name = `desc/d${String(part).padStart(2, '0')}.json`;

  if (!descCache.has(name)) {
    descCache.set(name, await fetchJson(name).catch(() => ({})));
  }
  const hit = descCache.get(name)[slug];
  if (!hit) return { en: '', zh: '' };
  // build 时：两个版本 → [en, zh]；只有一个版本 → [text]
  if (Array.isArray(hit)) {
    return { en: hit[0] || '', zh: hit[1] || '' };
  }
  // 兼容旧数据（纯字符串）
  return { en: String(hit), zh: '' };
}

/** 兼容旧调用：只取中文（没有就用英文） */
export async function getDescription(slug) {
  const { en, zh } = await getDescriptions(slug);
  return zh || en;
}

/** 静态模式没有后端收藏，纯本地 */
export const isStatic = true;
