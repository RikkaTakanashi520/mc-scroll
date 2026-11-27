/**
 * 静态导出：把 SQLite 数据变成 GitHub/Cloudflare Pages 能直接托管的文件
 *
 * 为什么需要这一步：
 *   GitHub Pages / Cloudflare Pages 只能托管静态文件，跑不了 Node 服务，
 *   所以 SQLite + /api/feed + /api/img 三样都得换成静态方案。
 *
 * 设计要点：
 *   1. **分片 + 按权重排序**：第一片是热门内容，约 400KB，
 *      加载完立刻能刷；剩下的后台慢慢加载，加载完才启用完整筛选。
 *   2. **brotli 预压缩**：实测主表 gzip 4.77MB / brotli 3.16MB，省 34%。
 *      Cloudflare Pages 会自动选择 .br 文件，GitHub Pages 不认但没有副作用。
 *   3. **图片直连 CDN**：实测 Modrinth CDN 允许跨域（CORS: *）、缓存 31 天，
 *      不需要代理。这是省钱的关键——图片流量不走自己的额度。
 *   4. **正文单独分片**：14.9MB 是最大头，但用户只在点「关于」时才需要，
 *      绝不能进首屏。
 *
 * 用法:
 *   node scripts/build-static.mjs                 # 导出到 dist/
 *   node scripts/build-static.mjs --out docs      # 自定义输出目录
 */
import { brotliCompressSync, constants } from 'node:zlib';
import { mkdir, writeFile, rm, copyFile, readdir, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const OUT = path.resolve(ROOT, val('--out', 'dist'));

/** 每片多少条项目 */
const SHARD = 4000;

/**
 * 首片单独小一些。
 *
 * 实测：4000 条一片 brotli 825KB，首屏等这么久不划算。
 * 改成 600 条（约 130KB），首屏 0.3 秒就能开刷，
 * 剩下的分片在后台继续加载，加载完才开放完整筛选和搜索。
 */
const HOT_SHARD = 600;

/** 正文分片更小，因为只有点开详情才加载 */
const DESC_SHARD = 2000;

const br = (buf) => brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
const kb = (n) => (n / 1024).toFixed(0) + ' KB';

/** 写一个文件，同时写 .br 版本 */
async function writeFileBr(file, data) {
  await writeFile(file, data);
  const compressed = br(Buffer.from(data));
  await writeFile(file + '.br', compressed);
  return { raw: Buffer.byteLength(data), br: compressed.length };
}

async function main() {
  const t0 = Date.now();
  const db = openDb();

  console.log(`导出到 ${OUT}`);
  await rm(OUT, { recursive: true, force: true });
  await mkdir(path.join(OUT, 'data'), { recursive: true });
  await mkdir(path.join(OUT, 'data', 'desc'), { recursive: true });

  // ============ 1. 主表 ============
  //
  // 排序用 weight（= log10(downloads+10)）降序，让第一片就是热门内容。
  // 这样首屏只需要加载片 0 就能刷，不用等全量。
  const rows = db
    .prepare(
      `SELECT id, slug, title, summary_zh, summary, project_type, channels,
              color, downloads, license_id, gallery_count, weight, updated_at
       FROM projects
       WHERE gallery_count > 0
       ORDER BY weight DESC, id ASC`,
    )
    .all();

  console.log(`\n可刷项目 ${rows.length} 条`);

  // ============ 2. 关联数据 ============
  const idSet = new Set(rows.map((r) => r.id));
  const idToSlug = new Map(rows.map((r) => [r.id, r.slug]));

  const cats = db
    .prepare(
      `SELECT pc.project_id pid, c.name FROM project_categories pc
       JOIN taxonomy_categories c ON c.id = pc.category_id`,
    )
    .all();
  const loaders = db
    .prepare(
      `SELECT pl.project_id pid, l.name FROM project_loaders pl
       JOIN taxonomy_loaders l ON l.id = pl.loader_id`,
    )
    .all();
  const vers = db
    .prepare(
      `SELECT pv.project_id pid, v.version FROM project_game_versions pv
       JOIN taxonomy_game_versions v ON v.id = pv.version_id`,
    )
    .all();
  const imgs = db
    .prepare(
      `SELECT project_id pid, thumb_url FROM project_images
       ORDER BY project_id, position`,
    )
    .all();

  const group = (list, key) => {
    const m = new Map();
    for (const it of list) {
      if (!idSet.has(it.pid)) continue;
      if (!m.has(it.pid)) m.set(it.pid, []);
      m.get(it.pid).push(it[key]);
    }
    return m;
  };
  const catOf = group(cats, 'name');
  const loadOf = group(loaders, 'name');
  const verOf = group(vers, 'version');

  // 截图只留 CDN 路径后缀，前缀统一由前端拼
  // 例：AANobbMI/images/xxx_350.webp
  const imgOf = new Map();
  for (const im of imgs) {
    if (!idSet.has(im.pid)) continue;
    const u = im.thumb_url || '';
    const i = u.indexOf('/data/');
    if (i < 0) continue;
    if (!imgOf.has(im.pid)) imgOf.set(im.pid, []);
    imgOf.get(im.pid).push(u.slice(i + 6));
  }

  // ============ 3. 主表分片 ============
  //
  // 字段用数组而不是对象：键名完全省掉，实测省 25% 体积。
  // 顺序：slug, title, summary, type, channels, color, downloads,
  //       license, galleryCount, categories, loaders, versions, images
  const shards = [];
  let shardBytes = 0;
  let shardBrBytes = 0;

  // 首片小、后续片大：首屏只需要 p00 就能开刷
  let cursor2 = 0;
  let firstShard = true;
  while (cursor2 < rows.length) {
    const size = firstShard ? HOT_SHARD : SHARD;
    const slice = rows.slice(cursor2, cursor2 + size).map((r) => [
      r.slug,
      r.title,
      r.summary_zh || r.summary || '',
      r.project_type,
      r.channels || '',
      r.color,
      r.downloads,
      r.license_id || '',
      r.gallery_count,
      catOf.get(r.id) || [],
      loadOf.get(r.id) || [],
      verOf.get(r.id) || [],
      imgOf.get(r.id) || [],
    ]);
    cursor2 += size;
    const n = shards.length;
    const name = `p${String(n).padStart(2, '0')}.json`;
    const res = await writeFileBr(path.join(OUT, 'data', name), JSON.stringify(slice));
    shardBytes += res.raw;
    shardBrBytes += res.br;
    shards.push({ file: name, count: slice.length, br: res.br });
    if (n === 0) console.log(`  首片 ${slice.length} 条，${kb(res.br)}（首屏只等这个）`);
    firstShard = false;
    if (n % 5 === 0) process.stdout.write(`\r  主表分片 ${n + 1} ...`);
  }
  console.log(`\r  主表 ${shards.length} 片，原始 ${kb(shardBytes)} → brotli ${(shardBrBytes / 1024 / 1024).toFixed(2)} MB`);

  // ============ 4. 正文分片 ============
  //
  // 正文 14.9MB 是最大头，但只有用户点「关于」时才需要。
  // 按 slug 哈希取模分成 64 份，前端按 slug 算出该拉哪一份。
  const descRows = db
    .prepare(
      `SELECT slug, description_zh, description FROM projects WHERE gallery_count > 0`,
    )
    .all();
  const DESC_PARTS = 64;
  const descBuckets = Array.from({ length: DESC_PARTS }, () => ({}));
  const hashSlug = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % DESC_PARTS;
  };
  for (const r of descRows) {
    const text = (r.description_zh || r.description || '').slice(0, 1200);
    if (!text) continue;
    descBuckets[hashSlug(r.slug)][r.slug] = text;
  }
  let descBytes = 0;
  for (let i = 0; i < DESC_PARTS; i++) {
    const file = path.join(OUT, 'data', 'desc', `d${String(i).padStart(2, '0')}.json`);
    const res = await writeFileBr(file, JSON.stringify(descBuckets[i]));
    descBytes += res.br;
  }
  console.log(`  正文 ${DESC_PARTS} 片，brotli ${(descBytes / 1024 / 1024).toFixed(2)} MB`);

  // ============ 5. 分类体系 ============
  //
  // 必须和服务端 /api/taxonomy 的结构完全一致，否则前端渲染侧栏会报错
  // （踩过：loaders 少了 types 字段，renderSidebar 里 l.types.some 直接抛）。
  const taxCategories = db
    .prepare(
      `SELECT project_type AS projectType, name, header, display_name AS displayName,
              icon_url AS icon
       FROM taxonomy_categories ORDER BY project_type, header, name`,
    )
    .all();
  const taxLoaders = db
    .prepare(
      `SELECT l.name, l.display_name AS displayName, GROUP_CONCAT(lt.project_type) AS types
       FROM taxonomy_loaders l
       LEFT JOIN taxonomy_loader_types lt ON lt.loader_id = l.id
       GROUP BY l.id ORDER BY l.name`,
    )
    .all()
    .map((l) => ({ ...l, types: l.types ? l.types.split(',') : [] }));
  const taxVersions = db
    .prepare(
      `SELECT version, version_type AS versionType, released_at AS releasedAt, major
       FROM taxonomy_game_versions ORDER BY released_at DESC`,
    )
    .all();

  const taxonomy = {
    categories: taxCategories,
    loaders: taxLoaders,
    gameVersions: taxVersions,
    projectTypes: [...new Set(taxCategories.map((c) => c.projectType))],
  };
  await writeFileBr(path.join(OUT, 'data', 'taxonomy.json'), JSON.stringify(taxonomy));
  console.log(`  分类体系 ${taxonomy.categories.length} 分类 / ${taxonomy.loaders.length} 加载器 / ${taxonomy.gameVersions.length} 版本`);

  // ============ 6. 清单 ============
  const manifest = {
    version: 1,
    builtAt: new Date().toISOString(),
    total: rows.length,
    shardSize: SHARD,
    shards: shards.map((s) => s.file),
    descParts: DESC_PARTS,
    // 第一片是热门内容，首屏只等它
    firstShardCount: shards[0]?.count || 0,
    // 每个项目的「随机权重」用 weight 字段，前端要复刻加权采样
    stats: {
      projects: rows.length,
      images: imgs.length,
    },
  };
  await writeFileBr(path.join(OUT, 'data', 'manifest.json'), JSON.stringify(manifest));

  // ============ 7. 复制前端 ============
  //
  // 关键是往 index.html 注入 window.__MC_STATIC__ = true，
  // 前端读到这个标记就切到静态数据源，不再请求 /api/*。
  // 同一份 app.js 因此既能连后端也能跑静态，不用维护两个分支。
  const pub = path.join(ROOT, 'public');
  for (const f of await readdir(pub, { withFileTypes: true })) {
    if (f.isDirectory()) {
      await copyDir(path.join(pub, f.name), path.join(OUT, f.name));
    } else if (f.name === 'index.html') {
      let html = await readFile(path.join(pub, f.name), 'utf8');
      // 必须插在 app.js 之前
      html = html.replace(
        /<script type="module" src="\.?\/js\/app\.js"><\/script>/,
        '<script>window.__MC_STATIC__ = true;</script>\n    <script type="module" src="./js/app.js"></script>',
      );
      await writeFile(path.join(OUT, f.name), html);
    } else {
      await copyFile(path.join(pub, f.name), path.join(OUT, f.name));
    }
  }

  // ============ 8. 统计 ============
  let files = 0;
  let total = 0;
  const walk = async (dir) => {
    for (const f of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) await walk(p);
      else {
        files++;
        total += (await stat(p)).size;
      }
    }
  };
  await walk(OUT);

  console.log(`\n完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  ${files} 个文件，总计 ${(total / 1024 / 1024).toFixed(1)} MB（含 .br）`);
  console.log(`  首屏只需：manifest + taxiny + p00 ≈ ${kb(shardBrBytes / shards.length)}`);
  console.log(`\n本地预览:  node scripts/serve-static.mjs`);
}

async function copyDir(src, dst) {
  await mkdir(dst, { recursive: true });
  for (const f of await readdir(src, { withFileTypes: true })) {
    const s = path.join(src, f.name);
    const d = path.join(dst, f.name);
    if (f.isDirectory()) await copyDir(s, d);
    else await copyFile(s, d);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
