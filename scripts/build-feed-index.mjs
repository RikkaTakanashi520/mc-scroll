/**
 * 构建刷流采样索引表 feed_index
 *
 * 为什么需要它：
 *   刷流要「在全库里随机取一页」。直接用 ORDER BY id LIMIT 1 OFFSET <随机数>
 *   时 SQLite 必须顺序跳过前面 n 行，实测 offset=50000 单次 74ms，
 *   一页 25 条要 1800ms，不可用。
 *
 *   这张表把所有项目连续编号成 0..N-1，
 *   随机取一行 = 对 seq 主键等值查找 = 0.002ms。
 *
 * 收录范围：**全部项目**，不再只收有截图的。
 *   97,252 个项目没有截图（占 57%），其中包含 Fabric API、Lithium
 *   这类基础库——它们作者本来就不传截图，但不该在刷流里消失。
 *   是否过滤交给查询时的 requireImages 参数控制。
 *
 * 何时需要重跑：
 *   抓取新数据、补完详情之后。
 *
 * 用法: node scripts/build-feed-index.mjs
 */
import { openDb, tx } from '../server/db.mjs';

function main() {
  const db = openDb();
  const t0 = Date.now();

  const total = db.prepare('SELECT COUNT(*) n FROM projects').get().n;
  const withImg = db.prepare('SELECT COUNT(*) n FROM projects WHERE gallery_count > 0').get().n;
  console.log(`全部项目: ${total} 个（有截图 ${withImg}，无截图 ${total - withImg}）`);

  tx(db, () => {
    db.exec('DROP TABLE IF EXISTS feed_index');
    db.exec(`
      CREATE TABLE feed_index (
        seq        INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        type       TEXT NOT NULL,
        has_img    INTEGER NOT NULL DEFAULT 0
      )
    `);
    // has_img 判定「有**可用**的图」，不是简单的 gallery_count > 0。
    //
    // 踩过的坑：有 4,687 个项目的图片全部托管在 bisecthosting / imgur 这类外链，
    // 而 pickThumbUrl 只保留 cdn.modrinth.com（外链实测 8~10 秒超时）。
    // 只判 gallery_count 的话，这些项目会被当成「有图」放进索引，
    // 结果刷出来是一张空白占位卡 —— 用户看到的就是「明明筛选了只看有图，还是有空卡」。
    db.exec(`
      INSERT INTO feed_index (seq, project_id, type, has_img)
      SELECT
        (ROW_NUMBER() OVER (ORDER BY p.id)) - 1,
        p.id,
        p.project_type,
        CASE WHEN EXISTS (
          SELECT 1 FROM project_images i
          WHERE i.project_id = p.id
            AND i.thumb_url LIKE 'https://cdn.modrinth.com/%'
        ) THEN 1 ELSE 0 END
      FROM projects p
    `);
    db.exec('CREATE INDEX idx_feed_index_pid ON feed_index(project_id)');
    // 只刷有图时按这个索引取，避免全表扫
    db.exec('CREATE INDEX idx_feed_index_img ON feed_index(has_img)');
  });

  const after = db.prepare('SELECT COUNT(*) n FROM feed_index').get().n;

  // 只刷有截图时用这张表：连续编号、等值查找，避免在全量索引里反复拒绝采样
  tx(db, () => {
    db.exec('DROP TABLE IF EXISTS feed_index_img');
    db.exec(`
      CREATE TABLE feed_index_img (
        seq        INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL
      )
    `);
    db.exec(`
      INSERT INTO feed_index_img (seq, project_id)
      SELECT (ROW_NUMBER() OVER (ORDER BY project_id)) - 1, project_id
      FROM feed_index
      WHERE has_img = 1
    `);
  });

  // 顺便按类型建分组统计，供「按频道随机」用
  tx(db, () => {
    db.exec('DROP TABLE IF EXISTS feed_index_by_type');
    db.exec(`
      CREATE TABLE feed_index_by_type (
        type TEXT NOT NULL,
        seq  INTEGER NOT NULL,
        project_id INTEGER NOT NULL,
        PRIMARY KEY (type, seq)
      )
    `);
    db.exec(`
      INSERT INTO feed_index_by_type (type, seq, project_id)
      SELECT type, (ROW_NUMBER() OVER (PARTITION BY type ORDER BY project_id)) - 1, project_id
      FROM feed_index
    `);
  });

  const withImgAfter = db.prepare('SELECT COUNT(*) n FROM feed_index_img').get().n;
  console.log(
    `完成：全量 ${after} 行（有图 ${withImgAfter}），耗时 ${Date.now() - t0}ms\n` +
      `按类型: ${db
        .prepare('SELECT type, COUNT(*) n FROM feed_index_by_type GROUP BY type ORDER BY n DESC')
        .all()
        .map((r) => `${r.type}=${r.n}`)
        .join(', ')}`,
  );
}

main();
