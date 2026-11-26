/**
 * 图片缓存预热
 *
 * 为什么要预热：
 *   缩略图代理首次请求需要「下载原图 → 缩放 → 落盘」，单张约 300~800ms。
 *   刷流时用户第一次滑到某张卡，就要等这一次。
 *   提前把高权重内容的缩略图跑一遍，用户刷到时直接命中缓存（1~5ms）。
 *
 * 用法:
 *   node scripts/warm-images.mjs              # 预热前 5000 个热门项目的首图
 *   node scripts/warm-images.mjs --limit 20000
 *   node scripts/warm-images.mjs --concurrency 8
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.mjs';
import { getThumb } from '../server/imgproxy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const LIMIT = Number(val('--limit', '5000'));
const CONCURRENCY = Number(val('--concurrency', '6'));

async function main() {
  const db = openDb();

  // 只预热「首图」：用户第一眼看到的就是它，边际收益最高
  const rows = db
    .prepare(
      `SELECT i.thumb_url AS thumb, i.url, p.weight
       FROM project_images i
       JOIN projects p ON p.id = i.project_id
       WHERE i.position = 0 AND p.gallery_count > 0
       ORDER BY p.weight DESC
       LIMIT ?`,
    )
    .all(LIMIT);

  // 只处理 modrinth 图源（代理才管这些）
  const targets = rows
    .map((r) => (r.thumb && r.thumb !== r.url ? r.thumb : r.url))
    .filter((u) => {
      try {
        return new URL(u).hostname === 'cdn.modrinth.com';
      } catch {
        return false;
      }
    });

  console.log(`预热 ${targets.length} 张缩略图（并发 ${CONCURRENCY}）…`);

  let done = 0;
  let hit = 0;
  let miss = 0;
  let fail = 0;
  const t0 = Date.now();

  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const u = targets[cursor++];
      try {
        const r = await getThumb(u, 640);
        if (r.cache === 'hit') hit++;
        else miss++;
      } catch {
        fail++;
      }
      done++;
      if (done % 50 === 0 || done === targets.length) {
        const el = (Date.now() - t0) / 1000;
        const rate = done / Math.max(el, 1);
        const remain = (targets.length - done) / Math.max(rate, 0.1);
        process.stdout.write(
          `\r  ${done}/${targets.length} (${((done / targets.length) * 100).toFixed(1)}%) ` +
            `命中 ${hit} 新增 ${miss} 失败 ${fail} | ${rate.toFixed(0)}/s 剩余 ${(remain / 60).toFixed(1)}min   `,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write('\n');
  console.log(
    `完成：命中 ${hit}，新生成 ${miss}，失败 ${fail}，耗时 ${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分钟`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
