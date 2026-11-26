/**
 * 构建刷流采样索引表 feed_index
 *
 * 为什么需要它：
 *   刷流要「在全库里随机取一页」。如果直接用
 *     SELECT ... ORDER BY id LIMIT 1 OFFSET <随机数>
 *   SQLite 必须顺序跳过前面 n 行。实测 offset=50000 时单次 74ms，
 *   一页 25 条就要 1800ms —— 完全不可用。
 *
 *   这张表把「所有可刷项目」连续编号成 0..N-1，
 *   随机取一行 = 对 seq 主键做等值查找 = 0.002ms。
 *
 * 何时需要重跑：
 *   抓取新数据、补完详情（gallery_count 变了）之后。
 *
 * 用法: node scripts/build-feed-index.mjs
 */
import { openDb, tx } from '../server/db.mjs';

function main() {
  const db = openDb();
  const t0 = Date.now();

  const before = db.prepare('SELECT COUNT(*) n FROM projects WHERE gallery_count > 0').get().n;
  console.log(`可刷项目: ${before} 个`);

  tx(db, () => {
    db.exec('DROP TABLE IF EXISTS feed_index');
    db.exec(`
      CREATE TABLE feed_index (
        seq        INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        type       TEXT NOT NULL
      )
    `);
    // ROW_NUMBER() 从 1 开始，减 1 变成 0 基，方便 Math.floor(rng()*N)
    db.exec(`
      INSERT INTO feed_index (seq, project_id, type)
      SELECT (ROW_NUMBER() OVER (ORDER BY id)) - 1, id, project_type
      FROM projects
      WHERE gallery_count > 0
    `);
    db.exec('CREATE INDEX idx_feed_index_pid ON feed_index(project_id)');
  });

  const after = db.prepare('SELECT COUNT(*) n FROM feed_index').get().n;

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
    // 这里只能用 project_type（主类型）。datapack/plugin 是叠加频道，
    // 用 channels 过滤会在查询时加开销，先用主类型保证速度，前端仍可二次筛选。
    db.exec(`
      INSERT INTO feed_index_by_type (type, seq, project_id)
      SELECT type, (ROW_NUMBER() OVER (PARTITION BY type ORDER BY project_id)) - 1, project_id
      FROM feed_index
    `);
  });

  console.log(
    `完成：${after} 行，耗时 ${Date.now() - t0}ms\n` +
      `按类型: ${db
        .prepare('SELECT type, COUNT(*) n FROM feed_index_by_type GROUP BY type ORDER BY n DESC')
        .all()
        .map((r) => `${r.type}=${r.n}`)
        .join(', ')}`,
  );
}

main();
