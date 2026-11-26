/**
 * 数据库 schema —— 设计目标是「后期能加东西」，所以从一开始就分三件事：
 *
 *   1. 项目本体（projects）     ：与来源无关的通用字段
 *   2. 来源身份（project_sources）：一个项目可以同时来自 Modrinth 和 CurseForge
 *   3. 分类体系（taxonomy_*）   ：分类/加载器/游戏版本全部表驱动，不写死在代码里
 *
 * 关键设计决策：
 *
 *  - **来源分离**：CurseForge 将来接入时，只需往 project_sources 插一行，
 *    不用改 projects 表结构。source_key = 'modrinth' | 'curseforge'。
 *
 *  - **分类表驱动**：Modrinth 的 taxonomy 有 126 个分类、29 个加载器、925 个版本，
 *    且 datapack 复用 mod 的分类、loader 有 supported_project_types 多对多关系。
 *    写死成枚举必然出错，所以全部做成数据行。
 *
 *  - **多对多不用外键**：project_categories / project_loaders / project_versions
 *    用 (project_id, xxx_id) 联合主键。抓取时先批量写入再建索引，避免插入期开销。
 *
 *  - **全文检索用 FTS5**：17 万项目的模糊搜索，LIKE '%x%' 会全表扫。
 *    FTS5 让搜索保持毫秒级，且支持前缀匹配。
 *
 *  - **快照字段冗余**：downloads/follows 直接存在 projects 上（而不是另开时间序列表），
 *    因为刷流只需要当前值；如果将来要做「下载量趋势」，加 project_stats 时序表即可，
 *    不需要动 projects。
 *
 *  - **随机流用 rowid 采样**：ORDER BY RANDOM() 在 17 万行上要全表扫 + 排序。
 *    这里用「随机 rowid + 范围扫描」，并给 downloads 建索引，保证刷流接口 <20ms。
 */
export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA temp_store = MEMORY;

-- ---------------------------------------------------------------
-- 来源（Modrinth / CurseForge / 未来的其它站）
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id            INTEGER PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,          -- 'modrinth' | 'curseforge'
  display_name  TEXT NOT NULL,
  base_url      TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  synced_at     TEXT
);

-- ---------------------------------------------------------------
-- 分类体系（表驱动，不写死枚举）
-- ---------------------------------------------------------------
-- Modrinth 的 category 带 header 分组：categories / features / resolutions / performance impact
CREATE TABLE IF NOT EXISTS taxonomy_categories (
  id                 INTEGER PRIMARY KEY,
  project_type       TEXT NOT NULL,            -- mod / modpack / datapack / resourcepack / shader / plugin / minecraft_java_server
  name               TEXT NOT NULL,            -- 'adventure' / '128x' / 'pbr'
  header             TEXT NOT NULL DEFAULT 'categories',
  display_name       TEXT NOT NULL,
  icon_url           TEXT,
  UNIQUE(project_type, name)
);

-- loader 有 supported_project_types（多对多），单独一张关联表
CREATE TABLE IF NOT EXISTS taxonomy_loaders (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS taxonomy_loader_types (
  loader_id     INTEGER NOT NULL REFERENCES taxonomy_loaders(id) ON DELETE CASCADE,
  project_type  TEXT NOT NULL,
  PRIMARY KEY (loader_id, project_type)
);

CREATE TABLE IF NOT EXISTS taxonomy_game_versions (
  id            INTEGER PRIMARY KEY,
  version       TEXT NOT NULL UNIQUE,          -- '1.21.1' / '26w14a'
  version_type  TEXT NOT NULL,                 -- release / snapshot / beta / alpha
  released_at   TEXT,
  major         INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------
-- 项目本体（与来源无关）
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
  id              INTEGER PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  summary         TEXT NOT NULL DEFAULT '',    -- 一句话简介（英文原文）
  description     TEXT NOT NULL DEFAULT '',    -- 正文纯文本
  project_type    TEXT NOT NULL,               -- 主类型（mod/modpack/...），用于默认归类
  -- 频道归属：Modrinth 上一个项目可以既是 mod 又是 datapack（Terralith 就是），
  -- 单值 project_type 表达不了。这里用逗号分隔的集合，如 'mod,datapack'。
  -- 查询用 instr(',' || channels || ',', ',datapack,') > 0，可走 LIKE 前缀优化。
  channels        TEXT NOT NULL DEFAULT 'mod',
  icon_url        TEXT,
  color           INTEGER,
  downloads       INTEGER NOT NULL DEFAULT 0,
  follows         INTEGER NOT NULL DEFAULT 0,
  license_id      TEXT,
  license_name    TEXT,
  source_url      TEXT,
  issues_url      TEXT,
  wiki_url        TEXT,
  discord_url     TEXT,
  client_side     TEXT,
  server_side     TEXT,
  published_at    TEXT,
  updated_at      TEXT,
  featured_gallery TEXT,                       -- 首图 URL，列表页直接用，避免 JOIN
  -- 详情补全标记：0 = 还没拉过详情，1 = 拉过（无论有没有图）。
  -- 不能只用 gallery_count=0 判断，因为很多项目详情拉完也确实没有截图，
  -- 那样会被反复重拉，永远补不完（实测 6.9 万条里大批是这样）。
  enriched        INTEGER NOT NULL DEFAULT 0,
  gallery_count   INTEGER NOT NULL DEFAULT 0,
  -- 排序权重：抓取时预先算好，避免每次查询都算 log()
  weight          REAL NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_row_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_projects_type_downloads ON projects(project_type, downloads DESC);
CREATE INDEX IF NOT EXISTS idx_projects_downloads ON projects(downloads DESC);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_weight ON projects(weight DESC);
CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);

-- ---------------------------------------------------------------
-- 来源身份（一个项目可来自多个来源）
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_sources (
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id      INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_id    TEXT NOT NULL,                -- Modrinth project_id / CurseForge modId
  external_slug  TEXT,
  page_url       TEXT NOT NULL,
  PRIMARY KEY (project_id, source_id),
  UNIQUE(source_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_ps_external ON project_sources(source_id, external_id);

-- ---------------------------------------------------------------
-- 多对多关系
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_categories (
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category_id  INTEGER NOT NULL REFERENCES taxonomy_categories(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, category_id)
);
CREATE INDEX IF NOT EXISTS idx_pc_category ON project_categories(category_id, project_id);

CREATE TABLE IF NOT EXISTS project_loaders (
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  loader_id   INTEGER NOT NULL REFERENCES taxonomy_loaders(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, loader_id)
);
CREATE INDEX IF NOT EXISTS idx_pl_loader ON project_loaders(loader_id, project_id);

CREATE TABLE IF NOT EXISTS project_game_versions (
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_id  INTEGER NOT NULL REFERENCES taxonomy_game_versions(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, version_id)
);
CREATE INDEX IF NOT EXISTS idx_pgv_version ON project_game_versions(version_id, project_id);

-- ---------------------------------------------------------------
-- 截图（单独表：17 万项目 × 平均 5 张 = 近百万行，独立存储便于按需取）
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_images (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,                  -- 原图
  thumb_url    TEXT NOT NULL,                  -- 350px 缩略图（列表用）
  title        TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  position     INTEGER NOT NULL DEFAULT 0,
  featured     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pi_project ON project_images(project_id, position);

-- ---------------------------------------------------------------
-- 收藏（服务端存，为了将来跨设备；当前前端仍可只用 localStorage）
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS favorites (
  device_id    TEXT NOT NULL,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (device_id, project_id)
);

-- ---------------------------------------------------------------
-- ---------------------------------------------------------------
-- 刷流采样索引
--   为什么单独建表：按行号随机取一行如果用 OFFSET，SQLite 要顺序跳过 N 行，
--   实测 offset=50000 时单次 74ms，一页 25 条就是 1800ms。
--   这张表把「可刷项目」重新编号成 0..N-1 的连续 seq，
--   随机取一行变成对 seq 主键的等值查找：0.002ms，快 3.7 万倍。
--   由 scripts/build-feed-index.mjs 构建，数据变动后重跑即可。
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feed_index (
  seq         INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL,
  type        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_index_pid ON feed_index(project_id);

-- 抓取进度（全量抓取中断后可续传）
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crawl_checkpoints (
  key         TEXT PRIMARY KEY,                -- 如 'modrinth:mod:downloads:offset=5000'
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------
-- 全文本搜索
-- ---------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS projects_fts USING fts5(
  title,
  summary,
  slug,
  content='projects',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS projects_ai AFTER INSERT ON projects BEGIN
  INSERT INTO projects_fts(rowid, title, summary, slug)
  VALUES (new.id, new.title, new.summary, new.slug);
END;

CREATE TRIGGER IF NOT EXISTS projects_ad AFTER DELETE ON projects BEGIN
  INSERT INTO projects_fts(projects_fts, rowid, title, summary, slug)
  VALUES ('delete', old.id, old.title, old.summary, old.slug);
END;

CREATE TRIGGER IF NOT EXISTS projects_au AFTER UPDATE ON projects BEGIN
  INSERT INTO projects_fts(projects_fts, rowid, title, summary, slug)
  VALUES ('delete', old.id, old.title, old.summary, old.slug);
  INSERT INTO projects_fts(rowid, title, summary, slug)
  VALUES (new.id, new.title, new.summary, new.slug);
END;
`;

/** 预置来源 */
export const SEED_SOURCES = [
  { key: 'modrinth', display_name: 'Modrinth', base_url: 'https://modrinth.com' },
  { key: 'curseforge', display_name: 'CurseForge', base_url: 'https://www.curseforge.com' },
];
