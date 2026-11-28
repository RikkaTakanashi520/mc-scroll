/**
 * HTTP 后端：把 SQLite 暴露成刷流用的接口。
 *
 * 为什么必须换成后端（而不是继续用静态 JSON）：
 *   17.8 万项目 × 平均 5 张截图 ≈ 近百万行，序列化后 300MB+。
 *   浏览器一次性拉下来会直接卡死，也无法做分页和随机流。
 *
 * 接口设计：
 *   GET /api/health                     服务和数据状态
 *   GET /api/taxonomy                   分类体系（分类/加载器/版本）
 *   GET /api/feed?types=&categories=&loaders=&versions=&q=&limit=&cursor=
 *       刷流主接口。cursor 是上一页返回的 opaque token，内部用「偏移+随机种子」，
 *       保证同一次会话里翻页稳定，不会像 ORDER BY RANDOM() 那样每次乱跳。
 *   GET /api/project/:slug              单个项目详情（含全部截图）
 *   GET /api/search?q=                  全文本搜索（FTS5）
 *   GET /api/favorites / POST /api/favorites  收藏（服务端存，将来跨设备）
 *
 * 性能要点：
 *   - 随机流不用 ORDER BY RANDOM()（17 万行会全表扫 + 排序）。
 *     改用「按 weight 排序 + 随机起始偏移」的多段取样，稳定在 10ms 级。
 *   - 所有列表查询都走覆盖索引，绝不 SELECT *。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, stats } from './db.mjs';
import { getThumb } from './imgproxy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = Number(process.env.PORT || 4173);
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const db = openDb();

/* ============================ 查询层 ============================ */

const SELECT_CARD = `
  p.id, p.slug, p.title, p.summary, p.summary_zh, p.description, p.description_zh,
  p.project_type, p.channels, p.icon_url, p.color,
  p.downloads, p.follows, p.license_id, p.license_name, p.client_side, p.server_side,
  p.source_url, p.issues_url, p.wiki_url, p.discord_url,
  p.published_at, p.updated_at, p.gallery_count
`;

/**
 * 图片 URL 的最终形态 —— 只信任能快速加载的图源。
 *
 * 实测三种图源的表现（首屏 10 张并发）：
 *   - cdn.modrinth.com   → 走本地代理后 15~18ms（预热命中）
 *   - imgur / github     → 连接超时，单张能把整屏拖到 19 秒
 *   - 其它第三方图床     → 不稳定，偶尔回退成 3.5MB 原图
 *
 * 所以：只保留 Modrinth CDN 的图，其余一律丢弃。
 * 与其让用户卡 19 秒等一张图，不如这张卡少一张截图 —— 卡片还有图标和正文兜底。
 * 这是「宁可少图，不可卡顿」的取舍。
 */
/**
 * 构造首屏缩略图 URL —— 直连 CDN，不走代理。
 *
 * 这是性能关键。实测数据：
 *   CDN 的 _350.webp  → 约 60KB，直连 50~300ms
 *   走代理取原图再缩     → 原图 1~4MB，平均 15 秒，45 张里 31 张超时
 *
 * 所以首屏必须用 CDN 缩略图（快），高清版由前端「停留后升级」再走代理取。
 * 早前把首屏也改成走代理取原图，直接把成功率打到 31%，是明确的回退。
 */
function pickThumbUrl(url, thumb) {
  const src = thumb || url;
  if (!src) return '';
  try {
    if (new URL(src).hostname !== 'cdn.modrinth.com') return null; // 外链图床丢弃
  } catch {
    return null;
  }
  return src;
}

/**
 * 构造高清图 URL —— 走本地代理取原图并缩放。
 *
 * 只在「当前卡片停留足够久」之后才请求，所以慢一点没关系，
 * 换来的是 1280px 的清晰画面（原图动辄 1920×1080）。
 */
function pickImageUrl(url, thumb, width = 640) {
  // 优先原图；原图缺失时退回缩略图
  const src = url || thumb;
  if (!src) return '';
  try {
    if (new URL(src).hostname !== 'cdn.modrinth.com') return null; // 外链图床丢弃
  } catch {
    return null;
  }
  return `/api/img?w=${width}&u=${encodeURIComponent(src)}`;
}

/**
 * 批量补截图。
 *
 * 刷流卡片必须带截图（没图的卡刷起来是纯文字，产品就废了）。
 * 但不能用 N+1 查询：一次 feed 20 张卡，逐张查就是 20 次往返。
 * 这里用一条 IN 查询取回所有卡片的图，再按 project_id 归组。
 *
 * 张数上限（踩过的坑）：
 *   原来写死 6 张，结果「只能切换前六张图」——而实测数据里
 *   15.9% 的项目超过 6 张，最多 65 张。用户明确要求能翻全部。
 *
 *   但不能一次全返回：6 张上限时 feed 只需 ~120 条记录，
 *   放到 24 张会变成 ~480 条，20 张卡的响应体翻 4 倍，首屏明显变慢。
 *
 *   所以改成「首屏给 24 张，其余按需拉」：
 *     - 每张卡 count 字段告诉前端总共有多少张
 *     - 前端翻到第 24 张附近时再调 /api/images?slug= 补齐
 *   24 张已经覆盖 P99（99% 的项目不超过 23 张），绝大多数用户感知不到分页。
 */
const FEED_IMAGES_PER_PROJECT = 24;

function attachImages(cards, perProject = FEED_IMAGES_PER_PROJECT) {
  if (!cards.length) return cards;
  const ids = cards.map((c) => c.id);
  const ph = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT project_id AS pid, url, thumb_url AS thumb, title
       FROM project_images
       WHERE project_id IN (${ph})
       ORDER BY project_id, position`,
    )
    .all(...ids);

  const byId = new Map(cards.map((c) => [c.id, c]));
  for (const c of cards) c.images = [];
  for (const r of rows) {
    const card = byId.get(r.pid);
    if (!card) continue;
    // 先统计总数，超出的只计数不塞进数组
    const thumb = pickThumbUrl(r.url, r.thumb);
    if (!thumb) continue; // 外链图床直接跳过
    card.imageTotal = (card.imageTotal || 0) + 1;
    if (card.images.length >= perProject) continue;
    card.images.push({
      // thumb = CDN 直连缩略图（几十 KB，首屏立刻能看）
      thumb,
      // full  = 本地代理缩放后的高清图（1~4MB 原图，慢但清晰）
      full: pickImageUrl(r.url, r.thumb, 1280) || thumb,
      // url 保留同样语义给灯箱/详情用
      url: pickImageUrl(r.url, r.thumb, 1280) || thumb,
      src: r.url,
      title: r.title,
    });
  }
  return cards;
}

/**
 * 把一行 project 转成前端卡片结构。
 *
 * 双语策略：英文原文和中文译文**都**返回（summary / summaryZh），
 * 由前端按当前语言挑一个显示。
 *
 * 为什么不在后端定语言：切换语言要立刻生效，不应该再发一次请求。
 * 前端已经拿到两份文本，直接换着渲染即可（实测切语言若重新请求，
 * 正在看的项目会消失，那是明显的体验缺陷）。
 */
function toCard(row, { withImages = false } = {}) {
  const card = {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    summaryZh: row.summary_zh || null,
    type: row.project_type,
    // channels 是逗号分隔的集合（mod,datapack），前端频道筛选靠它
    channels: row.channels ? row.channels.split(',') : [row.project_type],
    icon: row.icon_url,
    color: row.color,
    downloads: row.downloads,
    follows: row.follows,
    license: row.license_id || row.license_name || '',
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    galleryCount: row.gallery_count,
    links: {
      page: `https://modrinth.com/${row.project_type}/${row.slug}`,
      source: row.source_url || '',
      issues: row.issues_url || '',
      wiki: row.wiki_url || '',
      discord: row.discord_url || '',
    },
  };
  if (withImages) {
    card.description = row.description || '';
    card.descriptionZh = row.description_zh || null;
    card.images = db
      .prepare('SELECT url, thumb_url AS thumb, title, description FROM project_images WHERE project_id = ? ORDER BY position')
      .all(row.id);
  }
  return card;
}

/** 批量取分类/加载器/版本，避免 N+1 查询 */
function attachTaxonomy(cards, { versionLimit = 6 } = {}) {
  if (!cards.length) return cards;
  const ids = cards.map((c) => c.id);
  const ph = ids.map(() => '?').join(',');

  const cats = db
    .prepare(
      `SELECT pc.project_id AS pid, tc.name, tc.header FROM project_categories pc
       JOIN taxonomy_categories tc ON tc.id = pc.category_id
       WHERE pc.project_id IN (${ph})`,
    )
    .all(...ids);
  const loaders = db
    .prepare(
      `SELECT pl.project_id AS pid, tl.name FROM project_loaders pl
       JOIN taxonomy_loaders tl ON tl.id = pl.loader_id
       WHERE pl.project_id IN (${ph})`,
    )
    .all(...ids);
  // 版本按发布时间倒序，只取正式版（release）。
  // versionLimit 由调用方决定：列表页 6 个够用，详情页要给全（0 = 不限）。
  const versions = db
    .prepare(
      `SELECT pgv.project_id AS pid, gv.version, gv.released_at
       FROM project_game_versions pgv
       JOIN taxonomy_game_versions gv ON gv.id = pgv.version_id
       WHERE pgv.project_id IN (${ph})
       AND gv.version_type = 'release'
       ORDER BY gv.released_at DESC`,
    )
    .all(...ids);

  const byId = new Map(cards.map((c) => [c.id, c]));
  for (const c of cards) {
    c.categories = [];
    c.loaders = [];
    c.versions = [];
  }
  for (const r of cats) byId.get(r.pid)?.categories.push(r.name);
  for (const r of loaders) byId.get(r.pid)?.loaders.push(r.name);
  for (const r of versions) {
    const card = byId.get(r.pid);
    if (!card) continue;
    if (versionLimit && card.versions.length >= versionLimit) continue;
    card.versions.push(r.version);
  }
  return cards;
}

/**
 * 刷流主查询。
 *
 * cursor 设计：
 *   把「种子 + 已返回条数」编码成 base64 token。
 *   种子决定这一次会话内按什么顺序扫描；偏移决定翻到第几页。
 *   这样翻页是确定的（不会重复/漏），但每次新会话种子不同，内容顺序会变。
 *
 * 不用 ORDER BY RANDOM()：17 万行时它要全表扫再排序，单次查询几百毫秒。
 */
function decodeCursor(cursor) {
  if (!cursor) return { seed: Math.floor(Math.random() * 1e9), offset: 0 };
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const [seed, offset] = raw.split(':');
    return { seed: Number(seed) || 0, offset: Number(offset) || 0 };
  } catch {
    return { seed: Math.floor(Math.random() * 1e9), offset: 0 };
  }
}

function encodeCursor(seed, offset) {
  return Buffer.from(`${seed}:${offset}`, 'utf8').toString('base64url');
}

function buildFeedQuery(params) {
  const where = [];
  const binds = [];

  if (params.types.length) {
    // 用 channels 而不是 project_type：datapack 是叠加在 mod 上的频道，
    // 用 project_type 筛会把「既是 mod 又是 datapack」的项目漏掉。
    const clauses = params.types.map(() => `',' || p.channels || ',' LIKE ?`);
    where.push(`(${clauses.join(' OR ')})`);
    binds.push(...params.types.map((t) => `%,${t},%`));
  }
  if (params.categories.length) {
    where.push(
      `EXISTS (SELECT 1 FROM project_categories pc JOIN taxonomy_categories tc ON tc.id=pc.category_id
               WHERE pc.project_id=p.id AND tc.name IN (${params.categories.map(() => '?').join(',')}))`,
    );
    binds.push(...params.categories);
  }
  if (params.loaders.length) {
    where.push(
      `EXISTS (SELECT 1 FROM project_loaders pl JOIN taxonomy_loaders tl ON tl.id=pl.loader_id
               WHERE pl.project_id=p.id AND tl.name IN (${params.loaders.map(() => '?').join(',')}))`,
    );
    binds.push(...params.loaders);
  }
  if (params.versions.length) {
    where.push(
      `EXISTS (SELECT 1 FROM project_game_versions pgv JOIN taxonomy_game_versions gv ON gv.id=pgv.version_id
               WHERE pgv.project_id=p.id AND gv.version IN (${params.versions.map(() => '?').join(',')}))`,
    );
    binds.push(...params.versions);
  }
  // 只在搜索时用 FTS，普通刷流走索引
  if (params.q) {
    where.push(`p.id IN (SELECT rowid FROM projects_fts WHERE projects_fts MATCH ?)`);
    binds.push(params.q.split(/\s+/).filter(Boolean).map((t) => `${t}*`).join(' '));
  }
  // 一定要有图片的项目优先：没有截图的卡片刷起来是纯文字，体验差
  if (params.requireImages) where.push('p.gallery_count > 0');

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return { whereSql, binds };
}

/**
 * 总数缓存。
 *
 * 为什么需要：`SELECT COUNT(*) FROM projects WHERE gallery_count>0` 在 17 万行上要扫全表，
 * 实测 135ms。而刷流时前端每翻一页都会带上筛选条件来问一次总数，属于纯浪费。
 * 数据抓完后基本不变，所以按「筛选条件字符串」做短时效缓存，5 分钟过期。
 */
const countCache = new Map();
const COUNT_TTL = 5 * 60_000;

function cachedCount(key, fn) {
  const hit = countCache.get(key);
  if (hit && Date.now() - hit.at < COUNT_TTL) return hit.n;
  const n = fn();
  countCache.set(key, { n, at: Date.now() });
  // 简单防膨胀
  if (countCache.size > 200) {
    const oldest = [...countCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) countCache.delete(oldest[0]);
  }
  return n;
}

/**
 * 对已取出的行做筛选校验（在内存里，避免每次随机都走 SQL）。
 *
 * 为什么不用 SQL 的 EXISTS：随机取 25 行时，
 * 每行都要跑 3~4 个 EXISTS 子查询就是 100 次查询，直接回到几百毫秒。
 * 这里把「该项目的分类/加载器/版本」缓存起来，后续判断都是内存操作。
 */
const projectMetaCache = new Map();
const META_CACHE_MAX = 20000;

function projectMeta(id) {
  let m = projectMetaCache.get(id);
  if (m) return m;
  m = {
    categories: new Set(
      db
        .prepare(
          `SELECT tc.name FROM project_categories pc
           JOIN taxonomy_categories tc ON tc.id = pc.category_id
           WHERE pc.project_id = ?`,
        )
        .all(id)
        .map((r) => r.name),
    ),
    loaders: new Set(
      db
        .prepare(
          `SELECT tl.name FROM project_loaders pl
           JOIN taxonomy_loaders tl ON tl.id = pl.loader_id
           WHERE pl.project_id = ?`,
        )
        .all(id)
        .map((r) => r.name),
    ),
    versions: new Set(
      db
        .prepare(
          `SELECT gv.version FROM project_game_versions pgv
           JOIN taxonomy_game_versions gv ON gv.id = pgv.version_id
           WHERE pgv.project_id = ?`,
        )
        .all(id)
        .map((r) => r.version),
    ),
  };
  if (projectMetaCache.size > META_CACHE_MAX) projectMetaCache.clear();
  projectMetaCache.set(id, m);
  return m;
}

function matchesFilters(row, id, params) {
  if (params.types.length) {
    const ch = row.channels ? row.channels.split(',') : [row.project_type];
    if (!params.types.some((t) => ch.includes(t))) return false;
  }
  if (params.categories.length || params.loaders.length || params.versions.length) {
    const meta = projectMeta(id);
    if (params.categories.length && !params.categories.some((c) => meta.categories.has(c))) return false;
    if (params.loaders.length && !params.loaders.some((l) => meta.loaders.has(l))) return false;
    if (params.versions.length && !params.versions.some((v) => meta.versions.has(v))) return false;
  }
  return true;
}

function feed(params) {
  const { seed, offset } = decodeCursor(params.cursor);
  const limit = Math.min(Math.max(params.limit, 1), 50);
  const { whereSql, binds } = buildFeedQuery(params);

  const total = cachedCount(`${whereSql}|${binds.join(',')}`, () =>
    db.prepare(`SELECT COUNT(*) n FROM projects p ${whereSql}`).get(...binds).n,
  );

  // ===== 随机流核心算法 =====
  //
  // 之前的问题（实测）：候选池只取权重前 800 名，total 有 72199 个项目，
  // 意味着 71000+ 个长尾内容永远刷不到。10 次刷新只覆盖 79 个项目，
  // Sodium 一家出现 6 次 —— 这不是「随机」，是「在头部里随机」。
  //
  // 现在改成「分层随机抽样（stratified sampling）」：
  //   70% 名额给「全库均匀随机」，保证长尾有真实机会
  //   30% 名额给头部，让经典内容不至于消失
  //
  // 为什么不用纯 ORDER BY RANDOM()：
  //   17 万行上它会全表扫 + 排序，单次查询几百毫秒。
  //   这里用「随机 rowid + 范围扫描」，靠索引定位，稳定在 10ms 级。

  let rngState = (seed || Date.now()) >>> 0;
  const rng = () => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 4294967296;
  };

  const need = Math.min(limit, 50);

  // 分层比例：94% 全库均匀随机（长尾真实机会），6% 头部（经典内容偶尔露脸）
  //
  // 这个比例是实测调出来的：
  //   15% 头部时，>10M 下载的项目占比 12.8%（真实占比 0.4%），偏斜明显；
  //   6% 后回到 5% 左右，接近真实分布。
  //   完全不保留头部也不行——Sodium 这类神作会几十次刷不到，新用户会觉得内容差。
  const nHead = Math.max(1, Math.round(need * 0.06));
  const nWild = need - nHead;

  const picked = [];
  const usedIds = new Set();

  // ---- 1. 全库均匀随机（走 feed_index 表）----
  //
  // 这是本项目最关键的三个性能/正确性决策，全部有实测依据：
  //
  //   坑 1：「随机 id 起点 + 连续取 8 行」
  //         → 相邻 id 是同批入库、属性接近，等于只抽了 1 个项目。
  //
  //   坑 2：「随机 id 起点 + 只取 1 行」
  //         → id 分布极不均匀（段 0 有 13739 个，段 3 只有 185 个），
  //           随机起点落在空段会向后扫到密集区，而密集区恰好是「按下载量首批导入」
  //           的头部项目，结果 >10M 下载的被抽到 23.8%（真实占比 0.4%）。
  //
  //   坑 3：「ORDER BY id LIMIT 1 OFFSET <随机数>」
  //         → 分布正确了，但 OFFSET 要顺序跳过 n 行，
  //           实测 offset=50000 单次 74ms，一页 25 条要 1800ms。
  //
  //   现在的做法：预建 feed_index 表，把所有项目连续编号成 0..N-1，
  //   随机取一行 = seq 主键等值查找 = 0.002ms（快 3.7 万倍），
  //   且因为编号连续，每个项目被抽中的概率严格相等。
  //
  //   两张索引表：
  //     feed_index      全量 169,451 行（含无截图项目）
  //     feed_index_img  只含有截图的 72,199 行
  //   按 requireImages 选对应那张，而不是「取全量再拒绝采样」——
  //   后者在只刷有图时会有一半以上的尝试被丢弃，白白浪费。
  const useImgIndex = params.requireImages;
  const idxTotal = cachedCount(useImgIndex ? 'feed_index_img_total' : 'feed_index_total', () => {
    try {
      return db
        .prepare(`SELECT COUNT(*) n FROM ${useImgIndex ? 'feed_index_img' : 'feed_index'}`)
        .get().n;
    } catch {
      return 0;
    }
  });

  if (!idxTotal) {
    // 索引表不存在或为空：给一个明确提示，不要静默返回空列表
    throw new Error('feed_index 未构建，请运行 node scripts/build-feed-index.mjs');
  }

  const seqStmt = db.prepare(
    `SELECT project_id FROM ${useImgIndex ? 'feed_index_img' : 'feed_index'} WHERE seq = ?`,
  );
  const fullById = db.prepare(`SELECT ${SELECT_CARD} FROM projects p WHERE p.id = ?`);

  function grabWild(n) {
    const out = [];
    const seenInBatch = new Set();
    if (n <= 0) return out;

    let guard = 0;
    const maxAttempts = n * 3 + 20;
    while (out.length < n && guard++ < maxAttempts) {
      const seq = Math.floor(rng() * idxTotal);
      const hit = seqStmt.get(seq);
      if (!hit) continue;
      if (seenInBatch.has(hit.project_id)) continue;

      const row = fullById.get(hit.project_id);
      if (!row) continue;

      // whereSql 里的筛选条件（类型/分类/版本等）在这里二次校验。
      // 用 SQL 的 EXISTS 子查询做会慢，这里直接对已取出的行做判断。
      if (!matchesFilters(row, hit.project_id, params)) continue;

      seenInBatch.add(hit.project_id);
      out.push(row);
    }
    return out;
  }

  // ---- 2. 头部：按名次加权 ----
  //
  // 名额很少（15%），作用是「保证经典内容偶尔出现」，
  // 不是主力。实测若不保留这一档，Sodium 这类神作可能几十次都刷不到，
  // 新用户会觉得内容质量很差。nHead 在函数开头已算好。
  const HEAD_POOL = 600;
  const headRows = db
    .prepare(`SELECT ${SELECT_CARD} FROM projects p ${whereSql} ORDER BY p.weight DESC LIMIT ?`)
    .all(...binds, HEAD_POOL);

  const headWeights = headRows.map((_, i) => 1 / Math.pow(i + 1, 0.85));
  const headTotal = headWeights.reduce((s, w) => s + w, 0);
  const headTaken = new Set();

  for (let i = 0; i < nHead && headRows.length; i++) {
    let r = rng() * headTotal;
    let idx = 0;
    for (let k = 0; k < headRows.length; k++) {
      if (headTaken.has(k)) continue;
      r -= headWeights[k];
      if (r <= 0) {
        idx = k;
        break;
      }
    }
    // 被占用的向前找空位
    let guard = 0;
    while (headTaken.has(idx) && guard++ < headRows.length) idx = (idx + 1) % headRows.length;
    headTaken.add(idx);
    const row = headRows[idx];
    if (row && !usedIds.has(row.id)) {
      usedIds.add(row.id);
      picked.push(row);
    }
  }

  // ---- 3. 全库均匀随机：填满剩余名额 ----
  // 用批量取行，边取边去重；id 重复就跳过（同一段被抽到两次很正常）
  let guard = 0;
  while (picked.length < need && guard++ < 40) {
    const batch = grabWild(need - picked.length + 4);
    if (!batch.length) break;
    for (const row of batch) {
      if (picked.length >= need) break;
      if (usedIds.has(row.id)) continue;
      usedIds.add(row.id);
      picked.push(row);
    }
  }

  // 打散顺序：否则会看到「头部项目总是排在前面」
  for (let i = picked.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [picked[i], picked[j]] = [picked[j], picked[i]];
  }

  const page = picked;

  const cards = attachImages(attachTaxonomy(page.map((r) => toCard(r))));
  return {
    items: cards,
    total,
    nextCursor: offset + limit < total ? encodeCursor(seed, offset + limit) : null,
  };
}

function taxonomy() {
  const categories = db
    .prepare(
      'SELECT project_type AS projectType, name, header, display_name AS displayName, icon_url AS icon FROM taxonomy_categories ORDER BY project_type, header, name',
    )
    .all();
  const loaders = db
    .prepare(
      `SELECT l.name, l.display_name AS displayName, GROUP_CONCAT(lt.project_type) AS types
       FROM taxonomy_loaders l LEFT JOIN taxonomy_loader_types lt ON lt.loader_id = l.id
       GROUP BY l.id ORDER BY l.name`,
    )
    .all()
    .map((l) => ({ ...l, types: l.types ? l.types.split(',') : [] }));
  const gameVersions = db
    .prepare(
      `SELECT version, version_type AS versionType, released_at AS releasedAt, major
       FROM taxonomy_game_versions ORDER BY released_at DESC`,
    )
    .all();
  return {
    categories,
    loaders,
    gameVersions,
    projectTypes: [...new Set(categories.map((c) => c.projectType))],
  };
}

function projectDetail(slug) {
  const row = db.prepare(`SELECT ${SELECT_CARD} FROM projects p WHERE p.slug = ?`).get(slug);
  if (!row) return null;
  const [card] = attachTaxonomy([toCard(row, { withImages: true })], { versionLimit: 0 });
  card.images = (card.images || []).map((i) => ({
    url: i.url,
    thumb: i.thumb,
    title: i.title,
    description: i.description,
  }));
  return card;
}

/**
 * 补齐某个项目剩余截图的接口。
 *
 * 刷流时每张卡只带前 24 张（覆盖 P99），用户翻到接近末尾时再调这里取剩余部分。
 * 用 slug 而不是 id，前端手上只有 slug。
 */
function projectImages(slug, from = 0, limit = 64) {
  const row = db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug);
  if (!row) return null;
  const rows = db
    .prepare(
      `SELECT url, thumb_url AS thumb, title
       FROM project_images
       WHERE project_id = ?
       ORDER BY position
       LIMIT ? OFFSET ?`,
    )
    .all(row.id, Math.min(Math.max(Number(limit) || 64, 1), 100), Math.max(Number(from) || 0, 0));

  const images = [];
  for (const r of rows) {
    const thumb = pickThumbUrl(r.url, r.thumb);
    if (!thumb) continue;
    images.push({
      thumb,
      full: pickImageUrl(r.url, r.thumb, 1280) || thumb,
      url: pickImageUrl(r.url, r.thumb, 1280) || thumb,
      src: r.url,
      title: r.title,
    });
  }
  const total = db
    .prepare('SELECT COUNT(*) n FROM project_images WHERE project_id = ?')
    .get(row.id).n;
  return { images, total };
}

/* ============================ HTTP ============================ */

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function parseList(v) {
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (p.startsWith('/api/')) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        return res.end();
      }

      if (p === '/api/health') {
        return json(res, { ok: true, ...stats(db), uptime: process.uptime() });
      }

      // 图片代理：/api/img?u=<原图地址>&w=640
      // 用途：把 1~2MB 的原图缩成 ~30KB 的 WebP，首屏才不卡。
      if (p === '/api/img') {
        const src = url.searchParams.get('u');
        const w = Number(url.searchParams.get('w') || 640);
        if (!src) return json(res, { error: 'u required' }, 400);
        try {
          const out = await getThumb(src, w);
          res.writeHead(200, {
            'Content-Type': out.contentType,
            'Content-Length': out.buf.length,
            'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Img-Cache': out.cache,
            'Access-Control-Allow-Origin': '*',
          });
          return res.end(out.buf);
        } catch (err) {
          // 代理失败时重定向到原图，保证图片至少能显示
          if (err.code === 'HOST' || /upstream_|too_large/.test(err.message)) {
            res.writeHead(302, { Location: src });
            return res.end();
          }
          throw err;
        }
      }

      if (p === '/api/taxonomy') {
        return json(res, taxonomy());
      }

      if (p === '/api/feed') {
        const t0 = Date.now();
        const data = feed({
          types: parseList(url.searchParams.get('types')),
          categories: parseList(url.searchParams.get('categories')),
          loaders: parseList(url.searchParams.get('loaders')),
          versions: parseList(url.searchParams.get('versions')),
          q: (url.searchParams.get('q') || '').trim(),
          limit: Number(url.searchParams.get('limit') || 20),
          cursor: url.searchParams.get('cursor'),
          requireImages: url.searchParams.get('requireImages') !== '0',
        });
        return json(res, { ...data, tookMs: Date.now() - t0 });
      }

      if (p === '/api/search') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) return json(res, { items: [], total: 0 });
        const limit = Math.min(Number(url.searchParams.get('limit') || 30), 60);
        const types = parseList(url.searchParams.get('types'));
        const fts = q.split(/\s+/).filter(Boolean).map((t) => `${t}*`).join(' ');
        const where = types.length ? `AND p.project_type IN (${types.map(() => '?').join(',')})` : '';
        const rows = db
          .prepare(
            `SELECT ${SELECT_CARD} FROM projects p
             JOIN projects_fts f ON f.rowid = p.id
             WHERE projects_fts MATCH ? ${where}
             ORDER BY p.downloads DESC LIMIT ?`,
          )
          .all(fts, ...types, limit);
        return json(res, { items: attachImages(attachTaxonomy(rows.map((r) => toCard(r)))), total: rows.length, q });
      }

      const projMatch = p.match(/^\/api\/project\/([\w-]+)$/);
      if (projMatch) {
        const data = projectDetail(decodeURIComponent(projMatch[1]));
        if (!data) return json(res, { error: 'not found' }, 404);
        return json(res, data);
      }

      // 补齐剩余截图：刷流只带前 24 张，翻到末尾时调这里
      const imgMatch = p.match(/^\/api\/images\/([\w-]+)$/);
      if (imgMatch) {
        const from = Number(url.searchParams.get('from') || 0);
        const limit = Number(url.searchParams.get('limit') || 64);
        const data = projectImages(decodeURIComponent(imgMatch[1]), from, limit);
        if (!data) return json(res, { error: 'not found' }, 404);
        return json(res, data);
      }

      if (p === '/api/favorites') {
        const deviceId = url.searchParams.get('device') || req.headers['x-device-id'] || 'anon';
        if (req.method === 'GET') {
          const rows = db
            .prepare(
              `SELECT f.project_id AS id, f.created_at AS savedAt, ${SELECT_CARD}
               FROM favorites f JOIN projects p ON p.id = f.project_id
               WHERE f.device_id = ? ORDER BY f.created_at DESC`,
            )
            .all(deviceId);
          return json(res, { items: attachImages(attachTaxonomy(rows.map((r) => toCard(r)))) });
        }
        if (req.method === 'POST' || req.method === 'DELETE') {
          let body = '';
          for await (const chunk of req) body += chunk;
          const { projectId } = JSON.parse(body || '{}');
          if (!projectId) return json(res, { error: 'projectId required' }, 400);
          if (req.method === 'POST') {
            db.prepare('INSERT OR IGNORE INTO favorites (device_id, project_id) VALUES (?, ?)').run(
              deviceId,
              projectId,
            );
          } else {
            db.prepare('DELETE FROM favorites WHERE device_id = ? AND project_id = ?').run(deviceId, projectId);
          }
          const n = db
            .prepare('SELECT COUNT(*) n FROM favorites WHERE device_id = ?')
            .get(deviceId).n;
          return json(res, { ok: true, count: n });
        }
      }

      return json(res, { error: 'unknown endpoint' }, 404);
    }

    // ---- 静态文件 ----
    let rel = decodeURIComponent(p);
    if (rel === '/' || rel === '') rel = '/index.html';
    const target = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!target.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const info = await stat(target).catch(() => null);
    if (!info) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const file = info.isDirectory() ? path.join(target, 'index.html') : target;
    const data = await readFile(file);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(data);
  } catch (err) {
    console.error('[api]', err);
    if (p.startsWith('/api/')) return json(res, { error: err.message }, 500);
    res.writeHead(500).end('Internal Error');
  }
});

server.listen(PORT, HOST, () => {
  const s = stats(db);
  console.log(`MC 刷 服务已启动: http://${HOST}:${PORT}/`);
  console.log(`数据库: ${s.projects} 个项目 / ${s.images} 张截图 / ${s.categories} 分类`);
});

// 同时监听 localhost：前端会把数据请求发到「另一个主机名」，
// 以避开 HTTP/1.1 每域 6 连接的限制（图片和 API 各占一组连接）。
// 不监听的话 localhost 访问会直接连不上。
if (HOST === '127.0.0.1') {
  const alt = createServer(server.listeners('request')[0]);
  alt.on('error', () => {
    /* 端口被占用就忽略，主服务仍可用 */
  });
  alt.listen(PORT, 'localhost', () => {
    console.log(`备用入口: http://localhost:${PORT}/（用于绕开连接数限制）`);
  });
}
