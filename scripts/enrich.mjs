/**
 * 补详情：把已入库但还没截图的项目的 gallery/正文补齐。
 *
 * 为什么需要单独一步：
 *   抓取阶段为了吞吐只给高下载量项目补了详情，长尾项目全部是「有记录、无截图」。
 *   前端 requireImages 过滤后这些项目刷不出来，等于白抓。
 *
 * 用法:
 *   node scripts/enrich.mjs                    # 补下载量 ≥1000 的（默认）
 *   node scripts/enrich.mjs --min-downloads 0  # 全补（很慢，几十万次请求）
 *   node scripts/enrich.mjs --type modpack     # 只补某个类型
 *   node scripts/enrich.mjs --dry-run          # 只看有多少待补
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, tx } from '../server/db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://api.modrinth.com/v2';
const UA = 'mc-scroll/0.1 (detail enricher)';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const MIN_DOWNLOADS = Number(val('--min-downloads', '1000'));
const TYPE = val('--type', null);
const CONCURRENCY = Number(val('--concurrency', '4'));
const CHUNK = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, { retries = 5 } = {}) {
  const url = pathname.startsWith('http') ? pathname : BASE + pathname;
  let lastErr;
  for (let a = 0; a < retries; a++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(90_000),
      });
      if (res.status === 429) {
        await sleep(Math.min(Number(res.headers.get('x-ratelimit-reset') || 5) * 1000 + 500, 30_000));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(800 * (a + 1));
    }
  }
  throw lastErr;
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

async function main() {
  const db = openDb();

  const where = ['enriched = 0', 'downloads >= ?'];
  const binds = [MIN_DOWNLOADS];
  if (TYPE) {
    where.push('project_type = ?');
    binds.push(TYPE);
  }

  const total = db.prepare(`SELECT COUNT(*) n FROM projects WHERE ${where.join(' AND ')}`).get(...binds).n;
  console.log(`待补详情: ${total} 个项目（下载量 ≥ ${MIN_DOWNLOADS}${TYPE ? `，类型 ${TYPE}` : ''}）`);
  if (has('--dry-run')) {
    const byType = db
      .prepare(`SELECT project_type t, COUNT(*) n FROM projects WHERE ${where.join(' AND ')} GROUP BY project_type`)
      .all(...binds);
    for (const r of byType) console.log(`  ${r.t.padEnd(22)} ${r.n}`);
    return;
  }
  if (!total) return;

  const upd = db.prepare(
    `UPDATE projects SET
       description=?, source_url=?, issues_url=?, wiki_url=?, discord_url=?,
       license_id=?, license_name=?, gallery_count=?, weight=?, enriched=1,
       updated_row_at=datetime('now')
     WHERE id=?`,
  );
  const delImgs = db.prepare('DELETE FROM project_images WHERE project_id = ?');
  const insImg = db.prepare(
    `INSERT INTO project_images (project_id, url, thumb_url, title, description, position, featured)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const findId = db.prepare('SELECT id, downloads, updated_at FROM projects WHERE slug = ?');

  const seen = new Set();
  let done = 0;
  let withImages = 0;
  const t0 = Date.now();

  async function worker() {
    while (true) {
      // 先原子地把这批标记成「处理中」(enriched=2)，再取 slug。
      // 不这样做的话 5 个 worker 会同时查到同一批 enriched=0 的记录，
      // 同一批被反复下载、反复计数（实测进度会跑到 172%）。
      const claimed = tx(db, () => {
        const rows = db
          .prepare(
            `SELECT id, slug FROM projects WHERE ${where.join(' AND ')}
             ORDER BY downloads DESC LIMIT ?`,
          )
          .all(...binds, CHUNK);
        if (!rows.length) return [];
        const mark = db.prepare('UPDATE projects SET enriched = 2 WHERE id = ?');
        for (const r of rows) mark.run(r.id);
        return rows.map((r) => r.slug);
      });

      const batch = claimed;

      if (!batch.length) return;
      batch.forEach((s) => seen.add(s));

      let projects;
      try {
        projects = await api(`/projects?ids=${encodeURIComponent(JSON.stringify(batch))}`);
      } catch (e) {
        console.error(`\n  ! 批次失败: ${e.message}`);
        // 还原占位，让这批下次还能被领到
        tx(db, () => {
          const reset = db.prepare("UPDATE projects SET enriched = 0 WHERE enriched = 2 AND slug = ?");
          for (const s of batch) reset.run(s);
        });
        continue;
      }

      tx(db, () => {
        for (const p of projects) {
          const row = findId.get(p.slug);
          if (!row) continue;
          const gallery = (p.gallery || [])
            .filter((g) => g && (g.raw_url || g.url))
            .sort((a, b) => Number(b.featured) - Number(a.featured));

          delImgs.run(row.id);
          let count = 0;
          for (const [i, g] of gallery.entries()) {
            insImg.run(row.id, g.raw_url || g.url, g.url || g.raw_url, g.title || '', g.description || '', i, g.featured ? 1 : 0);
            count++;
          }
          if (!count) {
            for (const [i, u] of bodyImages(p.body).slice(0, 6).entries()) {
              insImg.run(row.id, u, u, '', '', i, 0);
              count++;
            }
          }

          upd.run(
            bodyText(p.body),
            p.source_url || null,
            p.issues_url || null,
            p.wiki_url || null,
            p.discord_url || null,
            p.license?.id || null,
            p.license?.name || null,
            count,
            computeWeight(p.downloads, p.updated || p.date_modified, count),
            row.id,
          );
          if (count > 0) withImages++;
        }
      });

      done += batch.length;
      const elapsed = (Date.now() - t0) / 1000;
      const rate = done / Math.max(elapsed, 1);
      const remain = (total - done) / Math.max(rate, 0.1);
      process.stdout.write(
        `\r  补详情 ${done}/${total} (${((done / total) * 100).toFixed(1)}%) ` +
          `${rate.toFixed(0)}/s 剩余 ${(remain / 60).toFixed(1)}min | 新增有图 ${withImages}   `,
      );
      await sleep(60);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write('\n');

  db.exec('ANALYZE');
  const final = db.prepare('SELECT COUNT(*) n FROM projects WHERE gallery_count > 0').get().n;
  console.log(`完成：本次处理 ${done} 个，新增有图 ${withImages}，当前全库有图 ${final} 个`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
