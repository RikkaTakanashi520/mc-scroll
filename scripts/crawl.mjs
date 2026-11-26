/**
 * Modrinth 全量抓取 -> SQLite
 *
 * 用法:
 *   node scripts/crawl.mjs --taxonomy            # 只同步分类体系（快，几秒）
 *   node scripts/crawl.mjs --type mod --limit 500   # 小样本试跑
 *   node scripts/crawl.mjs --all                 # 全量（约 17.8 万项目）
 *   node scripts/crawl.mjs --all --resume        # 中断后续传
 *
 * 抓取策略：
 *   1) 先同步 taxonomy（分类/加载器/游戏版本），全部表驱动落库
 *   2) 对每个 project_type，按 index 拉搜索结果分页（50/页，8 并发）
 *      - Modrinth 无深分页限制，实测 offset=70000 仍可正常返回
 *      - 记录 checkpoint，中断后从上次位置继续
 *   3) 把搜索结果里已有的字段先入库（标题/简介/下载量/图标/分类/加载器/版本）
 *   4) 再批量补详情（gallery 截图、正文、链接），一次最多 100 个 ID
 *
 * 为什么分两步：搜索接口一次就能返回大部分字段，先全量入库能最快保证「有数据」；
 * 详情接口更贵（每 100 个一次请求且响应大），放在后面且可跳过。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, tx, getCheckpoint, setCheckpoint } from '../server/db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://api.modrinth.com/v2';
const UA = 'mc-scroll/0.1 (full crawler; contact via github)';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const CONCURRENCY = Number(val('--concurrency', '8'));
const PAGE = 50;
const WITH_DETAILS = !has('--no-details');
const RESUME = has('--resume');

const ALL_TYPES = ['mod', 'modpack', 'datapack', 'resourcepack', 'shader', 'plugin', 'minecraft_java_server'];

/**
 * Modrinth 的类型坑（实测确认，不是猜的）：
 *
 *   datapack 和 plugin 都不是 project_type，而是 mod 上的标签（categories）。
 *   直接把 "project_type:datapack" 丢给搜索接口，返回的是 project_type=mod 的项目，
 *   所以第一版抓了 1.5 万条 datapack「成功」但入库 0 条 —— 全被 slug 去重成 mod 了。
 *
 *   正确做法：用 facets=[["categories:datapack"]] 查，命中后再按 categories 判定归属。
 *   同一个项目可能既是 mod 又是 datapack/plugin（Terralith、VeinMiner 都是），
 *   用 channels 集合表达多归属，而不是单值 project_type。
 */
const SEARCH_TYPE = {
  mod: 'mod',
  modpack: 'modpack',
  datapack: 'mod',
  plugin: 'mod',
  resourcepack: 'resourcepack',
  shader: 'shader',
  minecraft_java_server: 'minecraft_java_server',
};

function facetsFor(type) {
  // datapack / plugin 用分类过滤；其余按项目类型
  if (type === 'datapack') return [['categories:datapack']];
  if (type === 'plugin') return [['categories:paper']]; // paper 是覆盖最广的服务端加载器
  return [['project_type:' + type]];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带重试与 429 退避的请求 */
async function api(pathname, { retries = 5 } = {}) {
  const url = pathname.startsWith('http') ? pathname : BASE + pathname;
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 429) {
        const reset = Number(res.headers.get('x-ratelimit-reset') || 5);
        await sleep(Math.min(reset * 1000 + 500, 30_000));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr;
}

/** 计算排序权重：下载量取对数 + 新鲜度加成，与前端引擎保持一致的思路 */
function computeWeight(downloads, updatedAt, imageCount) {
  const dl = Math.max(downloads || 0, 1);
  let w = Math.log10(dl + 10);
  if (updatedAt) {
    const days = (Date.now() - Date.parse(updatedAt)) / 86_400_000;
    if (days >= 0 && days < 365) w *= 1 + 0.4 * (1 - days / 365);
  }
  w *= 1 + Math.min(imageCount || 0, 3) * 0.12;
  return Math.round(w * 1000) / 1000;
}

/* ============================ 1. taxonomy ============================ */

async function syncTaxonomy(db) {
  console.log('[taxonomy] 同步分类体系...');
  const [categories, loaders, versions] = await Promise.all([
    api('/tag/category'),
    api('/tag/loader'),
    api('/tag/game_version'),
  ]);

  tx(db, () => {
    // Modrinth 的 tag/category 没有 datapack 条目，但 datapack 实际复用 mod 的分类。
    // 这里显式复制一份，让「按分类筛 datapack」能直接走表，不用在 SQL 里特判。
    const datapackCats = categories
      .filter((c) => c.project_type === 'mod')
      .map((c) => ({ ...c, project_type: 'datapack' }));
    const allCats = [...categories, ...datapackCats];

    const insCat = db.prepare(
      `INSERT INTO taxonomy_categories (project_type, name, header, display_name, icon_url)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_type, name) DO UPDATE SET
         header=excluded.header, display_name=excluded.display_name, icon_url=excluded.icon_url`,
    );
    for (const c of allCats) {
      const display = c.name.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
      insCat.run(c.project_type, c.name, c.header || 'categories', display, c.icon || null);
    }

    const insLoader = db.prepare(
      `INSERT INTO taxonomy_loaders (name, display_name) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET display_name=excluded.display_name`,
    );
    const getLoader = db.prepare('SELECT id FROM taxonomy_loaders WHERE name = ?');
    const insLt = db.prepare(
      `INSERT OR IGNORE INTO taxonomy_loader_types (loader_id, project_type) VALUES (?, ?)`,
    );
    for (const l of loaders) {
      const display = l.name.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
      insLoader.run(l.name, display);
      const id = getLoader.get(l.name).id;
      for (const t of l.supported_project_types || []) insLt.run(id, t);
    }

    const insVer = db.prepare(
      `INSERT INTO taxonomy_game_versions (version, version_type, released_at, major)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(version) DO UPDATE SET
         version_type=excluded.version_type, released_at=excluded.released_at, major=excluded.major`,
    );
    for (const v of versions) {
      insVer.run(v.version, v.version_type || 'release', v.date || null, v.major ? 1 : 0);
    }
  });

  const n = {
    cats: db.prepare('SELECT COUNT(*) n FROM taxonomy_categories').get().n,
    loaders: db.prepare('SELECT COUNT(*) n FROM taxonomy_loaders').get().n,
    versions: db.prepare('SELECT COUNT(*) n FROM taxonomy_game_versions').get().n,
  };
  console.log(`[taxonomy] 完成: ${n.cats} 分类 / ${n.loaders} 加载器 / ${n.versions} 版本`);
}

/* ============================ 2. 搜索分页 ============================ */

async function searchPage(type, offset, index = 'downloads') {
  const facets = JSON.stringify(facetsFor(type));
  const q = new URLSearchParams({ limit: PAGE, offset, index, facets });
  return api(`/search?${q}`);
}

/** 把一页搜索结果写入数据库（不含截图/正文，那些走详情接口） */
function makeWriters(db) {
  const insProject = db.prepare(
    `INSERT INTO projects
      (slug, title, summary, project_type, channels, icon_url, color, downloads, follows, license_id, license_name,
       client_side, server_side, published_at, updated_at, weight)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       title=excluded.title, summary=excluded.summary, icon_url=excluded.icon_url,
       color=excluded.color, downloads=excluded.downloads, follows=excluded.follows,
       license_id=excluded.license_id, license_name=excluded.license_name,
       updated_at=excluded.updated_at, weight=excluded.weight,
       channels=excluded.channels,
       updated_row_at=datetime('now')
     RETURNING id`,
  );
  const getSource = db.prepare('SELECT id FROM sources WHERE key = ?');
  const insSourceLink = db.prepare(
    `INSERT INTO project_sources (project_id, source_id, external_id, external_slug, page_url)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, source_id) DO UPDATE SET
       external_id=excluded.external_id, external_slug=excluded.external_slug, page_url=excluded.page_url`,
  );
  const getCat = db.prepare('SELECT id FROM taxonomy_categories WHERE project_type = ? AND name = ?');
  const getFallbackCat = db.prepare('SELECT id FROM taxonomy_categories WHERE name = ? LIMIT 1');
  const insPc = db.prepare('INSERT OR IGNORE INTO project_categories (project_id, category_id) VALUES (?, ?)');
  const getLoader = db.prepare('SELECT id FROM taxonomy_loaders WHERE name = ?');
  const insPl = db.prepare('INSERT OR IGNORE INTO project_loaders (project_id, loader_id) VALUES (?, ?)');
  const getVer = db.prepare('SELECT id FROM taxonomy_game_versions WHERE version = ?');
  const insPgv = db.prepare(
    'INSERT OR IGNORE INTO project_game_versions (project_id, version_id) VALUES (?, ?)',
  );

  const sourceId = getSource.get('modrinth').id;

  return function writeHit(hit, channelType = null) {
    // 频道归属的计算（这里是最关键的一处逻辑）：
    //
    //   Modrinth 的 datapack 不是 project_type，而是 mod 上的标签。
    //   Terralith 这种项目同时是 mod 和 datapack，用单值 project_type 表达不了，
    //   所以用 channels 集合（逗号分隔）来存。
    //
    //   - 基础频道 = 接口给的 project_type
    //   - 如果 categories 含 'datapack'，额外加入 datapack 频道
    //   - 如果调用方指定了 channelType（比如专门抓 datapack），也加进去
    const baseType = hit.project_type || 'mod';
    const set = new Set([baseType]);
    const cats = hit.categories || [];
    const loaders = hit.display_categories?.length ? hit.display_categories : cats;

    // 频道归属的判定依据（实测校准过，写错会导致整个频道为空）：
    //   - datapack 是 **loader**，不是 category。数据包在 Modrinth 上
    //     以 mod 项目 + datapack loader 的形式存在。
    //   - plugin 同样不是 project_type，而是 paper/spigot/bukkit 这类服务端 loader。
    const PLUGIN_LOADERS = ['paper', 'spigot', 'bukkit', 'purpur', 'folia', 'velocity', 'waterfall', 'bungeecord', 'sponge'];
    if (loaders.includes('datapack') || cats.includes('datapack')) set.add('datapack');
    if (loaders.some((c) => PLUGIN_LOADERS.includes(c))) set.add('plugin');
    if (channelType) set.add(channelType);

    const channels = [...set].join(',');
    const projectType = channelType || baseType;
    const pageUrl = `https://modrinth.com/${projectType}/${hit.slug}`;
    const updated = hit.date_modified || null;
    const id = insProject.get(
      hit.slug,
      hit.title,
      hit.description || '',
      projectType,
      channels,
      hit.icon_url || null,
      hit.color ?? null,
      hit.downloads ?? 0,
      hit.follows ?? 0,
      hit.license || null,
      hit.license || null,
      hit.client_side || null,
      hit.server_side || null,
      hit.date_created || null,
      updated,
      computeWeight(hit.downloads, updated, hit.gallery?.length ?? 0),
    ).id;

    insSourceLink.run(id, sourceId, hit.project_id, hit.slug, pageUrl);

    // 分类：datapack 复用 mod 的分类，先用本类型查，查不到再回退
    for (const c of hit.categories || []) {
      const cat =
        getCat.get(projectType, c) || (projectType === 'datapack' ? getCat.get('mod', c) : null);
      if (cat) insPc.run(id, cat.id);
    }
    // 加载器（hit.categories 里混着 loader 名，loaders 字段更准）
    for (const l of hit.display_categories?.length ? hit.display_categories : hit.categories || []) {
      const loader = getLoader.get(l);
      if (loader) insPl.run(id, loader.id);
    }
    // 游戏版本
    for (const v of hit.versions || []) {
      const ver = getVer.get(v);
      if (ver) insPgv.run(id, ver.id);
    }
    return id;
  };
}

/* ============================ 3. 详情补全 ============================ */

/** 从 Markdown 正文里抽图片 */
function bodyImages(body) {
  if (!body) return [];
  const urls = new Set();
  const re = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)|<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi;
  let m;
  while ((m = re.exec(body))) {
    const u = m[1] || m[2];
    if (u && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(u)) urls.add(u);
  }
  return [...urls];
}

function bodyText(body, limit = 900) {
  if (!body) return '';
  return body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<img[^>]*>/gi, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*_>`|]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, limit);
}

function makeDetailWriter(db) {
  const findBySlug = db.prepare('SELECT id FROM projects WHERE slug = ?');
  const upd = db.prepare(
    `UPDATE projects SET
       description=?, source_url=?, issues_url=?, wiki_url=?, discord_url=?,
       license_id=?, license_name=?, featured_gallery=?, gallery_count=?,
       weight=?, updated_row_at=datetime('now')
     WHERE id=?`,
  );
  const delImgs = db.prepare('DELETE FROM project_images WHERE project_id = ?');
  const insImg = db.prepare(
    `INSERT INTO project_images (project_id, url, thumb_url, title, description, position, featured)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  return function writeDetail(p) {
    const row = findBySlug.get(p.slug);
    if (!row) return false;
    const id = row.id;

    // gallery 里 url 是 350 缩略图，raw_url 才是原图——这点必须是 raw_url，
    // 拼接哈希行不通（缩略图和原图哈希不同，实测过）。
    const gallery = (p.gallery || [])
      .filter((g) => g && (g.raw_url || g.url))
      .sort((a, b) => Number(b.featured) - Number(a.featured));

    delImgs.run(id);
    let count = 0;
    for (const [i, g] of gallery.entries()) {
      insImg.run(id, g.raw_url || g.url, g.url || g.raw_url, g.title || '', g.description || '', i, g.featured ? 1 : 0);
      count++;
    }
    if (!count) {
      const bodyImgs = bodyImages(p.body).slice(0, 6);
      for (const [i, u] of bodyImgs.entries()) {
        insImg.run(id, u, u, '', '', i, 0);
        count++;
      }
    }

    const featured = gallery[0]?.url || (count ? null : null);
    upd.run(
      bodyText(p.body),
      p.source_url || null,
      p.issues_url || null,
      p.wiki_url || null,
      p.discord_url || null,
      p.license?.id || null,
      p.license?.name || null,
      featured,
      count,
      computeWeight(p.downloads, p.updated || p.date_modified, count),
      id,
    );
    return true;
  };
}

/* ============================ 主流程 ============================ */

async function crawlType(db, type, { maxProjects = Infinity, withDetails = true } = {}) {
  const writeHit = makeWriters(db);
  const writeDetail = makeDetailWriter(db);
  const checkpointKey = `modrinth:${type}:search`;

  const first = await searchPage(type, 0);
  const total = Math.min(first.total_hits, maxProjects);
  const totalPages = Math.ceil(total / PAGE);

  let startOffset = 0;
  if (RESUME) {
    const cp = getCheckpoint(db, checkpointKey);
    if (cp) startOffset = Number(cp) || 0;
  }

  console.log(
    `\n[${type}] 总数 ${first.total_hits}${maxProjects < Infinity ? `（限制 ${maxProjects}）` : ''}，` +
      `共 ${totalPages} 页，从 offset=${startOffset} 开始`,
  );

  let done = 0;
  const t0 = Date.now();

  // ---- 边搜边补详情 ----
  //
  // 为什么不等搜索完再统一补：
  //   全量 8 万个 mod 搜索要 10+ 分钟，这段时间库里所有项目 gallery_count 都是 0，
  //   前端 requireImages 过滤后几乎无内容可刷（实测只剩 418 条）。
  //   改成「每入库一批就顺手补详情」，库里的可用内容始终在增长。
  //
  // 只给下载量靠前的项目补详情：长尾项目补了也没人刷到，却要付同样请求成本。
  const DETAIL_POOL = [];
  const DETAIL_MIN_DOWNLOADS = 1000;
  let detailCursor = 0;

  async function drainDetails(budget = 200) {
    // 从刚入库的项目里挑高下载量、还没补过详情的
    const rows = db
      .prepare(
        `SELECT slug FROM projects
         WHERE project_type = ? AND gallery_count = 0 AND downloads >= ?
         ORDER BY downloads DESC LIMIT ?`,
      )
      .all(type, DETAIL_MIN_DOWNLOADS, budget);
    const slugs = rows.map((r) => r.slug).filter((s) => !DETAIL_POOL.includes(s));
    if (!slugs.length) return 0;
    DETAIL_POOL.push(...slugs);

    const CHUNK = 100;
    let filled = 0;
    for (let i = 0; i < slugs.length; i += CHUNK) {
      const batch = slugs.slice(i, i + CHUNK);
      try {
        const projects = await api(`/projects?ids=${encodeURIComponent(JSON.stringify(batch))}`);
        tx(db, () => {
          for (const p of projects) if (writeDetail(p)) filled++;
        });
      } catch (e) {
        console.error(`  ! 详情批次失败: ${e.message}`);
      }
      await sleep(80);
    }
    return filled;
  }

  const offsets = [];
  for (let off = startOffset; off < total; off += PAGE) if (off !== 0 && off >= startOffset) offsets.push(off);

  if (startOffset === 0) {
    tx(db, () => {
      for (const h of first.hits) writeHit(h, type);
    });
    done += first.hits.length;
  }

  for (let i = 0; i < offsets.length; i += CONCURRENCY) {
    const chunk = offsets.slice(i, i + CONCURRENCY);
    const pages = await Promise.all(
      chunk.map((off) =>
        searchPage(type, off).catch((e) => {
          console.error(`  ! offset=${off} 失败: ${e.message}`);
          return null;
        }),
      ),
    );

    tx(db, () => {
      for (const pg of pages) {
        if (!pg?.hits) continue;
        for (const h of pg.hits) writeHit(h, type);
        done += pg.hits.length;
      }
    });

    const lastOff = chunk[chunk.length - 1];
    setCheckpoint(db, checkpointKey, Math.min(lastOff + PAGE, total));

  // 每 40 页（约 2000 个项目）补一次详情。
  // 频率过高会抢占搜索带宽：实测每 20 页补一次会把吞吐从 95/s 压到 32/s。
  const DETAIL_EVERY = Number(process.env.DETAIL_EVERY || 40);
  const DETAIL_BATCH = Number(process.env.DETAIL_BATCH || 400);
  if (withDetails && i % (CONCURRENCY * DETAIL_EVERY) === 0) {
    const filled = await drainDetails(DETAIL_BATCH);
    if (filled) process.stdout.write(` [detail +${filled}] `);
  }

    if (i % (CONCURRENCY * 10) === 0 || i + CONCURRENCY >= offsets.length) {
      const elapsed = (Date.now() - t0) / 1000;
      const rate = done / Math.max(elapsed, 1);
      const remain = (total - done) / Math.max(rate, 0.1);
      const withImg = db
        .prepare('SELECT COUNT(*) n FROM projects WHERE project_type = ? AND gallery_count > 0')
        .get(type).n;
      process.stdout.write(
        `\r  [${type}] ${done}/${total} (${((done / total) * 100).toFixed(1)}%) ` +
          `${rate.toFixed(0)}/s 剩余 ${(remain / 60).toFixed(1)}min | 有图 ${withImg}   `,
      );
    }
  }
  process.stdout.write('\n');

  // 收尾：把剩下下载量达标但还没详情的补完
  if (withDetails) {
    let remaining;
    do {
      remaining = db
        .prepare('SELECT COUNT(*) n FROM projects WHERE project_type = ? AND gallery_count = 0 AND downloads >= ?')
        .get(type, DETAIL_MIN_DOWNLOADS).n;
      if (!remaining) break;
      const filled = await drainDetails(500);
      process.stdout.write(`\r  [${type}] 收尾补详情，剩余 ${remaining}，本轮 +${filled}   `);
      if (!filled) break;
    } while (true);
    process.stdout.write('\n');
  }
}

async function main() {
  const db = openDb();
  const t0 = Date.now();

  // 索引与触发器在批量插入时会拖慢速度，抓取前先丢掉非必要索引
  if (has('--all') || has('--fast')) {
    db.exec('PRAGMA cache_size = -200000');
    db.exec('PRAGMA mmap_size = 500000000');
  }

  await syncTaxonomy(db);

  if (has('--taxonomy') && !has('--all')) {
    console.log('只同步分类体系，结束。');
    return;
  }

  let types = ALL_TYPES;
  if (val('--type')) types = [val('--type')];
  const limit = Number(val('--limit', String(has('--all') ? Infinity : 500)));

  for (const type of types) {
    await crawlType(db, type, {
      maxProjects: limit,
      withDetails: WITH_DETAILS && limit > 0,
    });
  }

  db.exec('ANALYZE');

  const s = db.prepare('SELECT COUNT(*) n FROM projects').get().n;
  const imgs = db.prepare('SELECT COUNT(*) n FROM project_images').get().n;
  console.log(
    `\n完成：${s} 个项目 / ${imgs} 张截图，耗时 ${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分钟`,
  );
}

main().catch((err) => {
  console.error('抓取失败:', err);
  process.exitCode = 1;
});
