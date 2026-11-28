# MC Scroll

像刷短视频一样刷 Minecraft 的全部资源：模组、整合包、数据包、资源包、光影、服务端插件、服务器。

- **桌面端（≥900px）**：三栏布局 —— 左侧导航 / 中间内容流 / 右侧详情
- **手机端（<900px）**：单栏全屏刷流，上下滑换内容、左右滑看截图
- **中英双语**：侧栏底部切换，即时生效；首次访问按浏览器语言自动选择
- **键盘操作**：方向键 / 小键盘翻页换图，键位可自定义
- **零成本可部署**：同一份代码能跑 Node 后端，也能导出纯静态站点

线上演示：<https://rikkatakanashi520.github.io/mc-scroll/>

## 数据规模

| 频道 | 项目数 | 有可用截图 |
|---|---:|---:|
| Mod | 108,439 | 41,115 |
| Resource Pack | 38,485 | 18,624 |
| Plugin | 20,044 | 3,475 |
| Modpack | 19,312 | 7,157 |
| Datapack | 15,862 | 6,205 |
| Server | 2,543 | 33 |
| Shader | 1,193 | 944 |
| **合计** | **169,451** | **67,512** |

截图 292,803 张 · 分类 145 个 · 加载器 29 个 · 游戏版本 925 个，全部表驱动，与 Modrinth 官方 taxonomy 一致。

## 快速开始

```bash
node server/index.mjs
# 打开 http://127.0.0.1:4173/
```

数据库（654MB）不随仓库提供，按下面流程在本机重建（约 1.5 小时）：

```bash
node scripts/crawl.mjs --taxonomy           # 同步分类体系（几秒）
node scripts/crawl.mjs --all --resume       # 全量抓取（约 40 分钟）
node scripts/enrich.mjs --min-downloads 500 # 补截图详情
node scripts/build-feed-index.mjs           # 重建随机采样索引（必跑）
node scripts/warm-images.mjs --limit 5000   # 预热图片缓存
```

抓取或补详情后**必须重跑** `build-feed-index.mjs`，否则随机流用的还是旧编号。

## 架构

```
public/                前端（纯静态）
  index.html
  css/app.css
  js/app.js            视图逻辑 + 无限流
  js/i18n.js           中英文案字典
  js/datasource.js     静态模式数据源（分片加载 / 采样 / 搜索）
server/
  schema.mjs           数据库 schema
  db.mjs               连接与工具函数
  index.mjs            HTTP API + 静态服务 + 图片代理
  imgproxy.mjs         图片下载 / 缩放 / 缓存
scripts/
  crawl.mjs            全量抓取（断点续传）
  enrich.mjs           补截图详情
  build-feed-index.mjs 构建随机采样索引
  warm-images.mjs      预热缩略图缓存
  translate-summaries.mjs 简介翻译 + 术语纠正
  build-static.mjs     导出纯静态站点
  serve-static.mjs     本地预览静态站点
  publish-pages.mjs    构建并发布到 gh-pages
  test-v2.mjs          浏览器回归测试
data/
  mc.db                SQLite 数据库（不进仓库）
  imgcache/            缩略图缓存（不进仓库）
```

### 数据库设计

三层分离，加新来源不改表结构：

1. **`projects`** — 与来源无关的通用字段
2. **`project_sources`** — 一个项目可同时来自 Modrinth 和 CurseForge，接入新来源只需插一行
3. **`taxonomy_*`** — 分类 / 加载器 / 版本全部表驱动

关键字段：

- **`channels`**（逗号分隔）：一半项目既是 mod 又是 datapack，单值 `project_type` 表达不了
- **`enriched`**：0=未补详情 / 2=处理中 / 1=完成，用来做并发占位

## 关键实现决策

### 1. 随机采样：按行号，不按 id

三种朴素做法都试过，全部失败：

| 做法 | 问题 |
|---|---|
| 随机 id 起点 + 连续取 8 行 | 相邻 id 同批入库、属性接近，等于只抽 1 个 |
| 随机 id 起点 + 取 1 行 | id 分布不均（段 0 有 13739 个，段 3 只有 185 个），>10M 下载的项目被抽到 23.8%（真实 0.4%） |
| `ORDER BY id LIMIT 1 OFFSET <随机数>` | 分布正确，但 offset=50000 单次 74ms，一页 25 条要 1800ms |

现在的做法是预建 `feed_index` 表，把所有项目连续编号成 `0..N-1`，随机取一行就是 seq 主键等值查找——**0.002ms**，且每个项目概率严格相等。

两张索引表按需选用：

- `feed_index` — 全量 169,451 行
- `feed_index_img` — 只含有可用截图的 67,512 行

`has_img` 的判定是「有 **cdn.modrinth.com** 的图」，不是简单的 `gallery_count > 0`。有 4,687 个项目的图片全部托管在 bisecthosting / imgur 等外链，而那些图实测 8~10 秒超时会被丢弃——只看 `gallery_count` 会刷出空白卡。

### 2. 图片：两级加载

刷流卡片必须「先能看、再好看」。

| 方案 | 首屏出图 | 失败率 |
|---|---:|---:|
| 代理取原图（1~4MB） | 15 秒 | 69% |
| CDN 缩略图直连（60KB） | **423ms** | 0% |

这台机器到 Modrinth CDN 的吞吐很差（216KB 要 3 秒，和文件大小几乎无关），所以代理取原图走不通。

最终方案：

1. 后端同时返回 `thumb`（CDN 直连）和 `full`（本地代理，1280px）
2. 前端首屏用 `thumb`，423ms 出图
3. 卡片停留 700ms 后，用 `new Image()` 后台预载 `full`
4. **加载成功才替换；失败保留缩略图，绝不空白**

另外：GIF 动图 4.5MB 会拖垮首屏，大 GIF 只取第一帧压成静态 WebP（4.5MB → 18KB）。

### 3. 截图懒加载：观察卡片，不观察图片

`.card-media` 是 `overflow-x: auto` 的横向容器，同一张卡片里第 2 张及以后的图被**祖先裁切**在视口外。IntersectionObserver 会算上祖先 overflow 裁剪，因此这些图永远 `isIntersecting=false`，`src` 一直是空的——表现就是「按 → 切图，切过去白屏」。

加 `rootMargin` 无效，不是距离问题。正确做法是**观察卡片本身**，卡片进入视野就一次性给它的所有图赋 `src`。

同时图片上不能用 `loading="lazy"`：原生 lazy 同样认为「横向屏外 = 不可见」，会一直不发起请求。

### 4. 截图数量上限

`feed` 每张卡只带前 24 张（覆盖 P99，实测最多 65 张），剩余的由 `/api/images/:slug` 按需补齐。一次全塞会让 20 张卡的响应体翻几倍。

补图时容易踩的坑：`appendImagesToMedia(media, card, from)` 的 `from` 传 `null` 会走「从头重建」分支，把已渲染的图再追加一遍。实测 56 张的卡片变成 80 个 img（只有 56 个唯一 src）。

测试断言：`img 数量 === 唯一 src 数量 === 角标数字`。

### 5. 滚动处理不能依赖 rAF / 定时器

页面不可见时（后台标签页、无头浏览器）浏览器会把 `requestAnimationFrame` **和** `setTimeout` 一起节流到每秒 1 次甚至完全不跑。

原来的写法 `if (raf) return; raf = requestAnimationFrame(...)`，一旦 rAF 不触发，`raf` 永远非空，**之后所有 scroll 事件全被挡掉**——换完频道后所有翻页失灵。

现在改成同步处理：scroll 事件本身已由浏览器节流，再叠一个 20ms 时间戳去重即可，完全不依赖调度器。

### 6. datapack / plugin 不是 project_type

Modrinth 上它们挂在 mod 项目上，用 `project_type:datapack` 查询返回的却是 `project_type: mod` 的项目。

正确处理：datapack 用 `categories:datapack`，plugin 用服务端 loader（paper / spigot / bukkit 等），结果存进 `channels` 集合。所以 mod 项目数会超过官方 `project_type: mod` 的总数——同一个项目被两个频道共享。

### 7. 卡片绝对定位 + spacer

`top = idx * 100dvh`，滚动高度由 `.feed-spacer` 撑起，只保留当前卡 ±2 的 DOM。

**不能用 `scrollTop / 高度` 当队列下标**——那只是窗口内的相对序号，会卡死。

换筛选时临时关掉 `scroll-snap`，否则 `scrollTo(0)` 会被吸回旧位置，导致渲染窗口按旧位置算、卡片全被回收（白屏）。

## API

```
GET /api/health                      项目 / 截图 / 分类总数
GET /api/taxonomy                    分类 / 加载器 / 版本
GET /api/feed?types=&categories=&loaders=&versions=&q=&limit=&cursor=&requireImages=
GET /api/project/:slug               单项目详情（含全部截图）
GET /api/images/:slug?from=&limit=   补截图分页
GET /api/search?q=&limit=            FTS5 全文搜索
GET /api/img?w=&u=                   图片代理（缩放 + 磁盘缓存）
GET /api/favorites?device=           收藏同步
```

## 测试

```bash
node scripts/test-v2.mjs
```

39 项真实浏览器回归：渲染、图片、筛选、搜索、收藏、键盘、折叠、自定义键位。

## 部署到 GitHub Pages / Cloudflare Pages

本地版需要 Node 服务（SQLite + 图片代理），但 Pages 只能托管静态文件，所以另有一条纯静态导出路径。

### 为什么能零成本

1. **图片可以热链**：Modrinth CDN 返回 `Cache-Control: max-age=2678400`（31 天）、`Access-Control-Allow-Origin: *`。图片流量走它，不占自己的额度。
2. **brotli 比 gzip 省 34%**：主表 gzip 4.77MB → brotli 3.16MB。
3. **分片懒加载**：首片 600 条，加 manifest + taxonomy 约 450KB 就能开刷。

| 平台 | 免费额度 | 本项目用量 |
|---|---|---|
| Cloudflare Pages | 20,000 文件 / 单文件 25MB / 无限带宽 | 225 文件 / 243MB |
| GitHub Pages | 1GB 站点 / 100GB 月流量 | 同上（24%） |

### 构建与发布

```bash
node scripts/publish-pages.mjs      # 构建 + 推 gh-pages + 触发部署
node scripts/serve-static.mjs       # 本地预览
```

CI 只负责把 `gh-pages` 的内容发布成站点，**不在 CI 里抓数据**——全量抓取要 40 分钟，会吃光 Actions 免费额度。

### 两种模式的差别

| | 本地（Node） | 静态（Pages） |
|---|---|---|
| 数据 | SQLite，实时 | JSON 分片，构建时快照 |
| 搜索 | FTS5 全文索引 | 前端内存匹配（30~60ms） |
| 图片 | 代理缩放，最高 1280px | CDN 直连，350~1024px |
| 收藏 | 本地 + 服务端同步 | 仅 localStorage |
| 随机流 | feed_index 等概率 | 内存加权采样 |

静态版的已知限制：没有高清图、数据是快照、搜索需等分片加载完。

## 数据来源与合规

只读取 Modrinth 的公开 API，不下载、不镜像、不分发任何模组文件。

- 所有内容版权归原作者，界面里每个项目的「前往 Modrinth」都会跳到原页面
- 抓取的是元数据（标题、简介、分类、下载量）和截图的 CDN 链接
- 图片通过 `/api/img` 代理只为缩放和缓存，不落盘原图
- 若你是作者且不希望项目出现在这里，提 issue 即可移除
- 与 Modrinth / CurseForge 无隶属关系

## 环境变量

| 变量 | 用途 | 必需 |
|---|---|---|
| `MC_SCROLL_PYTHON` | 指向带 Pillow 的 Python | 否（不设则退回原图，慢但能用） |
| `MC_TRANSLATE_KEY` | 翻译服务 client_key | 仅跑翻译脚本时需要 |
| `PORT` / `HOST` | 监听端口与地址 | 否（默认 4173 / 127.0.0.1） |

## 许可

代码以 MIT 发布（见 `LICENSE`）。抓取到的项目数据与截图版权归各自作者所有。
